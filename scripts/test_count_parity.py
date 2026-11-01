"""Boundary fixtures for the parity counter; no product-runtime claims."""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("count-parity.py")


class ParityCounterTests(unittest.TestCase):
    def count(self, text):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "parity.md"
            path.write_text(text, encoding="utf-8")
            return subprocess.run([sys.executable, str(SCRIPT), str(path), "--json"],
                                  capture_output=True, text=True, check=False)

    def test_counts_mixed_and_unresolved_without_fixed_surface_columns(self):
        result = self.count("\n".join([
            "- [x] A1 Local | reference | w d | S | web done",
            "- [x] A2 Service only | extra column | reference | s w | M | server done",
            "- [ ] A3 Some local behavior | reference | w d | M | status: partial | remaining: native run",
            "- [ ] R4 Mixed RPC | L | scope: mixed | local: install | excludes: login",
            "- [x] R5 Historical tick | L | scope: excluded | reason: login",
            "- [x] R6 Needs scope | M | scope: unresolved | reason: missing T3 reference",
            "- [ ] Q1 Phone | reference | m | S | scope: excluded | reason: mobile",
        ]))
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual({key: data[key] for key in
                          ("total", "source_checked", "in_scope", "declared_checked",
                           "partial", "open", "excluded", "unresolved")},
                         dict(total=7, source_checked=4, in_scope=4, declared_checked=1,
                              partial=2, open=1, excluded=2, unresolved=1))
        self.assertEqual(data["rows"]["open"], ["R4"])
        self.assertEqual(data["rows"]["unresolved"], ["R6"])
        self.assertEqual(data["excluded_checked"], 1)
        self.assertEqual(data["unresolved_checked"], 1)
        self.assertIn("no fresh runtime", data["note"])

    def test_duplicate_ids_refuse_the_report(self):
        result = self.count("- [ ] A1 One | s | S\n- [x] A1 Other | s | M")
        self.assertEqual(result.returncode, 2)
        self.assertIn("duplicate row ID A1", result.stderr)
        self.assertEqual(result.stdout, "")

    def test_unknown_or_duplicate_metadata_refuses_the_report(self):
        for fields in ("scope: exluded", "scope: local | scope: mixed", "status: complete"):
            with self.subTest(fields=fields):
                result = self.count("- [ ] A1 Feature | s | S | " + fields)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, "")

    def test_scope_decisions_need_their_explanation(self):
        for fields in ("scope: mixed | local: install", "scope: excluded",
                       "scope: unresolved", "status: partial"):
            with self.subTest(fields=fields):
                result = self.count("- [ ] A1 Feature | s | S | " + fields)
                self.assertEqual(result.returncode, 2)
                self.assertIn("needs", result.stderr)

    def test_mobile_only_cannot_silently_default_to_local(self):
        result = self.count("- [ ] A1 Feature | reference | m | S")
        self.assertEqual(result.returncode, 2)
        self.assertIn("mobile-only", result.stderr)

    def test_empty_and_malformed_input_refuse_the_report(self):
        for text in ("# Empty", "- [z] A1 Feature | s | S", "- [ ] A0 Feature | s | S",
                     "- [ ] A1x Feature | s | S"):
            with self.subTest(text=text):
                result = self.count(text)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, "")

    def test_unexpected_section_refuses_the_report(self):
        result = self.count("- [ ] S1 Unexpected section | s | S")
        self.assertEqual(result.returncode, 2)
        self.assertIn("malformed parity checkbox or ID", result.stderr)
        self.assertEqual(result.stdout, "")

    def test_section_and_reference_warnings_require_explicit_decisions(self):
        for row in ("- [ ] L1 Remote | s | S", "- [ ] Q1 Phone | S",
                    "- [ ] I1 Login | s | S | [auth-risk]",
                    "- [ ] I2 Hosted | s | S | [hosted]",
                    "- [ ] A1 Extra surface | w d | M | beyond T3"):
            with self.subTest(row=row):
                result = self.count(row)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, "")
        result = self.count("- [ ] L27 Checks | s | L | scope: mixed | local: loopback | excludes: remote scopes")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["open"], 1)

    def test_escaped_pipes_are_not_surface_columns(self):
        result = self.count(r"- [x] A1 Feature \| m | reference | s w | M | server done")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["partial"], 1)

    def test_checkbox_case_and_web_done_with_detail(self):
        result = self.count("- [X] A1 Feature | s w | M | server done | web done: observed")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["declared_checked"], 1)

    def test_not_doable_stays_in_scope_without_counting_as_checked(self):
        result = self.count("- [ ] A1 Migration | s | M | status: not_doable | reason: no predecessor exists")
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual(data["in_scope"], 1)
        self.assertEqual(data["not_doable"], 1)
        self.assertEqual(data["declared_checked"], 0)
        self.assertEqual(data["excluded"], 0)
        self.assertEqual(data["source_checked"], 0)
        result = self.count("- [ ] A1 Migration | s | M | status: not_doable")
        self.assertEqual(result.returncode, 2)
        self.assertIn("needs reason", result.stderr)


if __name__ == "__main__":
    unittest.main()
