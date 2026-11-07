# Desktop and local web batch reconciliation

Issue-state snapshot: 7 November 2026. Product and row snapshot: `3d0f41d`.
[Umbrella #187](https://github.com/kinqsradio/orbyn-engineering/issues/187)
remains open. All 26 batch issues below are closed; their closeouts explain the
work delivered, refused or left unqualified. The umbrella's 5 November assignment
comment is historical and must not be used to claim a batch.

## Closed batch index

| Batch | Closed issues | Surface |
| --- | --- | --- |
| A | [#161](https://github.com/kinqsradio/orbyn-engineering/issues/161) | Thread organization and V1 migration |
| B | [#162](https://github.com/kinqsradio/orbyn-engineering/issues/162) | Composer chips, attachments and turn checks |
| C | [#163](https://github.com/kinqsradio/orbyn-engineering/issues/163) | Inline MCP App UI |
| D | [#164](https://github.com/kinqsradio/orbyn-engineering/issues/164) | File comments and outside-workspace reads |
| E | [#165](https://github.com/kinqsradio/orbyn-engineering/issues/165) | Diff comments and large diffs |
| F | [#166](https://github.com/kinqsradio/orbyn-engineering/issues/166), [#167](https://github.com/kinqsradio/orbyn-engineering/issues/167), [#168](https://github.com/kinqsradio/orbyn-engineering/issues/168) | Diff-based text, worktree setup and review routing |
| G | [#169](https://github.com/kinqsradio/orbyn-engineering/issues/169) | Terminal composer context |
| H | [#170](https://github.com/kinqsradio/orbyn-engineering/issues/170), [#171](https://github.com/kinqsradio/orbyn-engineering/issues/171), [#172](https://github.com/kinqsradio/orbyn-engineering/issues/172) | Preview cursor, recording, imports, clipboard and menus |
| I | [#173](https://github.com/kinqsradio/orbyn-engineering/issues/173), [#174](https://github.com/kinqsradio/orbyn-engineering/issues/174), [#175](https://github.com/kinqsradio/orbyn-engineering/issues/175), [#176](https://github.com/kinqsradio/orbyn-engineering/issues/176), [#177](https://github.com/kinqsradio/orbyn-engineering/issues/177) | Config homes, drivers, ACP, environments and version gates |
| J | [#178](https://github.com/kinqsradio/orbyn-engineering/issues/178) | Costs, filters and provider limits |
| K | [#179](https://github.com/kinqsradio/orbyn-engineering/issues/179), [#180](https://github.com/kinqsradio/orbyn-engineering/issues/180) | Scoped settings, project page, themes and welcome |
| M | [#181](https://github.com/kinqsradio/orbyn-engineering/issues/181) | Workflows and secret-request disposition |
| N | [#182](https://github.com/kinqsradio/orbyn-engineering/issues/182) | Guide and environment-link tools |
| O | [#183](https://github.com/kinqsradio/orbyn-engineering/issues/183) | Lifecycle and maintenance |
| P | [#184](https://github.com/kinqsradio/orbyn-engineering/issues/184) | Updates and native menus |
| R | [#185](https://github.com/kinqsradio/orbyn-engineering/issues/185) | RPC reconciliation |
| CI | [#186](https://github.com/kinqsradio/orbyn-engineering/issues/186) | Packaged macOS and Windows qualification |

## Remaining work and evidence

[Parity rows](parity.md) retain the exact `remaining:`, scope and refusal notes.
`python scripts/count-parity.py` reports 709 rows, 467 source checkboxes ticked,
and 534 included rows: 396 declared checked, 101 partial, 33 open and 4 not doable.
There are 175 excluded and zero unresolved-scope rows. Issue closure changes none
of those declarations and supplies no new runtime evidence.

- **Native/manual qualification:** #186 records packaged macOS and Windows
  build/install/start coverage through #200/#210 and observations in #236. It
  does not qualify a full native turn, window/preview interaction or every menu.
  Preserve the row-specific macOS, Windows, live-provider and release-input limits.
  [#140](https://github.com/kinqsradio/orbyn-engineering/issues/140) is closed;
  I9/I40/I41 still carry provider and packaged-app evidence limits.
- **Timeline and tools:** [#128](https://github.com/kinqsradio/orbyn-engineering/issues/128)
  is closed; C4/C10/C31/C37/C40 remain partial. [#127](https://github.com/kinqsradio/orbyn-engineering/issues/127)
  is closed with N21's `request_secret` refusal recorded through #262, not an
  implemented secret broker. Existing permission/tool stops remain stops.
- **Behavior still missing:** open/partial rows include B8 and B41–B43, F3,
  local desktop devices H20–H27/H31 and their N11 tools, H33/H34, remaining I
  drivers/adapters, K49, L27 local access checks and P6/P23/P24. Read each row
  before scoping a successor issue; this is not an exhaustive replacement queue.
- **RPC equivalence:** #185 closed the source reconciliation. R1–R14 remain
  partial for their explicit method-level gaps. Nearby HTTP/SSE/WebSocket routes
  and cited tests do not prove every reference method works.
- **Refused or not doable:** retain A54/P20's missing predecessor, I24's managed
  runtime restriction and H35's streamed-page DevTools limit. B40 does not permit
  shell-profile installation; B47 does not pass question attachments to engines.
  Keep N21's owner decision and all other named exclusions in force.

Mobile (Q), remote access/pairing (L except L27), hosted features and credential
handling remain outside scope. Local desktop device/toolchain gaps are included.
Neither a closed batch nor this document changes those boundaries.

## Pickup and umbrella disposition

Keep #187 as the reconciliation index while the remaining behavior, qualification
and owner decisions are unresolved. Do not restart archived batch sessions or
reopen their implementation from the issue title alone. Scope any successor from
the current row and its batch closeout, with actionable acceptance criteria under
[CONTRIBUTING](../CONTRIBUTING.md#leaving-work-behind).

At this snapshot, [#272](https://github.com/kinqsradio/orbyn-engineering/issues/272)
(pane resizing), [#276](https://github.com/kinqsradio/orbyn-engineering/issues/276)
(Core ownership), [#277](https://github.com/kinqsradio/orbyn-engineering/issues/277)
(web boundaries) and [#280](https://github.com/kinqsradio/orbyn-engineering/issues/280)
(settings test readiness) are open and have separate active task owners. Their
source work does not belong to this umbrella reconciliation. Check live issue
states and newer main before claiming any work.
