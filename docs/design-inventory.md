# Design inventory

Every screen and motion in the internal designs, mapped to this app. Phase 0 built it
from the design HTML and the code on `main`. "Exists" means a component renders the
screen today; it does not mean the screen matches the design. No row has been compared
side by side yet. A phase fills the Proof column for each row it finishes: the design
section and the app at the same 1160x700 frame in Light, Dark and Dim, and for motion
rows a timing check and a filmed reduced-motion fallback.

Component paths are under `web/src` and some line numbers are approximate; each phase
re-verifies its rows. Sources of truth and the token file are in
[design.md](design.md#sources-of-truth).

## Screens (226)

exists: 94, missing: 60, partial: 67, preview-only: 5.

| n | id | group | title | component | status | phase | Proof |
|---|---|---|---|---|---|---|---|
| 1 | `shell-console` | Shell and layouts | Console layout | `app/Shell.tsx:559; state/ui.ts:9` | exists | P1 | |
| 2 | `shell-ledger` | Shell and layouts | Ledger layout | `state/ui.ts:9; app/TitleBar.tsx:84; features/thread/LedgerPin.tsx` | exists | P1 | |
| 3 | `shell-reading` | Shell and layouts | Reading layout | `app/readingNav.ts; app/Shell.tsx:137` | exists | P1 | |
| 4 | `welcome` | Getting started | Welcome | `features/onboarding/WelcomeWizard.tsx:152` | exists | P1 | |
| 5 | `connect-agent` | Getting started | Connect an agent | `features/onboarding/WelcomeWizard.tsx:52` | exists | P1 | |
| 6 | `add-project` | Getting started | Add a project | `features/workspace/AddProjectPalette.tsx:392; features/onboarding/FolderBrowser.tsx` | exists | P1 | |
| 7 | `trust` | Getting started | Trust this folder | `features/onboarding/TrustFolder.tsx:12` | exists | P1 | |
| 8 | `no-projects` | Getting started | No projects yet | `features/onboarding/NoProjects.tsx:10` | exists | P1 | |
| 9 | `new-thread` | Threads | New thread | `features/onboarding/DraftView.tsx:118` | exists | P2 | |
| 10 | `approval` | Threads | Approve a command | `features/thread/ApprovalCard.tsx:24` | exists | P2 | |
| 11 | `question` | Threads | The agent asks a question | `features/thread/QuestionPanel.tsx:79` | exists | P2 | |
| 12 | `plan` | Threads | Proposed plan | `features/thread/PlanCard.tsx:76` | exists | P2 | |
| 13 | `subagents` | Threads | Subagents and queued messages | `features/thread/SubagentBar.tsx:40; features/thread/QueuedMessages.tsx:9` | exists | P2 | |
| 14 | `composer` | Threads | Composer | `features/thread/Composer.tsx:105` | exists | P2 | |
| 15 | `composer-menus` | Threads | Access mode and slash commands | `features/thread/Composer.tsx:243; features/thread/ComposerTraits.tsx` | exists | P2 | |
| 16 | `banners` | Threads | Thread states | `features/thread/ThreadBanners.tsx:19` | exists | P2 | |
| 17 | `git` | Threads | Commit, push and worktrees | `features/thread/GitControl.tsx:213` | exists | P2 | |
| 18 | `find` | Threads | Find, minimap and related threads | `features/thread/ThreadFind.tsx:34; features/thread/Minimap.tsx:14; features/thread/RelatedThreads.tsx:25` | exists | P2 | |
| 19 | `thread-menu` | Threads | Thread menu and undo | `features/workspace/threadMenu.tsx; features/workspace/threadUndo.ts` | exists | P2 | |
| 20 | `palette` | Threads | Command palette | `features/workspace/CommandPalette.tsx:67` | exists | P2 | |
| 21 | `thread-empty` | Threads | Loading, empty and error | `ui/states.tsx:9; features/thread/Transcript.tsx` | exists | P2 | |
| 22 | `tc-collapsed` | Tool calls, every state | Collapsed groups | `features/thread/items.tsx:396` | partial | P2 | |
| 23 | `tc-rows` | Tool calls, every state | Every kind of row, collapsed | `features/thread/toolTrace.ts:49; features/thread/items.tsx:116` | partial | P2 | |
| 24 | `tc-group-open` | Tool calls, every state | Group expanded | `features/thread/items.tsx:420` | exists | P2 | |
| 25 | `tc-command-open` | Tool calls, every state | Command expanded | `features/thread/items.tsx:190; features/thread/CodeBlock.tsx` | partial | P2 | |
| 26 | `tc-output-capped` | Tool calls, every state | Output capped at 12 lines | `features/thread/items.tsx:128` | missing | P2 | |
| 27 | `tc-output-all` | Tool calls, every state | All output, scrolling inside the block | `features/thread/items.tsx:128; styles/thread.css:596` | partial | P2 | |
| 28 | `tc-running` | Tool calls, every state | Running, output streaming | `features/thread/items.tsx:190` | partial | P2 | |
| 29 | `tc-running-group` | Tool calls, every state | Running group, collapsed and open | `features/thread/items.tsx:374,445` | partial | P2 | |
| 30 | `tc-failed` | Tool calls, every state | Failed, with stderr in red | `features/thread/items.tsx:190` | partial | P2 | |
| 31 | `tc-failed-collapsed` | Tool calls, every state | Failed, collapsed | `features/thread/toolTrace.ts:116` | partial | P2 | |
| 32 | `tc-timeout` | Tool calls, every state | Timed out | `features/thread/items.tsx:190` | missing | P2 | |
| 33 | `tc-denied` | Tool calls, every state | Blocked by the access mode, needs you | `features/thread/ApprovalCard.tsx:24` | partial | P2 | |
| 34 | `tc-denied-resolved` | Tool calls, every state | After the choice | `features/thread/ApprovalCard.tsx:13` | partial | P2 | |
| 35 | `tc-cancelled` | Tool calls, every state | Cancelled | `features/thread/projection.ts:39` | missing | P2 | |
| 36 | `tc-output-file` | Tool calls, every state | Output too large, saved to a file | `features/thread/projection.ts:39` | missing | P2 | |
| 37 | `tc-binary` | Tool calls, every state | Binary output | `features/thread/items.tsx:128` | missing | P2 | |
| 38 | `tc-empty` | Tool calls, every state | Empty output | `features/thread/items.tsx:137` | exists | P2 | |
| 39 | `tc-long-hover` | Tool calls, every state | Very long command, collapsed | `features/thread/items.tsx:208` | partial | P2 | |
| 40 | `tc-long-open` | Tool calls, every state | Very long command, expanded | `features/thread/items.tsx:190; features/thread/CodeBlock.tsx:44` | partial | P2 | |
| 41 | `tc-long-lines` | Tool calls, every state | Very long lines in output | `styles/thread.css:596; features/thread/CodeBlock.tsx:11` | partial | P2 | |
| 42 | `tc-many` | Tool calls, every state | Many groups, Expand all and Collapse all | `features/thread/items.tsx:396` | missing | P2 | |
| 43 | `tc-focus` | Tool calls, every state | Keyboard focus on a row | `ui/Collapsible.tsx` | partial | P2 | |
| 44 | `tc-terminal` | Tool calls, every state | Open in terminal | `generated/OpenTerminal.ts` | missing | P2 | |
| 45 | `tc-read` | Tool calls, every state | Read file, with a line range | `features/thread/toolTrace.ts:14,49` | partial | P2 | |
| 46 | `tc-edit` | Tool calls, every state | Edit file, with a mini diff | `features/thread/items.tsx:295` | partial | P2 | |
| 47 | `tc-create` | Tool calls, every state | Create file | `features/thread/toolTrace.ts:15` | missing | P2 | |
| 48 | `tc-search` | Tool calls, every state | Search, with a result list | `features/thread/toolTrace.ts:16` | partial | P2 | |
| 49 | `tc-list` | Tool calls, every state | List files | `features/thread/toolTrace.ts:16` | missing | P2 | |
| 50 | `tc-fetch` | Tool calls, every state | Web fetch, with the page title | `features/thread/toolTrace.ts:17` | partial | P2 | |
| 51 | `tc-mcp` | Tool calls, every state | MCP tool, with server and arguments | `features/thread/McpApp.tsx; features/thread/toolTrace.ts:49` | partial | P2 | |
| 52 | `tc-subagent` | Tool calls, every state | Subagent, with a link to its thread | `features/thread/SubagentBar.tsx:40; features/thread/RelatedThreads.tsx:25` | partial | P2 | |
| 53 | `tc-plan` | Tool calls, every state | Plan or to-do update | `features/thread/items.tsx:254` | exists | P2 | |
| 54 | `tc-image` | Tool calls, every state | Image viewed | `features/thread/toolTrace.ts:14` | partial | P2 | |
| 55 | `tc-side-chat` | Tool calls, every state | Side chat | `features/panels/SideChatPane.tsx:16` | partial | P2 | |
| 56 | `tc-side-needs-you` | Tool calls, every state | Side chat, needs you | `features/panels/SideChatPane.tsx:16; features/thread/ApprovalCard.tsx:24` | partial | P2 | |
| 57 | `tc-phone-list` | Tool calls, every state | Phone: groups and rows | `missing` | missing | P2 | |
| 58 | `tc-phone-sheet` | Tool calls, every state | Phone: output in a sheet | `missing` | missing | P2 | |
| 59 | `tc-phone-needs-you` | Tool calls, every state | Phone: needs you | `missing` | missing | P2 | |
| 60 | `panel-diff` | Side panel and terminal | Diff | `features/panels/DiffPanel.tsx` | exists | P2 | |
| 61 | `panel-files` | Side panel and terminal | Files | `features/panels/FilesPanel.tsx` | exists | P2 | |
| 62 | `panel-browser` | Side panel and terminal | Browser | `features/panels/BrowserPanel.tsx` | exists | P2 | |
| 63 | `panel-activity` | Side panel and terminal | Activity | `features/panels/ActivityPanel.tsx:13` | exists | P2 | |
| 64 | `panel-side` | Side panel and terminal | Side chat | `features/panels/SideChatPane.tsx` | exists | P2 | |
| 65 | `terminal` | Side panel and terminal | Terminal | `features/panels/TerminalDrawerBody.tsx:25` | exists | P2 | |
| 66 | `pulls` | Pages | Pull requests | `features/pulls/PullsPage.tsx:42` | exists | P2 | |
| 67 | `pull-detail` | Pages | Pull request | `features/pulls/PullDetail.tsx:343` | exists | P2 | |
| 68 | `usage` | Pages | Usage | `features/usage/UsagePage.tsx:554` | exists | P2 | |
| 69 | `tasks` | Pages | Scheduled tasks | `features/settings/ScheduledTasks.tsx:597` | exists | P2 | |
| 70 | `task-new` | Pages | New scheduled task | `features/settings/ScheduledTasks.tsx:149` | exists | P2 | |
| 71 | `pr-list-none` | Pull requests, every state | List: no pull requests | `features/pulls/PullsPage.tsx:258` | partial | P2 | |
| 72 | `pr-list-loading` | Pull requests, every state | List: loading | `features/pulls/PullsPage.tsx:253` | exists | P2 | |
| 73 | `pr-list-error` | Pull requests, every state | List: GitHub unreachable | `features/pulls/PullsPage.tsx:256` | exists | P2 | |
| 74 | `pr-list-offline` | Pull requests, every state | List: offline | `missing` | missing | P2 | |
| 75 | `pr-list-signedout` | Pull requests, every state | List: signed out of GitHub | `features/pulls/PullsPage.tsx:262; api/pulls.ts:28` | missing | P2 | |
| 76 | `pr-list-filtered` | Pull requests, every state | List: filtered with no results | `features/pulls/PullsPage.tsx:258` | partial | P2 | |
| 77 | `pr-list-running` | Pull requests, every state | List: checks running | `features/pulls/PullsPage.tsx:32,307` | exists | P2 | |
| 78 | `pr-list-failed` | Pull requests, every state | List: checks failed | `features/pulls/PullsPage.tsx:32,307` | partial | P2 | |
| 79 | `pr-list-review` | Pull requests, every state | List: review requested | `features/pulls/PullsPage.tsx:34` | partial | P2 | |
| 80 | `pr-list-changes` | Pull requests, every state | List: changes requested | `features/pulls/PullsPage.tsx:316` | exists | P2 | |
| 81 | `pr-list-approved` | Pull requests, every state | List: approved and ready to merge | `features/pulls/PullsPage.tsx:34` | exists | P2 | |
| 82 | `pr-list-conflict` | Pull requests, every state | List: merge conflict | `features/pulls/PullsPage.tsx:283` | missing | P2 | |
| 83 | `pr-list-merged` | Pull requests, every state | List: merged | `features/pulls/PullsPage.tsx:28` | exists | P2 | |
| 84 | `pr-list-closed` | Pull requests, every state | List: closed | `features/pulls/PullsPage.tsx:27` | exists | P2 | |
| 85 | `pr-list-draft` | Pull requests, every state | List: draft | `features/pulls/PullsPage.tsx:155,302` | exists | P2 | |
| 86 | `pr-detail-none` | Pull requests, every state | Detail: no pull request | `features/thread/GitControl.tsx:31` | partial | P2 | |
| 87 | `pr-detail-loading` | Pull requests, every state | Detail: loading | `features/pulls/PullDetail.tsx:391` | exists | P2 | |
| 88 | `pr-detail-error` | Pull requests, every state | Detail: GitHub unreachable | `features/pulls/PullDetail.tsx:403` | exists | P2 | |
| 89 | `pr-detail-offline` | Pull requests, every state | Detail: offline | `missing` | missing | P2 | |
| 90 | `pr-detail-signedout` | Pull requests, every state | Detail: signed out of GitHub | `missing` | missing | P2 | |
| 91 | `pr-detail-filtered` | Pull requests, every state | Detail: files filter with no results | `features/pulls/PullCode.tsx` | missing | P2 | |
| 92 | `pr-detail-running` | Pull requests, every state | Detail: checks running | `features/pulls/PullDetail.tsx:47,25` | partial | P2 | |
| 93 | `pr-detail-failed` | Pull requests, every state | Detail: checks failed | `features/pulls/PullDetail.tsx:47` | partial | P2 | |
| 94 | `pr-detail-review` | Pull requests, every state | Detail: review requested | `features/pulls/PullDetail.tsx:528` | partial | P2 | |
| 95 | `pr-detail-changes` | Pull requests, every state | Detail: changes requested | `features/pulls/PullDetail.tsx:528` | partial | P2 | |
| 96 | `pr-detail-approved` | Pull requests, every state | Detail: approved and ready to merge | `features/pulls/PullDetail.tsx:205,625` | partial | P2 | |
| 97 | `pr-detail-conflict` | Pull requests, every state | Detail: merge conflict | `features/pulls/PullDetail.tsx:626` | partial | P2 | |
| 98 | `pr-detail-merged` | Pull requests, every state | Detail: merged | `features/pulls/PullDetail.tsx:576,460` | partial | P2 | |
| 99 | `pr-detail-closed` | Pull requests, every state | Detail: closed | `features/pulls/PullDetail.tsx:632` | exists | P2 | |
| 100 | `pr-detail-draft` | Pull requests, every state | Detail: draft | `features/pulls/PullDetail.tsx:445` | exists | P2 | |
| 101 | `pr-detail-conversation` | Pull requests, every state | Detail: conversation with comments | `features/pulls/PullConversation.tsx` | partial | P2 | |
| 102 | `pr-detail-files` | Pull requests, every state | Detail: Files changed | `features/pulls/PullCode.tsx` | partial | P2 | |
| 103 | `pr-detail-checks` | Pull requests, every state | Detail: Checks with a log | `features/pulls/PullDetail.tsx:47` | partial | P2 | |
| 104 | `pr-detail-merge-menu` | Pull requests, every state | Detail: merge options menu | `features/pulls/PullDetail.tsx:205` | partial | P2 | |
| 105 | `pr-detail-thread` | Pull requests, every state | Detail: thread linked to the pull request | `features/panels/LinkedPulls.tsx; features/panels/tabs.ts:10` | partial | P2 | |
| 106 | `pr-phone-list` | Pull requests, every state | Phone: Pull requests list | `missing` | missing | P2 | |
| 107 | `pr-phone-detail` | Pull requests, every state | Phone: pull request detail | `missing` | missing | P2 | |
| 108 | `s-general` | Settings | Settings · General | `features/settings/PreferenceSections.tsx:59` | exists | P1 | |
| 109 | `s-appearance` | Settings | Settings · Appearance | `features/settings/Appearance.tsx:281` | exists | P1 | |
| 110 | `s-chat` | Settings | Settings · Chat | `features/settings/PreferenceSections.tsx:210` | exists | P1 | |
| 111 | `s-diffs` | Settings | Settings · Diffs & pull requests | `features/settings/PreferenceSections.tsx:353` | exists | P1 | |
| 112 | `s-keys` | Settings | Settings · Keybindings | `features/settings/Keybindings.tsx:12` | exists | P1 | |
| 113 | `s-providers` | Settings | Settings · Providers | `features/settings/Providers.tsx:412` | exists | P1 | |
| 114 | `s-threads` | Settings | Settings · Threads | `features/settings/Threads.tsx:60` | exists | P1 | |
| 115 | `s-tasks` | Settings | Settings · Scheduled tasks | `features/settings/ScheduledTasks.tsx:592` | exists | P1 | |
| 116 | `s-projects` | Settings | Settings · Projects | `features/settings/Projects.tsx:418` | exists | P1 | |
| 117 | `s-source` | Settings | Settings · Source control | `features/settings/PreferenceSections.tsx:472` | exists | P1 | |
| 118 | `s-worktrees` | Settings | Settings · Worktrees | `features/settings/PreferenceSections.tsx:415` | exists | P1 | |
| 119 | `s-maintenance` | Settings | Settings · Maintenance | `features/settings/Maintenance.tsx:405` | exists | P1 | |
| 120 | `s-labs` | Settings | Settings · Labs | `features/settings/PreferenceSections.tsx:510` | exists | P1 | |
| 121 | `s-about` | Settings | Settings · About and updates | `features/settings/PreferenceSections.tsx:587` | exists | P1 | |
| 122 | `s-archive` | Settings | Settings · Archive | `features/settings/PreferenceSections.tsx:602` | exists | P1 | |
| 123 | `s-search` | Settings | Find a setting | `features/settings/SettingsPage.tsx:160; features/settings/settingsSearch.ts` | exists | P1 | |
| 124 | `t-memory` | Tools | Memory | `missing` | missing | P3 | |
| 125 | `t-memory-detail` | Tools | A memory in detail | `missing` | missing | P3 | |
| 126 | `t-memory-forget` | Tools | Forget a memory | `missing` | missing | P3 | |
| 127 | `t-memory-states` | Tools | Memory: empty, offline and MCP | `missing` | missing | P3 | |
| 128 | `t-gate` | Tools | Review gate in a thread | `missing` | missing | P3 | |
| 129 | `t-gate-log` | Tools | Review gate history | `missing` | missing | P3 | |
| 130 | `t-gate-settings` | Tools | Settings · Review gate | `missing` | missing | P3 | |
| 131 | `t-skills` | Tools | Skills library | `missing` | missing | P4 | |
| 132 | `t-skill` | Tools | A skill in detail | `missing` | missing | P4 | |
| 133 | `t-diagrams` | Tools | Diagrams | `missing` | missing | P4 | |
| 134 | `t-diagrams-new` | Tools | New diagram | `missing` | missing | P4 | |
| 135 | `t-audit-start` | Tools | Start a security audit | `missing` | missing | P5 | |
| 136 | `t-audit` | Tools | Security audit report | `missing` | missing | P5 | |
| 137 | `t-audit-finding` | Tools | A finding | `missing` | missing | P5 | |
| 138 | `t-inspect` | Tools | Inspect | `missing` | missing | P5 | |
| 139 | `t-inspect-empty` | Tools | Inspect: empty and error | `missing` | missing | P5 | |
| 140 | `t-phone` | Tools | Memory and review on a phone | `missing` | missing | P3 | |
| 141 | `x-diff-empty` | Side panel, every state | Diff: no changes | `features/panels/DiffPanel.tsx:620` | exists | P2 | |
| 142 | `x-diff-loading` | Side panel, every state | Diff: loading | `features/panels/DiffPanel.tsx:529` | exists | P2 | |
| 143 | `x-diff-error` | Side panel, every state | Diff: couldn't read changes | `features/panels/DiffPanel.tsx:531` | exists | P2 | |
| 144 | `x-diff-binary` | Side panel, every state | Diff: binary file | `features/panels/DiffPanel.tsx:204` | partial | P2 | |
| 145 | `x-diff-huge` | Side panel, every state | Diff: huge file collapsed | `features/panels/DiffPanel.tsx:19,482` | partial | P2 | |
| 146 | `x-diff-conflict` | Side panel, every state | Diff: conflict markers | `features/panels/DiffPanel.tsx:426` | partial | P2 | |
| 147 | `x-diff-staged` | Side panel, every state | Diff: staged and unstaged | `features/panels/DiffPanel.tsx:67` | missing | P2 | |
| 148 | `x-diff-comment` | Side panel, every state | Diff: comment on a line | `features/panels/DiffPanel.tsx:154,253` | exists | P2 | |
| 149 | `x-diff-search` | Side panel, every state | Diff: filter files | `features/panels/DiffPanel.tsx:110` | partial | P2 | |
| 150 | `x-diff-menu` | Side panel, every state | Diff: panel menu open | `features/panels/DiffPanel.tsx` | missing | P2 | |
| 151 | `x-diff-split` | Side panel, every state | Diff: split view, maximised | `features/panels/DiffPanel.tsx:374; features/panels/SurfacePane.tsx:245` | exists | P2 | |
| 152 | `x-files-empty` | Side panel, every state | Files: nothing selected | `features/panels/FilesPanel.tsx:236` | partial | P2 | |
| 153 | `x-files-loading` | Side panel, every state | Files: loading | `features/panels/FilesPanel.tsx:201,245` | exists | P2 | |
| 154 | `x-files-error` | Side panel, every state | Files: folder can't be read | `features/panels/FilesPanel.tsx:247` | exists | P2 | |
| 155 | `x-files-search` | Side panel, every state | Files: search in the tree | `features/panels/FilesPanel.tsx:353` | exists | P2 | |
| 156 | `x-files-edit` | Side panel, every state | Files: unsaved edit | `features/panels/FilesPanel.tsx:43,76` | exists | P2 | |
| 157 | `x-files-readonly` | Side panel, every state | Files: read-only file | `features/panels/FilesPanel.tsx:43` | missing | P2 | |
| 158 | `x-files-large` | Side panel, every state | Files: large tree | `features/panels/FilesPanel.tsx:236` | missing | P2 | |
| 159 | `x-files-menu` | Side panel, every state | Files: file menu open | `features/panels/FilesPanel.tsx:283` | partial | P2 | |
| 160 | `x-browser-empty` | Side panel, every state | Browser: no page open | `features/panels/BrowserPanel.tsx:480` | exists | P2 | |
| 161 | `x-browser-loading` | Side panel, every state | Browser: loading a page | `features/panels/BrowserPanel.tsx` | missing | P2 | |
| 162 | `x-browser-error` | Side panel, every state | Browser: page error | `features/panels/BrowserPanel.tsx:893` | partial | P2 | |
| 163 | `x-browser-offline` | Side panel, every state | Browser: offline | `features/panels/BrowserPanel.tsx` | missing | P2 | |
| 164 | `x-browser-console` | Side panel, every state | Browser: console open | `features/panels/BrowserPanel.tsx` | missing | P2 | |
| 165 | `x-browser-device` | Side panel, every state | Browser: device size picker | `features/panels/BrowserPanel.tsx:185` | exists | P2 | |
| 166 | `x-browser-pick` | Side panel, every state | Browser: element picked | `features/panels/BrowserPanel.tsx:151` | exists | P2 | |
| 167 | `x-activity-empty` | Side panel, every state | Activity: nothing yet | `features/panels/ActivityPanel.tsx:17` | exists | P2 | |
| 168 | `x-activity-running` | Side panel, every state | Activity: running | `features/panels/ActivityPanel.tsx:31` | partial | P2 | |
| 169 | `x-activity-failed` | Side panel, every state | Activity: failed step with log | `features/panels/ActivityPanel.tsx:35` | partial | P2 | |
| 170 | `x-activity-filtered` | Side panel, every state | Activity: filtered | `features/panels/ActivityPanel.tsx:7` | partial | P2 | |
| 171 | `x-side-empty` | Side panel, every state | Side chat: empty | `features/panels/SideChatPane.tsx` | exists | P2 | |
| 172 | `x-side-streaming` | Side panel, every state | Side chat: answering | `features/panels/SideChatPane.tsx:16` | exists | P2 | |
| 173 | `x-side-error` | Side panel, every state | Side chat: error | `features/panels/SideChatPane.tsx:16` | partial | P2 | |
| 174 | `x-gate-running` | Side panel, every state | Review gate: reviewing | `missing` | missing | P3 | |
| 175 | `x-gate-passed` | Side panel, every state | Review gate: passed | `missing` | missing | P3 | |
| 176 | `x-gate-selected` | Side panel, every state | Review gate: finding opened | `missing` | missing | P3 | |
| 177 | `x-gate-error` | Side panel, every state | Review gate: couldn't run | `missing` | missing | P3 | |
| 178 | `x-panel-collapsed` | Side panel, every state | Panel: collapsed | `features/thread/ThreadView.tsx:345` | exists | P1 | |
| 179 | `x-panel-resized` | Side panel, every state | Panel: resized | `features/panels/SurfacePane.tsx:112` | exists | P1 | |
| 180 | `x-panel-maximised` | Side panel, every state | Panel: maximised | `features/panels/SurfacePane.tsx:245` | exists | P1 | |
| 181 | `x-panel-tabs-more` | Side panel, every state | Panel: tabs overflow | `features/panels/SurfacePane.tsx:220` | partial | P1 | |
| 182 | `x-panel-offline` | Side panel, every state | Panel: offline | `features/panels/SurfacePane.tsx` | missing | P1 | |
| 183 | `x-chat-streaming` | Threads, every state | Reply streaming, with stop | `features/thread/ComposerExtras.tsx:129; features/thread/items.tsx:208` | exists | P2 | |
| 184 | `x-chat-interrupted` | Threads, every state | Interrupted, then resumed | `features/thread/ThreadView.tsx:167` | partial | P2 | |
| 185 | `x-chat-code` | Threads, every state | Long code block with copy | `features/thread/CodeBlock.tsx:44` | partial | P2 | |
| 186 | `x-chat-attach` | Threads, every state | Attached files and images | `features/thread/Composer.tsx:70; features/thread/SentFiles.tsx` | exists | P2 | |
| 187 | `x-chat-tool` | Threads, every state | Tool call expanded | `features/thread/items.tsx:190` | exists | P2 | |
| 188 | `x-chat-error` | Threads, every state | Error with retry | `features/thread/ThreadBanners.tsx:70` | exists | P2 | |
| 189 | `x-chat-ratelimit` | Threads, every state | Rate limited, with time to wait | `features/thread/ThreadBanners.tsx:19` | partial | P2 | |
| 190 | `x-chat-context` | Threads, every state | Context nearly full | `features/thread/ComposerExtras.tsx:30` | partial | P2 | |
| 191 | `x-chat-compacting` | Threads, every state | Compacting the thread | `features/thread/ComposerExtras.tsx:53` | partial | P2 | |
| 192 | `x-chat-model-switch` | Threads, every state | Model switched mid-thread | `features/thread/projection.ts:265` | partial | P2 | |
| 193 | `x-chat-edit` | Threads, every state | Edit a message and branch | `features/thread/MessageActions.tsx:81,94` | partial | P2 | |
| 194 | `x-chat-message-menu` | Threads, every state | Message actions | `features/thread/MessageActions.tsx:41` | exists | P2 | |
| 195 | `x-chat-long` | Threads, every state | Very long thread, jump to latest | `features/thread/Transcript.tsx:218` | partial | P2 | |
| 196 | `x-chat-offline` | Threads, every state | Offline composer, queued message | `features/thread/Composer.tsx` | missing | P2 | |
| 197 | `x-chat-slash` | Threads, every state | Slash command results | `features/thread/Composer.tsx:243` | exists | P2 | |
| 198 | `x-chat-slash-none` | Threads, every state | Slash command with no match | `features/thread/Composer.tsx:243` | partial | P2 | |
| 199 | `x-chat-mention` | Threads, every state | @-mention file picker | `features/thread/Composer.tsx:232` | exists | P2 | |
| 200 | `x-chat-voice` | Threads, every state | Voice dictation | `features/thread/Composer.tsx` | missing | P2 | |
| 201 | `x-chat-suggest` | Threads, every state | Empty thread, ready to start | `features/onboarding/DraftView.tsx:347` | exists | P2 | |
| 202 | `x-chat-archived` | Threads, every state | Archived thread, read-only | `features/settings/PreferenceSections.tsx:602` | partial | P2 | |
| 203 | `x-term-tabs` | Terminal, every state | Terminal: several tabs | `features/panels/TerminalDrawerBody.tsx:101` | exists | P2 | |
| 204 | `x-term-running` | Terminal, every state | Terminal: a running process | `features/panels/TerminalPanel.tsx:207` | partial | P2 | |
| 205 | `x-term-failed` | Terminal, every state | Terminal: a failed command | `features/panels/TerminalPanel.tsx:42` | partial | P2 | |
| 206 | `x-term-search` | Terminal, every state | Terminal: search in output | `package.json xterm deps` | missing | P2 | |
| 207 | `x-term-split` | Terminal, every state | Terminal: split panes | `features/panels/TerminalDrawerBody.tsx:125` | exists | P2 | |
| 208 | `x-term-menu` | Terminal, every state | Terminal: tab menu | `features/panels/TerminalDrawerBody.tsx:179` | missing | P2 | |
| 209 | `x-term-agent` | Terminal, every state | Terminal: started by the agent | `features/panels/TerminalDrawerBody.tsx:138; features/panels/TerminalPanel.tsx:76` | partial | P2 | |
| 210 | `x-term-ended` | Terminal, every state | Terminal: process ended | `features/panels/TerminalPanel.tsx:207` | partial | P2 | |
| 211 | `x-term-maximised` | Terminal, every state | Terminal: maximised | `features/thread/ThreadView.tsx:402` | partial | P2 | |
| 212 | `x-term-closed` | Terminal, every state | Terminal: closed | `features/thread/ThreadView.tsx:282` | missing | P2 | |
| 213 | `x-phone-stream` | Phone, more | Phone: streaming and offline | `missing` | missing | P2 | |
| 214 | `x-phone-panel` | Phone, more | Phone: Diff and checks | `missing` | missing | P2 | |
| 215 | `update` | Updates, dialogs and toasts | Updates | `features/workspace/Updates.tsx:275` | exists | P1 | |
| 216 | `quit` | Updates, dialogs and toasts | Quit while agents run | `features/workspace/QuitConfirmation.tsx:17` | exists | P1 | |
| 217 | `toasts` | Updates, dialogs and toasts | Toasts and dialogs | `ui/Toasts.tsx:6; ui/Dialog.tsx` | exists | P1 | |
| 218 | `account` | Orbyn account and other devices | Sign in to Orbyn | `features/platform/AccountCard.tsx; features/platform/previews.ts` | preview-only | Later | |
| 219 | `connect-planner` | Orbyn account and other devices | Connect Orbyn Planner | `features/platform/ConnectPlanner.tsx` | preview-only | Later | |
| 220 | `pair-phone` | Orbyn account and other devices | Remote access and pairing | `features/platform/PairPhone.tsx` | preview-only | P2 | |
| 221 | `phone` | Orbyn account and other devices | On a phone | `features/platform/PhoneView.tsx` | preview-only | P2 | |
| 222 | `conn-defs` | Connection states | Connection states: the four definitions |  | missing | P1 | |
| 223 | `conn-compare` | Connection states | Connection states side by side |  | missing | P1 | |
| 224 | `conn-service-down` | Connection states | Can't reach the Orbyn service |  | missing | P1 | |
| 225 | `conn-service-restart` | Connection states | Restarting the Orbyn service |  | missing | P1 | |
| 226 | `conn-remote` | Connection states | Paired machine offline |  | preview-only | P2c | |

## Motion (85)

differs: 26, missing: 31, n/a: 28.

Rows with status `n/a` belong to another Orbyn app and have no Engineering screen; they stay listed so the count is whole.

| n | section | title | property | duration | easing | reduced motion | component | status | phase | Proof |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `tokens` | Motion tokens | transform scaleX | fast 150ms, base 200ms, page 240ms, slow 300ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | bars fill and empty with a fade, no scaling | `web/src/styles/tokens.css:113-117` | differs | P1 | |
| 2 | `button` | Button states | background-color, box-shadow (focus ring), transform scale(.97) on press | fast 150ms | cubic-bezier(.4,0,.2,1) | colour and ring only, no scale | `web/src/ui/controls.tsx; web/src/styles/base.css:214 .btn` | differs | P1 | |
| 3 | `toggle` | Toggle switch | knob transform translateX(14px), track background-color | fast 150ms | cubic-bezier(.2,.8,.2,1) | track colour changes; the knob jumps without sliding | `web/src/styles/base.css:152-170 input[role=switch]` | differs | P1 | |
| 4 | `checkbox` | Checkbox tick | background-color, border-color, tick opacity and scale .4 to 1 | fast 150ms | cubic-bezier(.2,.8,.2,1) | box fills and the tick fades in at full size | `n/a (Planner only)` | n/a | Not this app | |
| 5 | `segmented` | Segmented control | thumb transform translateX, label color | base 200ms, fast 150ms | cubic-bezier(.2,.8,.2,1) | thumb jumps to the segment, label colour fades | `web/src/ui/Segmented.tsx; web/src/styles/pages.css:191-212 .segmented` | missing | P1 | |
| 6 | `tabs` | Tabs and underline | underline transform translateX; pane opacity and translateY 6px | base 200ms, fast 150ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | underline jumps; pane cross-fades only | `n/a (Account only)` | n/a | Not this app | |
| 7 | `pill` | Pill filters | background-color, color, transform scale(.97) on press | fast 150ms | cubic-bezier(.4,0,.2,1) | colour only, no scale | `n/a (Notes only)` | n/a | Not this app | |
| 8 | `input` | Input focus | border-color, box-shadow (3px ring) | fast 150ms | cubic-bezier(.4,0,.2,1) | same colour change, nothing else moves | `web/src/styles/base.css:121 input/textarea/select:focus-visible; web/src/styles/thread.css:1128 .composer-box` | missing | P1 | |
| 9 | `inputerr` | Error reveal | border-color; message opacity and translateY -4px to 0; no shake, no height change | fast 150ms, base 200ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | message fades, no offset | `web/src/features/onboarding/SignIn.tsx; web/src/styles/thread.css:984 .notice-error` | missing | P1 | |
| 10 | `select` | Select open | menu opacity, translateY -4px, scale .98 from the trigger; chevron rotate 180deg | base 200ms, fast 150ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | menu fades; chevron flips without turning | `native <select> (base.css:123 focus style); custom menu is ui/Menu.tsx` | missing | P1 | |
| 11 | `menu` | Menu open and close | opacity, transform translateY -4px and scale .98 from the trigger corner | base 200ms, exit 140ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | opacity only, 150ms | `web/src/ui/Menu.tsx; web/src/styles/base.css:772 .popup-menu` | differs | P1 | |
| 12 | `palette` | Launcher search | scrim opacity; panel opacity and translateY -8px; results opacity, translateY to the next slot | base 200ms, exit 140ms, fast 150ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | panel and scrim fade; rows fade out and close up | `web/src/features/workspace/CommandPalette.tsx:222 (bare <dialog class=palette>); web/src/styles/base.css:988 .palette` | missing | P1 | |
| 13 | `tooltip` | Tooltip delay | opacity, translateY -2px to 0 | fast 150ms, exit 105ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | opacity only, same delay | `web/src/styles/base.css:845 .hover-card (ThreadRow.tsx:116, PullLinkPreview.tsx:112); native title= elsewhere (ui/controls.tsx:74)` | differs | P1 | |
| 14 | `context` | Context menu | opacity, translateY -4px and scale .98 from the pointer position | base 200ms, exit 140ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | opacity only | `web/src/features/panels/FilesPanel.tsx:260; features/workspace/ProjectFilter.tsx:126 (via ui/Menu.tsx)` | differs | P1 | |
| 15 | `modal` | Modal and scrim | scrim opacity; dialog opacity, translateY 8px to 0, scale .98 to 1 | base 200ms, exit 140ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | scrim and dialog fade only | `web/src/ui/Dialog.tsx; web/src/styles/base.css:547-562 .dialog` | differs | P1 | |
| 16 | `confirm` | Confirm a destructive action | dialog and scrim as the modal; row opacity, siblings translateY one slot; toast translateY 12px | base 200ms, exit 140ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | dialog fades; row fades out and the list closes up at once | `web/src/ui/Dialog.tsx; web/src/styles/base.css:547-562 .dialog; web/src/ui/Toasts.tsx; web/src/styles/base.css:925 .toast` | differs | P1 | |
| 17 | `sheet` | Phone bottom sheet | sheet translateY 100% to 0; scrim opacity; drag follows the pointer 1:1 | slow 300ms, exit 210ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | sheet and scrim fade; drag still works | `missing (no bottom sheet; dialogs are centred)` | missing | P1 | |
| 18 | `sidepanel` | Side panel slide | panel transform translateX 100% to 0; content does not reflow | slow 300ms, exit 210ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | panel fades in place, no travel | `web/src/features/panels/SurfacePane.tsx:209; web/src/styles/thread.css:1710-1722 .context; web/src/lib/panelAnimations.ts` | differs | P1 | |
| 19 | `sidetabs` | Side panel tabs | tab background-color and color; content opacity cross-fade | fast 150ms, exit 105ms | cubic-bezier(.4,0,.2,1), exit cubic-bezier(.2,.8,.2,1) | colour and fade only, same as full motion | `web/src/styles/thread.css:1760-1850 .ptab/.surface-tab; features/panels/SurfacePane.tsx` | missing | P1 | |
| 20 | `sidetabs` | Side panel tabs | tab flex-basis, max-width and padding to 0, opacity out; neighbours slide in as it collapses (one small strip, layout) | base 200ms | cubic-bezier(.4,0,.2,1) | tab disappears at once, content fades | `web/src/features/panels/SurfacePane.tsx; web/src/styles/thread.css:1801 .surface-tab` | missing | P1 | |
| 21 | `sidetabs` | Side panel tabs | tab flex-basis, max-width and padding from 0 to full, opacity in | base 200ms | cubic-bezier(.2,.8,.2,1) | tab appears at once, content fades | `web/src/features/panels/SurfacePane.tsx; web/src/styles/thread.css:1801 .surface-tab` | missing | P1 | |
| 22 | `sidetabs` | Side panel tabs | dragged tab lifts (translateY -2px, shadow) and follows the pointer; the others transform translateX one tab width | fast 150ms | cubic-bezier(.2,.8,.2,1) | tab order changes at once; no lift or slide | `n/a (Engineering has no tab drag-reorder; SurfacePane has no drag handlers)` | n/a | Not this app | |
| 23 | `termdrawer` | Terminal drawer | drawer transform translateY 100% to 0 over the thread | slow 300ms, exit 210ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | drawer fades in place | `web/src/features/thread/ThreadView.tsx:277-286 TerminalDrawer; web/src/styles/thread.css:1685 .drawer` | missing | P2 | |
| 24 | `settings` | Settings navigation | highlight transform translateY; pane opacity and translateY 6px to 0 | base 200ms, page 240ms, exit 170ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | highlight jumps; pane cross-fades | `web/src/features/settings/SettingsPage.tsx` | missing | P1 | |
| 25 | `toast` | Toasts | opacity, translateY 12px to 0; older toasts translateY up one slot | base 200ms, exit 140ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | toasts fade and stack without moving | `web/src/ui/Toasts.tsx; web/src/styles/base.css:925 .toast` | differs | P1 | |
| 26 | `banner` | Banner | opacity, translateY -8px to 0 in a reserved slot, nothing below shifts | base 200ms, exit 140ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | banner fades in place | `web/src/styles/base.css:506 .banner` | missing | P1 | |
| 27 | `spinner` | Spinner | spinner opacity; rotate 360deg loop, linear 900ms | fast 150ms, wait 400ms | cubic-bezier(.4,0,.2,1) | static ring, no rotation | `web/src/styles/base.css:647 .spin (Loader2 in items.tsx:265, SubagentBar.tsx:24, Updates.tsx:95)` | differs | P1 | |
| 28 | `skeleton` | Skeleton to content | skeleton opacity; content opacity | fast 150ms, base 200ms, exit 105ms, wait 400ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | same fades | `web/src/ui/states.tsx; web/src/styles/base.css:447-453 .skeleton` | differs | P1 | |
| 29 | `progress` | Progress bar | fill transform scaleX from the left; colour blue while running, green when done | base 200ms, fast 150ms | cubic-bezier(.2,.8,.2,1) | fill jumps to each value | `web/src/styles/shell.css:1250-1265 .quit-progress (hold-to-quit bar only); update install progress is a text line (features/settings/engineUpdates.tsx:80)` | differs | P1 | |
| 30 | `syncline` | Sync line | label opacity cross-fade; colour from the label's own state | fast 150ms, exit 105ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | same cross-fade | `n/a (Planner only)` | n/a | Not this app | |
| 31 | `status` | Status labels | label opacity cross-fade; background and text colour per state | fast 150ms, exit 105ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | same cross-fade | `web/src/ui/controls.tsx:116 .pill; web/src/styles/base.css:721 .status-dot` | missing | P1 | |
| 32 | `checkoff` | Task check-off | tick opacity and scale; strike transform scaleX; row opacity; row translateY to Done after a 1.5s pause with Undo | fast 150ms, base 200ms, slow 300ms | cubic-bezier(.2,.8,.2,1) | tick and strike appear; row fades and reappears in Done | `n/a (Planner only)` | n/a | Not this app | |
| 33 | `additem` | Add an item | new row opacity and translateY -6px to 0; rows below translateY one slot | base 200ms | cubic-bezier(.2,.8,.2,1) | new row fades in; rows jump one slot | `n/a (Planner only)` | n/a | Not this app | |
| 34 | `delete` | Delete with collapse | row opacity; siblings translateY one slot up at the same moment | base 200ms, exit 140ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | row fades; list closes up at once | `n/a (Planner only)` | n/a | Not this app | |
| 35 | `reorder` | Drag reorder | lifted row scale 1.02 with shadow; row follows the pointer 1:1; neighbours translateY one slot; settles into place | fast 150ms, base 200ms | cubic-bezier(.2,.8,.2,1) | no scale; row snaps into its slot | `n/a (Planner only)` | n/a | Not this app | |
| 36 | `board` | Board card between lanes | card translate between lanes; lift scale 1.03 and shadow; cards below move one slot | slow 300ms, fast 150ms, base 200ms | cubic-bezier(.2,.8,.2,1) | card appears in its new lane without travel | `n/a (Planner only)` | n/a | Not this app | |
| 37 | `calcreate` | Calendar drag and resize | event block transform scaleY from the top edge (label does not scale); label opacity | fast 150ms | cubic-bezier(.2,.8,.2,1) | block steps to its size, label fades in | `n/a (Planner only)` | n/a | Not this app | |
| 38 | `calview` | Month and week views | thumb transform translateX; view opacity and translateY 6px to 0 | base 200ms, page 240ms, exit 170ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | views cross-fade only | `n/a (Planner only)` | n/a | Not this app | |
| 39 | `notelist` | Note list to editor | selection background-color; editor opacity | fast 150ms, exit 105ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | same fades | `n/a (Notes only)` | n/a | Not this app | |
| 40 | `search` | Search filtering | non-matching rows opacity; matching rows translateY into the freed slots | base 200ms, exit 140ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | rows fade; matches jump up | `n/a (Notes only)` | n/a | Not this app | |
| 41 | `send` | Send a message | message opacity and translateY 8px to 0 from the composer; composer text cleared | base 200ms, fast 150ms | cubic-bezier(.2,.8,.2,1) | message fades in; no travel | `web/src/features/thread/Composer.tsx:960-975 .send-btn; web/src/styles/thread.css:1263` | missing | P2 | |
| 42 | `stream` | Streaming text | each word opacity 0 to 1; send and stop icons cross-fade | fast 150ms | cubic-bezier(.2,.8,.2,1) | text appears whole in one fade | `web/src/styles/thread.css:360-366 .caret; features/thread/Composer.tsx:960-975` | missing | P2 | |
| 43 | `steps` | Agent step trail | step opacity and translateY 8px to 0; spinner to tick cross-fade | fast 150ms, base 200ms | cubic-bezier(.2,.8,.2,1) | steps fade in; icons cross-fade | `web/src/features/thread/items.tsx:265; web/src/styles/thread.css:517 .trace[data-live]::after` | missing | P2 | |
| 44 | `approval` | Approval card | card opacity and translateY 8px to 0; amber to neutral background and border; content cross-fade | base 200ms, fast 150ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | card and content fade only | `web/src/features/thread/items.tsx; web/src/styles/thread.css:691 .approval` | missing | P2 | |
| 45 | `question` | Question card | card as an approval; option background-color; question to answer cross-fade | base 200ms, fast 150ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | fades only | `web/src/features/thread/items.tsx (question card)` | missing | P2 | |
| 46 | `plan` | Plan proposed | card opacity and translateY 8px to 0; status and button cross-fade; step tick | base 200ms, fast 150ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | fades only | `web/src/features/thread/items.tsx (plan card)` | missing | P2 | |
| 47 | `subagents` | Subagent chips | chip opacity and translateY 8px to 0; spinner to tick cross-fade | fast 150ms | cubic-bezier(.2,.8,.2,1) | chips fade in together | `web/src/features/thread/SubagentBar.tsx:24` | missing | P2 | |
| 48 | `composer` | Composer grow | one-line and three-line shells cross-fade; the thread translateY by the extra height; no height animation | fast 150ms, base 200ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | shells cross-fade; thread jumps | `web/src/features/thread/Composer.tsx; web/src/styles/thread.css:1128 .composer-box` | missing | P2 | |
| 49 | `threadswitch` | Thread switch | thread background-color; conversation opacity (frequent action, no travel) | fast 150ms, exit 105ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | same fades | `web/src/features/workspace/ThreadRow.tsx; web/src/styles/shell.css:309 .thread-row` | differs | P2 | |
| 50 | `toolcalls` | Tool calls in a thread | group, command and extra-output rows height (grid 0fr to 1fr) and opacity; rows below are pushed, never overlapped; streamed lines opacity | base 200ms, exit 140ms, fast 150ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | rows open and close at once, lines and content fade | `web/src/ui/Collapsible.tsx; web/src/styles/base.css:752 .collapsible-panel (used by items.tsx:98,201,333)` | differs | P2 | |
| 51 | `hunk` | Diff hunk expand | revealed lines opacity; the lines below translateY by the revealed height | base 200ms, slow 300ms | cubic-bezier(.2,.8,.2,1) | lines fade in; the block below jumps | `web/src/features/panels/DiffPanel.tsx` | missing | P2 | |
| 52 | `review` | Review-gate findings | finding opacity and translateY 8px to 0 as each check reports; gate label cross-fade | base 200ms, fast 150ms | cubic-bezier(.2,.8,.2,1) | rows fade in as they arrive | `missing (no review-gate UI found in styles/*.css or components by grep)` | missing | P3 | |
| 53 | `slash` | Notes slash menu | menu opacity, translateY -4px and scale .98 from the caret; items fade as the query narrows; inserted block opacity | base 200ms, exit 140ms, fast 150ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | menu and block fade only | `web/src/features/thread/Composer.tsx (mention menu); web/src/styles/base.css:1138 .mention-menu` | differs | P1 | |
| 54 | `linkchip` | Link chip insert | pasted text opacity out; chip opacity and scale .96 to 1 in the same spot | fast 150ms, exit 105ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | cross-fade without scale | `n/a (Notes only)` | n/a | Not this app | |
| 55 | `saveind` | Save indicator | label opacity cross-fade; spinner rotates while saving | fast 150ms, exit 105ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | same cross-fade, static ring | `n/a (Notes only)` | n/a | Not this app | |
| 56 | `flip` | Study card flip | card face opacity and scale .98 to 1 (2D swap, no rotation) | fast 150ms, exit 105ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | plain cross-fade, no scale | `n/a (Notes only)` | n/a | Not this app | |
| 57 | `habit` | Habit check | fill background-color; tick opacity; press scale .92 to 1; streak text cross-fade | fast 150ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | fill and tick fade, no scale | `n/a (Journal only)` | n/a | Not this app | |
| 58 | `scrub` | Timeline scrub | playhead transform translateX; follows the pointer 1:1 while dragging, eases on a click or key step | fast 150ms | cubic-bezier(.2,.8,.2,1) | playhead jumps; time label updates | `n/a (Studio only)` | n/a | Not this app | |
| 59 | `clip` | Clip select and trim | selection box-shadow; handle opacity; clip body transform scaleX from the left (label does not scale) | fast 150ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | outline and handle fade; body steps | `n/a (Studio only)` | n/a | Not this app | |
| 60 | `exportq` | Export queue | progress transform scaleX; status label opacity cross-fade; blue while rendering, green when done | base 200ms, fast 150ms | cubic-bezier(.2,.8,.2,1) | fill jumps; labels cross-fade | `n/a (Studio only)` | n/a | Not this app | |
| 61 | `feedprev` | Feed preview update | caption and overlay opacity cross-fade; confirmation chip opacity | base 200ms, fast 150ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | same cross-fades | `n/a (Studio only)` | n/a | Not this app | |
| 62 | `booking` | Booking slot pick | slot background-color, press scale .97; summary opacity and translateY 8px to 0; button spinner after 400ms | fast 150ms, base 200ms, wait 400ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | colour and fades only | `n/a (Planner only)` | n/a | Not this app | |
| 63 | `signin` | Approve a sign-in | button spinner opacity after 400ms; card content cross-fade | fast 150ms, wait 400ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | same cross-fade, static ring | `n/a (Account only)` | n/a | Not this app | |
| 64 | `consent` | Consent allow | toggle knob translateX; button spinner after 400ms; card content cross-fade | fast 150ms, wait 400ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | same cross-fade, static ring | `n/a (Account only)` | n/a | Not this app | |
| 65 | `update` | Launcher update progress | progress transform scaleX; button, bar and caption opacity cross-fade; blue while downloading | base 200ms, fast 150ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | fill jumps; labels cross-fade | `web/src/features/workspace/Updates.tsx:95,296; web/src/features/settings/engineUpdates.tsx:80` | missing | P1 | |
| 66 | `sidenav` | Sidebar select | highlight transform translateY; label color; title opacity | base 200ms, fast 150ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | highlight jumps; colour and title fade | `web/src/features/workspace/Sidebar.tsx; web/src/styles/shell.css:309 .thread-row` | differs | P1 | |
| 67 | `pagechange` | Page change | outgoing opacity; incoming opacity and translateY 6px to 0 | exit 170ms, page 240ms | cubic-bezier(.4,0,.2,1), exit cubic-bezier(.2,.8,.2,1) | plain cross-fade | `web/src/app/Shell.tsx; lib/panelAnimations.ts:19-31` | missing | P1 | |
| 68 | `pushpop` | Phone push and pop | pushed screen transform translateX 100% to 0; the screen below stays still | page 240ms, exit 170ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | screen fades in place | `missing (no push/pop; narrow layout swaps views, thread.css:1722-1733)` | missing | P1 | |
| 69 | `tabbar` | Tab bar switch | indicator transform translateX; label colour; screen opacity (frequent, no travel) | base 200ms, fast 150ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | indicator jumps; colour and screen fade | `n/a (no phone tab bar in the web app; only PreviewScreens.tsx mock)` | n/a | Not this app | |
| 70 | `collapse` | Sidebar to drawer | drawer transform translateX -100% to 0; scrim opacity | slow 300ms, exit 210ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | drawer and scrim fade in place | `web/src/styles/shell.css:651-657 [data-panel-motion=on] .sidebar; web/src/lib/panelAnimations.ts` | differs | P1 | |
| 71 | `themes` | Theme switch | background-color, color, border-color, box-shadow on every surface | fast 150ms | cubic-bezier(.4,0,.2,1) | same colour change (it is not movement) | `web/src/styles/themes.ts; state/ui.ts:677; app/App.tsx:48` | missing | P1 | |
| 72 | `reduced` | Reduced motion | opacity, transform translateY -4px and scale .98 from the trigger corner | base 200ms, exit 140ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | opacity only, 150ms | `web/src/ui/Menu.tsx; web/src/styles/base.css:772 .popup-menu` | differs | P1 | |
| 73 | `reduced` | Reduced motion | opacity, transform translateY -4px and scale .98 from the trigger corner | base 200ms, exit 140ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | opacity only, 150ms | `web/src/ui/Menu.tsx; web/src/styles/base.css:772 .popup-menu` | differs | P1 | |
| 74 | `reduced` | Reduced motion | scrim opacity; dialog opacity, translateY 8px to 0, scale .98 to 1 | base 200ms, exit 140ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | scrim and dialog fade only | `web/src/ui/Dialog.tsx; web/src/styles/base.css:547-562 .dialog` | differs | P1 | |
| 75 | `reduced` | Reduced motion | scrim opacity; dialog opacity, translateY 8px to 0, scale .98 to 1 | base 200ms, exit 140ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | scrim and dialog fade only | `web/src/ui/Dialog.tsx; web/src/styles/base.css:547-562 .dialog` | differs | P1 | |
| 76 | `reduced` | Reduced motion | panel transform translateX 100% to 0; content does not reflow | slow 300ms, exit 210ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | panel fades in place, no travel | `web/src/features/panels/SurfacePane.tsx:209; web/src/styles/thread.css:1710-1722 .context; web/src/lib/panelAnimations.ts` | differs | P2 | |
| 77 | `reduced` | Reduced motion | panel transform translateX 100% to 0; content does not reflow | slow 300ms, exit 210ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | panel fades in place, no travel | `web/src/features/panels/SurfacePane.tsx:209; web/src/styles/thread.css:1710-1722 .context; web/src/lib/panelAnimations.ts` | differs | P2 | |
| 78 | `reduced` | Reduced motion | opacity, translateY 12px to 0; older toasts translateY up one slot | base 200ms, exit 140ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | toasts fade and stack without moving | `web/src/ui/Toasts.tsx; web/src/styles/base.css:925 .toast` | differs | P1 | |
| 79 | `reduced` | Reduced motion | opacity, translateY 12px to 0; older toasts translateY up one slot | base 200ms, exit 140ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | toasts fade and stack without moving | `web/src/ui/Toasts.tsx; web/src/styles/base.css:925 .toast` | differs | P1 | |
| 80 | `reduced` | Reduced motion | tick opacity and scale; strike transform scaleX; row opacity; row translateY to Done after a 1.5s pause with Undo | fast 150ms, base 200ms, slow 300ms | cubic-bezier(.2,.8,.2,1) | tick and strike appear; row fades and reappears in Done | `n/a (Planner only)` | n/a | Not this app | |
| 81 | `reduced` | Reduced motion | tick opacity and scale; strike transform scaleX; row opacity; row translateY to Done after a 1.5s pause with Undo | fast 150ms, base 200ms, slow 300ms | cubic-bezier(.2,.8,.2,1) | tick and strike appear; row fades and reappears in Done | `n/a (Planner only)` | n/a | Not this app | |
| 82 | `reduced` | Reduced motion | card opacity and translateY 8px to 0; amber to neutral background and border; content cross-fade | base 200ms, fast 150ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | card and content fade only | `web/src/features/thread/items.tsx; web/src/styles/thread.css:691 .approval` | missing | P2 | |
| 83 | `reduced` | Reduced motion | card opacity and translateY 8px to 0; amber to neutral background and border; content cross-fade | base 200ms, fast 150ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | card and content fade only | `web/src/features/thread/items.tsx; web/src/styles/thread.css:691 .approval` | missing | P2 | |
| 84 | `reduced` | Reduced motion | sheet translateY 100% to 0; scrim opacity; drag follows the pointer 1:1 | slow 300ms, exit 210ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | sheet and scrim fade; drag still works | `missing (no bottom sheet; dialogs are centred)` | missing | P1 | |
| 85 | `reduced` | Reduced motion | sheet translateY 100% to 0; scrim opacity; drag follows the pointer 1:1 | slow 300ms, exit 210ms | cubic-bezier(.2,.8,.2,1), exit cubic-bezier(.4,0,.2,1) | sheet and scrim fade; drag still works | `missing (no bottom sheet; dialogs are centred)` | missing | P1 | |

## Performance budgets

The repository had no performance budgets, so these are the budgets from the build
brief:

- Every designed animation holds 60 fps with no dropped frames.
- Input to paint stays under 100 ms for typing, clicks and tab switches.
- Web INP stays under 200 ms, LCP under 2.5 s and CLS under 0.1.
- Long threads, terminal output and lists stay smooth at 10,000 items.
- Nothing is slower than the baseline below.

### Baseline on `main`

Measured on 7 November 2026 on the then-current `main`, with the web build against
`orbynd` on seeded threads. The machine was under heavy load while these ran, so
treat the slow figures as an upper bound and re-run the baseline before comparing.

Startup and idle (2,000-item run only):

| Measure | Value | Budget |
|---|---|---|
| First usable, median of 5 | 1981 ms | none set |
| LCP, median of 5 | 2020 ms | under 2500 ms |
| CLS, max of 5 | 0.5108 | under 0.1 |
| Idle heap | 4.2 MB, 237 DOM nodes | none set |

Long thread (40 turns of 50 items is 2,000 items; 200 turns is 10,000 items):

| Measure | 2,000 items | 10,000 items | Budget |
|---|---|---|---|
| Seed time | 38986 ms | 174971 ms | n/a |
| Open thread | 2941 ms | 11681 ms | none set |
| Heap after open | 51.3 MB | 197.7 MB | none set |
| DOM nodes after open | 67920 | 338181 | none set |
| Scroll frame rate | 57 fps over 228 frames | 4.8 fps over 19 frames | 60 fps |
| Scroll p95 frame | 16.8 ms | 633.3 ms | 16.7 ms |
| Scroll worst frame | 83.4 ms | 633.3 ms | 16.7 ms |
| Scroll frames over 33 ms | 3 | 17 | 0 |
| Typing, input to next frame (median / p95 / max) | 16.1 / 18.5 / 19 ms | 18.3 / 20.7 / 21.7 ms | under 100 ms |
| Typing, slowest event | 80 ms (p95 32 ms) | 528 ms (p95 40 ms) | INP under 200 ms |
| Thread switch to a short thread (3 runs) | 188-617 ms | 422-5696 ms | under 100 ms |
| Thread switch to the long thread (3 runs) | 600-1083 ms | 4854-11011 ms | under 100 ms |

Side-panel tab switch, range of 3 runs (budget: under 100 ms):

| Tab | 2,000 items | 10,000 items |
|---|---|---|
| Diff | 102-130 ms | 446-580 ms |
| Files | 130-316 ms | 464-2267 ms |
| Browser | 113-117 ms | 571-1814 ms |
| Activity | 168-192 ms | 946-2409 ms |
| Pull requests | 115-125 ms | 537-2044 ms |
| Side chat | 102-117 ms | 443-2577 ms |

The startup layout shift is the largest miss: CLS 0.51 against a budget of 0.1, from
the draft layout and `BODY`. At 10,000 items scrolling drops to under 5 fps, which is
the case the virtualised thread list in Phase 2 has to fix. Startup figures were not
measured in the 10,000-item run.
