#!/usr/bin/env python3
"""Count declared parity state. This does not verify application behavior."""

import argparse
from collections import Counter
from dataclasses import dataclass
import json
from pathlib import Path
import re
import sys


ROW = re.compile(r"^- \[([ xX])\] ([A-R][1-9][0-9]*)(?=\s|$)")
CANDIDATE = re.compile(r"^- \[[^]]*\] [A-Z][0-9]")
SURFACES = re.compile(r"[wdmsc](?:\s+[wdmsc])*")
METADATA = {"scope", "local", "excludes", "reason", "status", "remaining"}
SCOPES = {"local", "mixed", "excluded", "unresolved"}


@dataclass(frozen=True)
class Row:
    id: str
    checked: bool
    state: str


def parse_rows(text: str) -> list[Row]:
    rows = []
    seen = set()
    for number, line in enumerate(text.splitlines(), 1):
        match = ROW.match(line)
        if not match:
            if CANDIDATE.match(line):
                raise ValueError(f"line {number}: malformed parity checkbox or ID")
            continue
        checked, row_id = match.groups()
        if row_id in seen:
            raise ValueError(f"line {number}: duplicate row ID {row_id}")
        seen.add(row_id)
        fields = [field.strip() for field in re.split(r"(?<!\\)\|", line)[1:]]
        surfaces = next(
            (set(field.split()) for field in fields if SURFACES.fullmatch(field)),
            set(),
        )
        metadata = {}
        for field in fields:
            key, separator, value = field.partition(":")
            key = key.strip()
            if not separator or key not in METADATA:
                continue
            if key in metadata:
                raise ValueError(f"line {number}: duplicate {key} field on {row_id}")
            metadata[key] = value.strip()
        scope = metadata.get("scope", "local")
        if scope not in SCOPES:
            raise ValueError(f"line {number}: unknown scope {scope!r} on {row_id}")
        status = metadata.get("status")
        if status not in (None, "partial", "not_doable"):
            raise ValueError(f"line {number}: unknown status {status!r} on {row_id}")
        required = {
            "mixed": ("local", "excludes"),
            "excluded": ("reason",),
            "unresolved": ("reason",),
        }.get(scope, ())
        for key in required:
            if not metadata.get(key):
                raise ValueError(f"line {number}: {scope} row {row_id} needs {key}")
        if status == "partial" and not metadata.get("remaining"):
            raise ValueError(f"line {number}: partial row {row_id} needs remaining")
        if status == "not_doable" and not metadata.get("reason"):
            raise ValueError(f"line {number}: not-doable row {row_id} needs reason")
        if surfaces == {"m"} and scope not in ("excluded", "unresolved"):
            raise ValueError(f"line {number}: mobile-only row {row_id} needs excluded scope")
        section_excluded = row_id.startswith("Q") or (
            row_id.startswith("L") and row_id != "L27"
        )
        if section_excluded and scope not in ("excluded", "unresolved"):
            raise ValueError(f"line {number}: section-excluded row {row_id} needs scope")
        if any(tag in line for tag in ("[auth-risk]", "[hosted]")) and "scope" not in metadata:
            raise ValueError(f"line {number}: reference warning on {row_id} needs explicit scope")
        if "beyond T3" in line and surfaces & {"w", "d"} and "scope" not in metadata:
            raise ValueError(f"line {number}: beyond-T3 surface on {row_id} needs explicit scope")
        is_checked = checked.lower() == "x"
        service_only_client = (
            is_checked
            and bool(surfaces & {"w", "d"})
            and any(field.startswith("server done") for field in fields)
            and not any(field.startswith("web done") for field in fields)
        )
        if scope in ("excluded", "unresolved"):
            state = scope
        elif status == "not_doable":
            state = "not_doable"
        elif status == "partial" or service_only_client:
            state = "partial"
        else:
            state = "declared_checked" if is_checked else "open"
        rows.append(Row(row_id, is_checked, state))
    if not rows:
        raise ValueError("no parity rows found")
    return rows


def report(rows: list[Row]) -> dict:
    included_states = ("declared_checked", "partial", "open", "not_doable")
    states = (*included_states, "excluded", "unresolved")
    counts = Counter(row.state for row in rows)
    return {
        "total": len(rows),
        "source_checked": sum(row.checked for row in rows),
        "in_scope": sum(counts[state] for state in included_states),
        **{state: counts[state] for state in states},
        "unresolved_checked": sum(row.checked for row in rows if row.state == "unresolved"),
        "excluded_checked": sum(row.checked for row in rows if row.state == "excluded"),
        "rows": {state: [row.id for row in rows if row.state == state] for state in states},
        "note": "Checklist declarations only; no fresh runtime or platform verification.",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", nargs="?", type=Path,
                        default=Path(__file__).resolve().parents[1] / "docs/parity.md")
    parser.add_argument("--json", action="store_true", help="include row IDs as JSON")
    args = parser.parse_args()
    try:
        data = report(parse_rows(args.path.read_text(encoding="utf-8")))
    except (OSError, UnicodeError, ValueError) as error:
        print(f"count-parity: {error}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(data, indent=2))
    else:
        print(f"Rows: {data['total']}; source checkboxes ticked: {data['source_checked']}")
        print(f"Included: {data['in_scope']}; declared checked: {data['declared_checked']}; "
              f"partial: {data['partial']}; open: {data['open']}; "
              f"not doable: {data['not_doable']}")
        print(f"Excluded: {data['excluded']}; unresolved scope: {data['unresolved']}")
        if data["unresolved"]:
            print("Unresolved IDs: " + ", ".join(data["rows"]["unresolved"]))
        print(data["note"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
