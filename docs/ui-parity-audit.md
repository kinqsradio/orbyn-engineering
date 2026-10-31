# UI parity audit

Reference: a running T3 Code, observed at 1440x900 and 1728x1048 at DPR 2, with its
source at `cadf7d5fe3` and two saved captures. "Live" means measured in the running
app, including two test turns in one dedicated thread on GPT-6-Luna at Low in
Supervised mode. "Source" means read from code only. "Unobserved" means neither.
The candidate is `web/`. "Real" means run through `orbynd` with synthetic data and a
fake ACP engine; everything else ran on the mock. No reference data is recorded here.

| Surface | State | Reference observed | Our status | Measured deviation |
| --- | --- | --- | --- | --- |
| Sidebar | Width | Live: 208px | Match, resizable 180-420 | 0 |
| Sidebar | Search row | Live: y 62-90, 28px icons | Match | 0 |
| Sidebar | Settled row | Live: one line, 36px, pitch 37 | Match | 0 by CSS |
| Sidebar | Settled shelf | Live: 32px toggle, 10 rows, Show n more | Match | 0 |
| Sidebar | Footer | Live: 32px at x 8, 44, 80; update x 167 | Settings, update only | x 166; Pull requests and Usage hidden |
| Sidebar | Working status | Live: spinner, blue "Working Ns" | Match | Spin 1000 ms |
| Sidebar | Approval status | Live: warn "Approval" | Match, Real | Dot, not their icon |
| Sidebar | Multi-line rows | Live: selected row, three lines | Built | Unread title weight unobserved |
| Hover card | Older thread | Live: 165 ms to show, x +4, width 320, radius 6, 150 ms | Match | Delay 150 ms set |
| Draft | Heading | Live: 30px, -0.75px, line 36 | Match, own wording removed | Same wording as reference |
| Draft | Composer | Capture: x 80-816, y 469-580 | x 80.5-816.5, y 468-580 | 0.5 x, 1 y, re-measured |
| Draft | Divider, pane | Capture: x 1189, 539 wide | x 1189, 539 wide | 0, re-measured |
| Draft | Details card | Capture: 280, y 64-295 | 280, y 64-225 | Editor, script, commit rows hidden |
| Draft | Launcher | Live: 7 surfaces | Terminal, Diff, Activity | Others hidden, no backend |
| Draft | No project state | Live: What should we work on?, No project picker below it, permissions alone under the composer | Match, Real | Scratch thread sent through the real service |
| Draft | Project selected | Live: What should we build in, project as picker, or start without a project, checkout and branch left, permissions right | Match, Real | Heading to composer 49 |
| Draft | Project picker | Live: 288 wide, centred under the name, Search projects..., projects, Add project | Match, Real | Text and files survive a switch and the trust step |
| Draft | After first send | Live: strip gone, permission chip joins the composer footer, header shows project and title | Match, mock and Real | Details card has fewer rows, see below |
| Add project | Palette sources | Live: Sources: New project, Local folder, Git URL, then hosts; path field with Add, Directories, Backspace Back | Match, Real for Local folder | Host sources hidden, no backend; no clone destination step |
| Landing | No projects | Source: What should we work on?, Add project, Start without a project | Match, Real | 0 |
| Hero | First send | Live: at 0 ms snaps y 394 to 768 with no animation | Match at default | With a duration, FLIP asserted |
| Timeline | Live header | Live: "Working for Ns" with rule | Match | 0 |
| Timeline | Thinking row | Live: band 2200 ms stepped | Match | Sweep and band asserted |
| Timeline | Tool shimmer | Live: 2200 ms, spin 1000 ms | Match | 0 |
| Timeline | Finished fold | Live: hidden when no tools ran | Kept as "Worked for" | Keeps reasoning reachable |
| Timeline | Markdown | Live: 14/22.75, p margin 10.4, h2 18/600 | Match | 0 |
| Timeline | Inline code | Live: 11.9px, radius 4 | Match | 0 by ratio |
| Timeline | Table | Live: full width, th 600, td padding 7.2 | Match | Numeric right-align not built |
| Timeline | Code block | Live: card radius 8, header 30, pre 13/17.875, language icon | Header, Shiki tokens, wrap, copy | Language text, no icon |
| Timeline | User bubble | Live: radius 16, padding 12 | Match | 0 |
| Composer | Stop | Live: red round button | Match, Real | 0 |
| Composer | Model picker | Live at 1051x534: 362 wide, border 1, radius 8, blur 16 saturate 1.08, 150 ms scale and opacity; rail 44 with 36px tabs, 3x20 indicator, star tab and divider; search 291x33 with primary underline; rows 291x32, pitch 34, radius 4; selected 6% fill and a check; star on hover, filled when favourite | Match, Real: real model lists, favourites, search, number jumps, provider keys | Row width 292, +1; rail glyphs are neutral letters; no Legacy models group, no such flag in the API |
| Composer | Picker placement | Live: flips at short heights, y 6 at 534 tall | Below, above, then beside the trigger | Same window: x 449 vs 471, y 232 vs 6, reference rule at this size not reproduced |
| Composer | Closed trigger | Live: 28 tall, glyph 16, short name, 14px | Match, Real | Letter glyph instead of the vendor mark |
| Composer | Effort menu | Live: 304 wide, rows 28, section label 12, Default badge, then Permissions | Match, Real | Service Tier absent, no backend; Claude reports no default, so it reads Effort |
| Composer | Effort display | Source: word or bars | Match, Real setting in Appearance | 0 |
| Composer | Permission modes | Live: four icon segments 65.5x24 in the effort menu, with one description line; the control under the composer opens the same menu at Permissions | Match, Real, all four saved by the server | Default stays Supervised |
| Composer | Approval placeholder | Live | Match | Declines, then queues |
| Composer | Mentions, commands | Source | Built | Real returned none in an empty repo |
| Composer | Queue and steer | Source | Built; queue and remove Real | Steer mock only |
| Approval | Inline row | Live: target, Waiting for approval, Decline, Approve, More | Match, Real | Always allow persists, so no "this session" |
| Approval | Question panel | Source | Absent | No backend event |
| Command palette | Open | Live: y 90, 576x420, radius 16, blur 16, items 32 radius 4 | Match | Fewer actions |
| Dialogs | Backdrop | Live: 64% black, blur 4, 200 ms | Match | 0 |
| Menus | Popover | Live: radius 8, 150 ms scale and opacity | 100 ms | 50 ms |
| Layout | Per-thread restore | Live and source: open state, active surface, surfaces and maximize per thread in one saved store, width per thread in its own key, terminal per thread in another, thread details per thread; all survive reload | Match, Real: three threads and a reload | One saved record per thread, capped at 200 |
| Layout | Draft to thread | Source: a draft's id becomes the thread's, so its layout carries | Match, Real | Next draft starts fresh |
| Layout | Pane width | Live: 360 default, resized per thread | Match, Real; double-click resets | Default follows the window, as measured before |
| Layout | Narrow | Source: right panel becomes a sheet at 980 and under | Replaces the thread with Back to thread | Own shape below the wide breakpoint |
| Layout | Motion | Live: panel duration setting, 0 by default | Match | Restoring a thread does not animate at 0 |
| Pull requests | List page | Live: search, Sort, Filters, All, refresh, empty state wording | Match, Real empty state; rows on the mock | No forge on the test service, so rows, merge and review are not exercised for real |
| Pull requests | Detail | Source: Summary, Timeline, Code | Built on the real routes | Not run against a forge; Guide, stacks and reactions absent |
| Open in editor | Details row | Source: Open in preferred, menu of detected editors | Built, list Real | Launch not run, to avoid opening the host's editor from tests |
| Terminal drawer | Open | Unobserved | Built | Unknown |
| Settings | Shell | Live: overlay inset 80/40, nav 239, rows 12/16, group radius 12 | Match, Real | 0 by CSS |
| Settings | Sections | Live: 17 sections | 7 backed, Real | Others hidden |
| Settings | Appearance, Keybindings | Live names | Backed | Keybindings read-only |
| Settings | Providers | Live name | Engines moved here, Real | Layout own |
| Settings | Threads | Live name | Auto-settle, titles, Real load | Layout from rows |
| Settings | Projects | Live name | Library and projects, Real | Layout own |
| Settings | Maintenance | Live name | Update checks, Real | Contents unobserved |
| First run | Setup, create, trust, draft send | n/a, required by Orbyn | Passed, Real | Synthetic data |
| Removed | Audit section | Not in reference | Removed with its mock data | n/a |
| Removed | Policy section | Not in reference | Removed with its mock data | n/a |
| Removed | Computer section | Not in reference | Removed with its mock data | n/a |
| Removed | Skills section | Not in reference | Removed; `$` menu remains | n/a |
| Removed | Updates section | Not in reference | Removed; pill, dialog and Maintenance | n/a |
| Removed | Workspace section | Not in reference | Folded into Projects | n/a |
| Removed | Workspace home | Not in reference | Replaced by the draft | n/a |
| Removed | Approvals page, link and count | Not in reference | Replaced by thread status | n/a |
| Removed | New thread form | Not in reference | Replaced by draft pickers | n/a |
