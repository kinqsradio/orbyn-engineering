# UI parity audit

Reference: T3 Code's source at `cadf7d5fe3`, plus earlier observations of a running
copy at 1440x900 and 1728x1048 at DPR 2 and two saved captures. "Live" means measured
in that running copy before 31 October 2026; it is no longer consulted. "Source" and
"source-derived" mean read from local code only, including every row added since, and
anything that could only have been checked in the running copy. "Unobserved" means
neither. The candidate is `web/`. "Real" means run through `orbynd` with synthetic data
and the repo's protocol double, or a scripted engine that feeds Codex notifications to
the real service; everything else ran on the mock. No reference data is recorded here.

E2e runs headless on Playwright's `chromium-headless-shell` from `node_modules`
(`npm run test:e2e:install`). It launches no installed browser: the service's previews
get the same shell through `ORBYN_BROWSER`, and a process watch across the full suite
saw no harness launch of an installed Chrome. The shell needs `--in-process-gpu` here.

| Surface | State | Reference observed | Our status | Measured deviation |
| --- | --- | --- | --- | --- |
| Sidebar | Width | Live: 208px | Match, resizable 180-420 | 0 |
| Sidebar | Search row | Live: y 62-90, 28px icons | Match | 0 |
| Sidebar | Settled row | Live: one line, 36px, pitch 37 | Match | 0 by CSS |
| Sidebar | Settled shelf | Live: 32px toggle, 10 rows, Show n more | Match | 0 |
| Sidebar | Footer | Live: 32px at x 8, 44, 80; update x 167 | Settings, update only | x 166; Pull requests and Usage hidden |
| Sidebar | Working status | Live: spinner, blue "Working Ns" | Match | Spin 1000 ms |
| Sidebar | Approval status | Live: warn "Approval" | Match, Real | Dot, not their icon |
| Sidebar | Limited and Question | Source: request states on the row | Limited, Question, Real | Own label for a question |
| Sidebar | Woke | Source: dismissible badge after an early wake | Match, Real | Badge text only, no icon |
| Sidebar | Draft row | Source: unsent marker, discard, undo with attachments | Match, Real | One draft at a time, not one per project |
| Timeline | Limit stop | Source: Limited, Resume, Resume at reset, Snooze until reset | Banner above the composer, Real | Layout own |
| Sidebar | Multi-line rows | Live: selected row, three lines | Built | Unread title weight unobserved |
| Hover card | Older thread | Live: 165 ms to show, x +4, width 320, radius 6, 150 ms | Match | Delay 150 ms set |
| Draft | Heading | Live: 30px, -0.75px, line 36 | Match, own wording removed | Same wording as reference |
| Draft | Composer | Capture: x 80-816, y 469-580 | x 80.5-816.5, y 468-580 | 0.5 x, 1 y, re-measured |
| Draft | Divider, pane | Capture: x 1189, 539 wide | x 1189, 539 wide | 0, re-measured |
| Draft | Details card | Capture: 280, y 64-295 | 280, y 64-225 | Editor, script, commit rows hidden |
| Draft | New worktree | Source: base branch picker | Base branch text box beside the purpose, Real | Typed, not picked |
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
| Timeline | Finished fold | Live and source: prompt, Worked for, answer; hides tools, reasoning and interim text; collapsed by default; You stopped after on a stop | Match, Real | Also folds when only reasoning ran, so it stays reachable |
| Timeline | Tool groups | Live: summary row with kind icon, expanded rows with chevron and time; source: at most two kinds, then Performed n other actions | Match, Real, same wording | Claude and ACP tool names classified by our own rules |
| Timeline | Command output | Live: highlighted command, italic No output; source: follows while near the end, 320 max | Match, Real, ANSI colour, exit code, failed mark | Earlier output not shown notice absent, no truncation signal |
| Timeline | Item inspector | Source: inside the expanded row | Inspect item, dialog of the raw record, Real | Field layout own |
| Timeline | Rich Markdown | Source: math opt-in, Mermaid, file, thread and external links, details, table copy | Match, Real | Thread links use orbyn://thread/id; images remote only, no local media route |
| Timeline | Proposed plan | Source: Plan badge, clip over 900 chars or 20 lines, menu, Save to workspace, Plan ready banner | Match, Real via a proposed_plan tag | The driver has no plan item, so Claude plan mode is not carded |
| Timeline | Minimap | Live and source: tick per prompt, 8 spacing, min(natural, 100vh - 18rem) | Match, Real | Wheel passthrough absent |
| Timeline | Error banner | Source: end-of-thread failure, dismiss for the session | Match, Real, with Retry | Inline notice stays for history |
| Timeline | Changed files | Source: per-turn tree with open diff | Flat list, Real, opens and scrolls to the file | Flat, not a tree |
| Timeline | Subagent bar | Source: model, effort, status, Runs on its own, Open parent | Match, Real on a delegated thread | Live activity not shown in the parent |
| Thread details | Limits | Source: remaining windows row | Match, Real from the protocol double | Checked once in five minutes per page load |
| Usage | Price and alias | Source: per-model rates, counts as | Dialog from the model row, Real | A failed save keeps the form; no Mixed price |
| Timeline | Announcers | Source | Background threads live region, Real | Current-thread activity uses the status row |
| Timeline | Markdown | Live: 14/22.75, p margin 10.4, h2 18/600 | Match | 0 |
| Timeline | Inline code | Live: 11.9px, radius 4 | Match | 0 by ratio |
| Timeline | Table | Live: full width, th 600, td padding 7.2 | Match | Numeric right-align not built |
| Timeline | Code block | Live: card radius 8, header 30, pre 13/17.875, language icon | Header, Shiki tokens, wrap, copy | Language text, no icon |
| Timeline | User bubble | Live: radius 16, padding 12 | Match | 0 |
| Composer | Stop | Live: red round button | Match, Real | 0 |
| Composer | Force stop | Source: Agent not responding to Stop, Force stop | Match, Real on a run that ignores interrupt | Shown 3 s after Stop, the service has no unresponsive state; lost on reload |
| Composer | Model picker | Live at 1051x534: 362 wide, border 1, radius 8, blur 16 saturate 1.08, 150 ms scale and opacity; rail 44 with 36px tabs, 3x20 indicator, star tab and divider; search 291x33 with primary underline; rows 291x32, pitch 34, radius 4; selected 6% fill and a check; star on hover, filled when favourite | Match, Real: real model lists, favourites, search, number jumps, provider keys | Row width 292, +1; rail glyphs are neutral letters; no Legacy models group, no such flag in the API |
| Composer | Picker placement | Live: flips at short heights, y 6 at 534 tall | Below, above, then beside the trigger | Same window: x 449 vs 471, y 232 vs 6, reference rule at this size not reproduced |
| Composer | Closed trigger | Live: 28 tall, glyph 16, short name, 14px | Match, Real | Letter glyph instead of the vendor mark |
| Composer | Effort menu | Live: 304 wide, rows 28, section label 12, Default badge, then Permissions | Match, Real | Service Tier absent, no backend; Claude reports no default, so it reads Effort |
| Composer | Effort display | Source: word or bars | Match, Real setting in Appearance | 0 |
| Composer | Permission modes | Live: four icon segments 65.5x24 in the effort menu, with one description line; the control under the composer opens the same menu at Permissions | Match, Real, all four saved by the server | Default stays Supervised |
| Composer | Approval placeholder | Live | Match | Declines, then queues |
| Composer | Mentions, commands | Source | Built | Real returned none in an empty repo |
| Composer | Pull requests, threads | Source: # browse and search, @ lookup, chips | Menu Real against a stand-in gh; inserts a Markdown link | Link text, no chip until the rich editor |
| Composer | Queue and steer | Source: setting picks the default, the alternate key flips it | Match, Real, steer through the protocol double | Long-press flip absent |
| Composer | Send shortcut | Source: Enter, Mod+Enter multiline, Mod+Enter | Match, Real | 0 |
| Composer | Recall, stash, large paste, drop | Source | Match, Real | Stash keeps text only, attachments are not stashed |
| Composer | Message limit | Source: 120,000, draft kept | Match, Real | Counted in the client as well as the service |
| Composer | Uploads | Source: each file on add, retry, remove, blocks send | Match, Real | Failure text inline, no progress bar |
| Composer | Queue edit | Source: back to the composer | Match, Real | An existing draft keeps its text, the prompt joins after it |
| Composer | Plan | Source | Button, /plan, /default, Real | Shift+Tab left to focus movement |
| Composer | Context meter, /usage-limits | Source | Match, Real; the meter compacts on native engines | Compaction tick absent |
| Composer | List editing | Source: Shift+Enter continues, Tab nests | Match, Real | 0 |
| Composer | Live Markdown | Source: rich editor that keeps literal markers | Styled layer under a transparent textarea, Real; markers stay and bold, headings and code keep their width | Italic is an underline and code stays in the body font, so the caret never drifts |
| Approval | Inline row | Live: target, Waiting for approval, Decline, Approve, More | Match, Real | Always allow persists, so no "this session" |
| Approval | Question panel | Source | Built, Real: answered through the protocol double | Layout own |
| Command palette | Open | Live: y 90, 576x420, radius 16, blur 16, items 32 radius 4 | Match | Fewer actions |
| Dialogs | Backdrop | Live: 64% black, blur 4, 200 ms | Match | 0 |
| Menus | Popover | Live: radius 8, 150 ms scale and opacity | 100 ms | 50 ms |
| Layout | Per-thread restore | Live and source: open state, active surface, surfaces and maximize per thread in one saved store, width per thread in its own key, terminal per thread in another, thread details per thread; all survive reload | Match, Real: three threads and a reload | One saved record per thread, capped at 200 |
| Layout | Draft to thread | Source: a draft's id becomes the thread's, so its layout carries | Match, Real | Next draft starts fresh |
| Layout | Pane width | Live: 360 default, resized per thread | Match, Real; double-click resets | Default follows the window, as measured before |
| Layout | Narrow | Source: right panel becomes a sheet at 980 and under | Replaces the thread with Back to thread | Own shape below the wide breakpoint |
| Layout | Independent scrolling | Source: each pane scrolls alone | Real at both ends, parked and during a run: details, Diff, Files, Terminal, Browser, sidebar | The cause was absolute children, such as sr-only text, escaping the transcript and giving `.main` something to scroll |
| Layout | Motion | Live: panel duration setting, 0 by default | Match | Restoring a thread does not animate at 0 |
| Pull requests | List page | Live: search, Sort, Filters, All, refresh, empty state wording | Match, Real on a stand-in gh: author, label, draft, review, checks, quick actions, bulk close | Filters are one menu, not groups |
| Pull requests | Detail | Source: Summary, Timeline, Code | Real on a stand-in gh: title, description, base, reviewers, labels, checks, comments, threads, reactions, viewed marks, line review, merge, draft, branch actions, stack, checkout | Guide absent; no revision picker on Code |
| Pull requests | Linked panel | Source: multiple, stacks, unlink | Link, unlink, watch, Real on a stand-in gh | Layout own |
| Git | Actions | Source: split control with commit, push, pull request and their combinations, phases | Git menu in the header, dialog, phase list, Real against real Git and a stand-in gh | Menu, not a split button; no generated commit message |
| Git | Branches | Source: picker, search, create | Dialog from the branch row, Real | Dialog, not a popover |
| Open in editor | Details row | Source: Open in preferred, menu of detected editors | Match, Real through a stand-in editor on the service's PATH | Layout own |
| Terminal drawer | Open and controls | Live: 483x279 in the main column, Split horizontally, Split vertically, New, Close at 21px, top right | Same controls and order, Real for new, split, close, scripts menu and watch only | Tabs in a top row, reference has a side list |
| Files | Browser and viewer | Source: tree, search, viewer, reveal line | Built, Real tree, previews, safe edit, image, video, audio, PDF, font, hex and partial text from the raw route, Save file | Layout own; no office or ZIP view |
| Files | Previews | Source: Markdown, delimited, Mermaid, notebook, sandboxed HTML | Match, Real; HTML frame has an empty sandbox | Virtualisation replaced by a 2000 row cap |
| Palette | Go to file, Search in project | Source | Match, Real | Open from a thread only |
| Palette | Messages | Source: all words, opens at the message | Messages group, Real, scrolls to the row or the fold that holds it | Word highlights not drawn |
| Browser | Surface | Source: tabs, address, search engines, start page, control | Tabs, address, back, forward from the page's history, reload, control, record, start page, the page follows the panel's size, Real on headless shell | No zoom, devices or profiles |
| Diff | Sources | Source: turn, thread, branch, commits | All five, Real | Picker is a select |
| Diff | Restore a file | Source | Per-file in Turn, Real, reports a later edit instead of overwriting it | Latest turn only |
| Diff | Options | Source: layout, collapse, whitespace, tests, find, copy path, status | Match, Real | Whitespace filtered in the client, find highlights lines not words |
| Timeline | Message actions | Live: Copy, Edit from here, Fork from this response | Match, Real on a turn through the protocol double | Copy prompt link hidden |
| Thread | Find | Source: find bar with position | Built, Real count and steps | Highlights need the browser's Highlight API |
| Settings | Shell | Live: overlay inset 80/40, nav 239, rows 12/16, group radius 12 | Match, Real | 0 by CSS |
| Settings | Sections | Live: General, Appearance, Chat, Diffs & pull requests, Keybindings, SnapShots, Providers, Threads, Browser, Devices, Scheduled tasks, Projects, Source control, Worktrees, Environments, Sharing & access, Maintenance, Labs, About, Archive | 15 backed, all load Real | SnapShots, Browser, Devices hidden; Environments and Sharing out of scope |
| Settings | Keybindings | Source: table, capture, conflicts | Built on the real rules; the shell now runs every rule through when contexts, Real | Row layout own; mod+digit falls back in the client, the service lists no jump rules |
| Settings | Appearance | Source: presets per scheme, editor, import and export, typography | Match, Real | Own preset names, no inspector, no T3 catalogue |
| Settings | Search | Source: finds settings | Finds sections by the settings inside, Real | Section level |
| Settings | Scheduled tasks | Source | List, new, edit, pause, run, delete, Real; interval, fixed time with days, webhook and after-thread kinds; signature, filters, repeats, age, address and deliveries log | The address shows once, when issued, so reopening needs a new one |
| Settings | Notifications | Live: Thread, In-app | Off, notifications, sound or both, and in-app, Real | System alerts only in a hidden window, which now keeps polling while work runs |
| Settings | Providers | Live name | Engines moved here, Real | Layout own |
| Settings | ACP registry | Source: search and add agents | Search, add, remove, Real against a local registry file | First listed install route only |
| Settings | Threads | Live name | Auto-settle, titles, snooze presets, Real | Presets are minutes only, no time of day |
| Settings | Projects | Live name | Library and projects, Real | Layout own |
| Settings | Maintenance | Live name | Update checks, retention rules with preview and report, OTLP addresses with a test, Real | Contents unobserved; the 1 GiB notice ran on the real answer with one field raised |
| Settings | Project settings | Source: per-project defaults | Dialog from each project, Real | Layout own; rows follow the service's project-scoped keys |
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
