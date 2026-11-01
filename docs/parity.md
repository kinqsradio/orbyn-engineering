# T3 Code feature parity

Reference: T3 Code at upstream `cadf7d5fe3`, MIT. This is our own feature list in
our own words; it is not T3 Code's documentation. Paths in rows point into that
reference checkout, not this repository. Tick a row only when it works through
the real service and has a test or an observed run. Mock-only UI does not count.

Surfaces: w web, d desktop, m mobile, s server, c cli.

A row marked `| server done` has its service behavior finished and tested; any
web, desktop or mobile surface on that row is tracked by that client's owner.
`| web done` means the web surface was run against the real `orbynd`; other
surfaces on that row stay open.

## Scope and counting

The target is T3 Code's macOS and Windows desktop and local web experience.
Rows are local by default, including their service and CLI support. Only local
surfaces count: `m` on a mixed-surface row does not add a mobile requirement.
Every mobile-only row and all of section Q are excluded. All of section L is
excluded except L27's local access checks. Accounts, sign-in, credential handling,
remote access and T3-hosted services remain excluded wherever they occur.
Desktop emulator controls are desktop surfaces; their presence here does not
add a mobile client to scope. Custom worktree locations remain excluded by the
owner's fixed sibling-location decision.

Keep the original row and reference when scope differs; append these fields:

- No `scope` field means `local` under the rules above.
- `scope: excluded` and `reason:` remove the whole row from the local denominator.
- `scope: mixed`, `local:` and `excludes:` retain the named local requirement once,
  without requiring the excluded behavior. An authentication or hosted tag alone
  does not remove a mixed row's local work.
- `scope: unresolved` and `reason:` keep a scope question visible and separate
  from both included and excluded totals. A visible row marked `beyond T3` needs
  a T3 behavior reference before it becomes a replica requirement; internal core
  and harness safety work does not add a product surface.
- `status: partial` and `remaining:` record incomplete behavior or evidence even
  when an older checkbox is ticked. Preserve its existing `server done`, `web done`
  and platform notes. A ticked service-only client row is also counted as partial
  when it names `w` or `d` but has `server done` without `web done`.
  Missing engine access, assets or release inputs are limits,
  not automatic scope exclusions or completion.
- `status: not_doable` and `reason:` keep a requirement in scope while recording
  why it cannot apply or be implemented as written. It is separate from checked,
  partial and excluded; it does not assert working behavior.

Run `python3 scripts/count-parity.py` (or `--json`) to count this file directly.
It reports source checkboxes, declared checked, partial, open, not-doable, excluded
and unresolved rows. The included total is declared checked + partial + open + not-doable;
any unresolved rows must be reported alongside it. These are declarations in a
checklist, not freshly verified product behavior. Existing checkboxes still need
the real-service, desktop and platform evidence their rows require. Do not call
this product complete from these counts.

The historical 365/573 count excluded sections L and Q plus every remaining
`[auth-risk]` or `[hosted]` row, then removed five ticked service-only client rows
from its checked count. That calculation omitted 19 mobile-only rows outside
L/Q, discarded local portions of mixed rows, and retained untagged remote rows.
It is not a valid denominator for this scope.

`[auth-risk]` and `[hosted]` remain reference warnings, not scope or status fields.
Engines keep their own login and credentials, under architecture hard rule 1.
Providers without an available CLI or protocol double stay open or partial until
their allowed local behavior can be proved; a tag never permits credential access.
A54 has no earlier database to migrate. The existing N/A notes about assets,
unsupported platforms or a missing predecessor are retained for an honest
not-doable decision; this scope reconciliation does not mark them done.

## A. Threads and sidebar
- [x] A1 New thread: keeps current project and model/mode, unless the project has its own default | docs/user/thread-sidebar.md | w d m | S
- [x] A2 New thread in…: palette project picker | apps/web/src/components/CommandPalette.tsx | w d | S | web done
- [x] A3 Thread without project: starts with no project, can move machine before send | docs/user/thread-sidebar.md | w d m | M
- [x] A4 Scratch folders: dated per-thread folder kept after thread deletion | docs/user/thread-sidebar.md | s | S | server done
- [x] A5 Turn into project: adopts the folder in place, with sibling threads | packages/contracts/src/orchestrationV2.ts | w d s | M | server done | web done
- [x] A6 Start in background: sends and opens another draft, one worktree each | docs/user/thread-sidebar.md | w d | M | web done
- [x] A7 Send and new thread: keyed send that leaves a fresh draft | packages/contracts/src/keybindings.ts | w d | S | web done
- [x] A8 Multi-model fan-out: shift-click models, one thread and worktree each | apps/web/src/components/chat/useMultipleModelSend.ts | w d | M | web done
- [x] A9 New thread in this worktree: reuses an existing worktree | docs/user/thread-sidebar.md | w d | S | web done
- [ ] A10 Use last project: mobile default for new threads, toggleable | docs/user/thread-sidebar.md | m | S | scope: excluded | reason: mobile client only
- [x] A11 Pin and unpin: keeps thread above active work, scroll stays put | apps/web/src/components/Sidebar.tsx | w d m s | S
- [x] A12 Undo notices: 5-second undo for unpin, settle, snooze, archive, draft discard | apps/web/src/components/sidebar/SidebarThreadUndoNotice.tsx | w d m | M
- [x] A13 Drop files on a thread row: opens thread with files attached | docs/user/thread-sidebar.md | w d | S | web done
- [x] A14 Drag between sections: pin, unpin, settle, unsettle, wake with action badge | apps/web/src/components/Sidebar.drag.ts | w d | L
- [x] A15 Server-saved ordering: pinned and active order syncs across devices | packages/contracts/src/orchestrationV2.ts | w d m s | M
- [ ] A16 Arrange threads sheet: mobile drag handles, plus move up/down | apps/mobile/src/features/threads/ThreadArrangementSheet.tsx | m | M | scope: excluded | reason: mobile client only
- [x] A17 Regenerate title: new title from the conversation | docs/user/thread-sidebar.md | w d m s | S
- [x] A18 Title instructions: per-environment or per-project guidance | apps/web/src/components/settings/ThreadTitleInstructionsSettings.tsx | w d s | S | web done
- [x] A19 Rename thread: F2 on focused row, also via agents | docs/user/keyboard-focus.md | w d s | S
- [x] A20 Working section: folds threads waiting on subagents, watches, monitors | packages/contracts/src/settings.ts | w d m | M | web done
- [x] A21 Boring sidebar: active threads foldered by project | apps/web/src/components/sidebar/SidebarProjectFolderHeader.tsx | w d | M
- [x] A22 Multiline sidebar rows: optional taller rows | packages/contracts/src/settings.ts | w d | S
- [x] A23 Settle and un-settle: parks work, dismisses async questions, closes idle terminals | docs/user/thread-sidebar.md | w d m s | M
- [x] A24 Auto-settle rules: idle days, on merge, keep threads with a PR | packages/contracts/src/settings.ts | s | M | server done
- [x] A25 Per-thread auto-settle: Enabled or Disabled from thread menu | docs/user/thread-sidebar.md | w d m s | S
- [x] A26 Press-drag bulk settle: drag across rows to settle, unsettle or wake | docs/user/thread-sidebar.md | w d | M | web done
- [x] A27 Run-on-settle script: reclaims disk in the thread's own worktree | packages/contracts/src/t3ProjectFile.ts | s | S | server done
- [x] A28 Snooze presets: up to 8 duration or time-of-day options | apps/web/src/components/settings/SnoozePresetsSettings.tsx | w d m s | M | server done | web done
- [x] A29 Custom snooze: date/time or duration dialog | apps/web/src/components/CustomSnoozeDialog.tsx | w d m | S | web done
- [x] A30 Bulk snooze: applies to multi-selected threads | docs/user/thread-sidebar.md | w d | S | web done
- [x] A31 Wake rules: returns early on approval, answer, failure or your message | docs/user/thread-sidebar.md | w d m s | M | server done | web done
- [x] A32 Archive and archive panel: unarchive and browse history | apps/web/src/components/settings/ArchivedThreadsPanel.tsx | w d m s | S
- [x] A33 Delete thread: removes thread, side chats, pages and linked tasks | packages/contracts/src/orchestrationV2.ts | w d m s | M
- [x] A34 Mark unread: flags a thread | packages/contracts/src/orchestrationV2.ts | w d m s | S
- [x] A35 Confirmations: toggles for archive, delete, unpin | packages/contracts/src/settings.ts | w d | S | web done
- [x] A36 Copy reference/thread/ID: PR link first, then thread chip, then bare ID | docs/user/thread-sidebar.md | w d m | S | web done
- [x] A37 Palette thread search: title, branch, PR, project with frecency ranking | apps/web/src/components/CommandPalette.logic.ts | w d m | M
- [x] A38 Message search: all-words match, opens at the message, CJK-aware minimum | packages/contracts/src/orchestrationV2.ts | w d m s | L | server done | web done
- [x] A39 Find in thread: find bar with highlights and position | apps/web/src/components/chat/ThreadFindBar.tsx | w d s | M | web done
- [x] A40 Thread navigation keys: previous, next, jump 1–9 | packages/contracts/src/keybindings.ts | w d | S
- [x] A41 History navigation: back/forward with trackpad swipe | apps/web/src/components/HistorySwipeNavigation.tsx | w d | S
- [x] A42 Thread hover card: rich preview on hover | apps/web/src/components/ThreadHoverCard.tsx | w d | S
- [x] A43 Status indicators: working, limited, needs-you, request states | apps/web/src/components/ThreadStatusIndicators.tsx | w d m | M | web done
- [x] A44 Side chats: `/side`, `/btw` or + menu, separate tab with own permissions | apps/web/src/components/chat/SideChatPane.tsx | w d m | L | web done
- [x] A45 Bring back: sends side chat into the parent's next message | docs/user/thread-sidebar.md | w d | M | web done
- [x] A46 Fork thread: branches conversation, with portable fallback | packages/contracts/src/orchestrationV2.ts | w d s | L
- [x] A47 Provider switch mid-thread: budgeted context handoff to another provider | docs/user/portable-handoffs.md | w d m s | L
- [x] A48 Lineage view: related threads and workflow rows | apps/web/src/components/chat/ThreadRelationshipsControl.tsx | w d | M | web done
- [x] A49 Thread details card: PRs, servers, usage, scripts, editor actions | apps/web/src/components/chat/ThreadDetailsCard.tsx | w d m | M | web done
- [x] A50 Customize details: show/hide rows, reset, right-click access | apps/web/src/components/settings/ThreadDetailsItemsRow.tsx | w d | S | web done
- [x] A51 Local servers list: thread's ports with open and stop | apps/web/src/components/chat/ThreadServersPanel.tsx | w d s | M | server done | web done
- [x] A52 Timeline minimap: overview navigation strip | apps/web/src/components/chat/TimelineMinimap.tsx | w d | M
- [x] A53 Visit watermark: marks where you last read | apps/web/src/components/chat/ThreadVisitWatermark.tsx | w d s | S | web done
- [ ] A54 V1 thread migration: copies old database, imports transcripts in stages | docs/user/thread-migration.md | s d | L | status: not_doable | reason: Orbyn has no predecessor thread database to migrate; inventing a legacy format would not reproduce an actual upgrade
- [x] A55 Limited state: shows provider limit stop, resume manually | apps/web/src/components/chat/UsageLimitRecoveryBanner.tsx | w d m | M | web done
- [x] A56 Resume at reset: scheduled continuation, default optional | packages/contracts/src/settings.ts | w d m s | M | web done
- [x] A57 Snooze until reset: hides thread until allowance returns | packages/contracts/src/settings.ts | w d m s | S | web done
- [x] A58 Continue after restarts: resumes active threads, stops after 3 automatic tries | docs/user/updating.md | s | L | web done
- [x] A59 Force stop: kills unresponsive thread | apps/web/src/components/chat/useForceStopThread.ts | w d s | M | web done
- [ ] A60 Background work view: mobile sheet of running background work | apps/mobile/src/features/threads/ThreadBackgroundWorkSheet.tsx | m | M | scope: excluded | reason: mobile client only
- [ ] A61 Sidebar grouping and sort: repository/path/separate; project and thread sort; overrides | packages/contracts/src/settings.ts | w d m | M | web: project and thread sort; grouping needs one project per repository across checkouts, which Orbyn does not model
- [x] A62 Subagent stop cascade: stopping a parent stops delegated children | docs/user/thread-sidebar.md | w d m s | M | server done | web done
- [x] A63 Project filter menu: header button limits the thread list to one or several projects, with project search, Shift+Enter to add or remove a project, favicon stack on the button and a context-key shortcut to open that project's settings | apps/web/src/components/Sidebar.tsx | w d | M | web done
- [x] A64 Project folder menu: right-click or pen button on a project folder offers new thread, copy path and project settings | apps/web/src/components/Sidebar.tsx | w d | S | web done
- [x] A65 Thread menu extras: Find in thread, New thread on this branch, Filter by this project (toggles off when active), Copy branch, Copy path, Project settings shortcut | apps/web/src/components/threadActionMenu.logic.ts | w d m | S
- [x] A66 Draft rows: unsent drafts show in the list with an unsent marker and a discard button; discard offers undo with text and attachments restored | apps/web/src/components/sidebar/SidebarDraftBlock.tsx | w d | S | web done
- [x] A67 Wake now and dismiss Woke: snoozed rows have a wake-now button; a thread that woke early shows a dismissible Woke badge | apps/web/src/components/sidebar/SidebarThreadRow.tsx | w d | S | web done
- [x] A68 Older settled paging: settled shelf loads older threads in pages, shows hidden count and a show-more control | apps/web/src/components/Sidebar.tsx | w d m | M
- [x] A69 Sidebar sizing and toggle: drag-resizable thread sidebar with remembered width, collapse toggle, and a header-docked toggle command | apps/web/src/components/threadSidebarWidth.ts | w d | S
- [x] A70 Jump hints: number badges appear on the first nine rows while the jump modifier is held | apps/web/src/components/sidebar/SidebarThreadRow.tsx | w d | S
- [x] A71 Provider update pill: sidebar capsule announces provider CLI updates with a dismiss control, separate from the desktop update pill | apps/web/src/components/sidebar/SidebarProviderUpdatePill.tsx | w d | S | web done
- [x] A72 Landing states: no-projects hero, no-active-thread state, hosted empty state and draft hero with project name and heading | apps/web/src/components/NoProjectsHero.tsx | w d | S
- [x] A73 Header panel toggles: buttons for thread details panel, terminal drawer and right panel; right panel becomes a sheet at narrow widths | apps/web/src/components/chat/PanelLayoutControls.tsx | w d | S
- [ ] A74 Hide environment threads: per-environment switch hides that server's threads from the sidebar, plus reconnect and disconnect failure banners | apps/web/src/components/chat/useSystemComposerBanners.tsx | w d | S | out of scope: needs linked environments | scope: excluded | reason: linked environments
- [x] A75 Open thread holds its section: the thread you are in never jumps between Active, Finished and Settled until you leave it; a held thread that starts running becomes Active | src/sidebar-sections.ts | w d | S | beyond T3 | web done | scope: excluded | reason: extra route-held sidebar placement is absent from T3 Sidebar partitioning; remove the existing deviation before the final walkthrough
- [x] A76 Edit sent prompt: forks before that message into a new thread in the same folder and puts the text back in its composer; files are not rewound | docs/rewind.md | w d s | S | beyond T3 | web done | scope: excluded | reason: T3 user messages offer Edit from here and assistant replies offer Fork from this response; the added user-message fork action is being removed in PR 72

## B. Composer
- [x] B1 Message limit: 120,000 characters, oversize draft retained | docs/user/composer.md | w d m | S | server done | web done
- [x] B2 Large paste to attachment: 32 KiB or more becomes a file, shift-paste keeps it editable | docs/user/composer.md | w d | S
- [x] B3 Live Markdown styling: rich editor that keeps literal markers | apps/web/src/components/ComposerPromptEditorTiptap.tsx | w d m | L | web done
- [x] B4 List and quote editing: Shift+Enter continue, Tab nest | docs/user/composer.md | w d | M
- [ ] B5 Code block editing: indent, language picker, exit rules | apps/web/src/components/chat/ComposerCodeBlockNodeView.tsx | w d | M
- [x] B6 Attachments: 100 files; 10 MiB per image, 80 MiB images total, 50 MiB other | docs/user/composer.md | w d m s | L | server done | web done
- [x] B7 Upload lifecycle: starts on add, retry or remove, blocks send until done | apps/web/src/components/chat/ComposerAttachmentStrip.tsx | w d m | M | server done | web done
- [ ] B8 HEIC conversion and resizing: JPEG conversion, shrinks oversized photos | docs/user/composer.md | w d m | M
- [x] B9 Drag and paste images: intake into web composer | apps/web/src/components/chat/useComposerAttachmentIntake.ts | w d | S
- [ ] B10 System share sheet: send files to T3 from other apps | apps/mobile/src/features/sharing/IncomingShareProvider.tsx | m | M | scope: excluded | reason: mobile client only
- [x] B11 Follow-up behavior: queue or steer default | packages/contracts/src/settings.ts | w d m | M
- [x] B12 Send shortcut modes: Enter, Mod+Enter multiline only, Mod+Enter | packages/contracts/src/settings.ts | w d | S
- [x] B13 Opposite action: modifier or long-press flips queue/steer | docs/user/composer.md | w d m | S
- [x] B14 Queued messages: persisted on server, shown as dashed rows | apps/web/src/components/chat/QueuedRunsControl.tsx | w d m s | L
- [x] B15 Queue actions: send now, edit in composer, remove | apps/web/src/components/chat/useQueuedRunEdit.ts | w d m s | M | server done | web done
- [x] B16 Held queue and resume: preserved after stop or restart | docs/user/composer.md | w d m s | M | server done | web done
- [x] B17 Steer oldest queued: shortcut, draft untouched | packages/contracts/src/keybindings.ts | w d | S
- [ ] B18 Offline mobile queue: local copies, resumes on reconnect | docs/user/composer.md | m | L | scope: excluded | reason: mobile client only
- [x] B19 Interrupt button: stops running turn when draft empty | apps/web/src/components/chat/ComposerPrimaryActions.tsx | w d m | S | web done
- [x] B20 Custom models: add unlisted model, rename built-ins via settings.json | apps/web/src/components/settings/CustomModelEditor.tsx | w d s | M | server done | web done
- [x] B21 Remembered model defaults: provider, model and options carry to new threads | docs/user/composer.md | w d m | S | web done
- [x] B22 Model picker: providers rail, search, favorites, number jumps | apps/web/src/components/chat/ProviderModelPicker.tsx | w d m | L
- [x] B23 Model visibility and order: hide, reorder, favorite per instance | packages/contracts/src/settings.ts | w d s | M
- [x] B24 Traits picker: effort, thinking, speed, context options per model | apps/web/src/components/chat/TraitsPicker.tsx | w d m | M: effort, Codex service tier and Claude fast mode per model; neither engine reports thinking or context choices
- [x] B25 Effort display: label or bars, with shortcuts | apps/web/src/components/chat/EffortGlyph.tsx | w d | S | web done
- [x] B26 Permission mode: Supervised, Auto-accept edits, Auto, Full access | docs/user/permission-modes.md | w d m s | L
- [x] B27 Plan mode toggle: plan or build | packages/contracts/src/orchestrationV2.ts | w d m s | M
- [ ] B28 Cite in composer: quote assistant text with a comment | apps/web/src/components/chat/AssistantCitationChip.tsx | w d | L
- [x] B29 Prompt recall: up/down through sent prompts | apps/web/src/components/chat/composerPromptHistory.ts | w d | S
- [x] B30 Edit from here: rewind with or without file restore | apps/web/src/components/chat/useTimelineRewind.ts | w d s | L | web done
- [x] B31 Prompt stash: save/restore drafts, uploads kept 24 hours | apps/web/src/components/chat/ComposerStashMenu.tsx | w d | M
- [ ] B32 iPhone voice input: on-device transcription, 5-minute limit, iOS 26+ | apps/mobile/src/features/voice-input/VoiceInputProvider.tsx | m | L | scope: excluded | reason: mobile client only
- [ ] B33 Microphone ranking: priority across device kinds | apps/mobile/src/features/settings/SettingsMicrophoneRouteScreen.tsx | m | M | scope: excluded | reason: mobile client only
- [x] B34 Slash commands: `/` menu with T3 and provider commands | apps/web/src/components/chat/ComposerCommandMenu.tsx | w d m | M | server done | web done
- [x] B35 Skills: `$` menu, also in slash menu by toggle | apps/web/src/components/chat/SkillInlineText.tsx | w d m | M | server done | web done
- [x] B36 Restart agent session: reloads skills, plugins and MCP config | apps/web/src/components/CommandPalette.tsx | w d s | S | web done
- [x] B37 `/compact`: manual compaction, also from context meter | docs/user/composer.md | w d m s | M | server done | web done
- [x] B38 `/goal`: runs across turns until met; clear, pause, resume vary by provider | docs/user/composer.md | w d m s | L | web done
- [x] B39 `/usage-limits`: inline snapshot above composer | docs/user/usage.md | w d m | S
- [ ] B40 Inline context chips: terminal, review comment, annotation, file at cursor | apps/web/src/components/ContextChip.tsx | w d m | L
- [x] B41 PR chips: `#` browse, number and text search | docs/user/composer.md | w d | M | web done: a Markdown link in the prompt, not a chip | status: partial | remaining: a prompt link is implemented; the referenced PR chip is not
- [x] B42 Thread chips: `@` lookup, on-demand read by the agent | apps/web/src/components/ThreadContextChip.tsx | w d m | M | web done: a Markdown link in the prompt, not a chip | status: partial | remaining: a prompt link is implemented; the referenced thread chip is not
- [x] B43 Drag threads to composer: multi-select, cross-environment transcript file | apps/web/src/components/chat/composerThreadImport.ts | w d | M | web done: a thread link, as there is one environment | status: partial | remaining: a local thread link is implemented; transcript-file drag is not established | scope: mixed | local: drag local threads into a composer | excludes: cross-environment transcript access
- [x] B44 Image shelf and chips: thumbnails plus inline references | apps/web/src/components/chat/ComposerImageThumbnail.tsx | w d | M
- [ ] B45 Chip clipboard: copy/paste keeps chips, refetches files | packages/contracts/src/composerContextClipboard.ts | w d | L
- [x] B46 Readable copy: Markdown output with links replacing chips | apps/web/src/components/chat/MessageCopyButton.tsx | w d | S
- [ ] B47 Question attachments: files in custom answers, kept per question | docs/user/question-attachments.md | w d m s | M
- [x] B48 Pending approval actions: approve or reject inline | apps/web/src/components/chat/ComposerPendingApprovalActions.tsx | w d m | M | web done
- [x] B49 Text decline to Claude: typed reply rejects with feedback | docs/user/permission-modes.md | w d m | S | web done
- [x] B50 Question panel: async question answer or dismiss | apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx | w d m | M
- [ ] B51 Secret request card: agent asks for a secret, you answer | apps/web/src/components/chat/SecretRequestCard.tsx | w d m s | M | scope: excluded | reason: secret brokering
- [ ] B52 Link request card: agent asks to link a machine | apps/web/src/components/chat/LinkRequestCard.tsx | w d m s | M | scope: excluded | reason: linking another machine
- [x] B53 Context window meter: usage bar with compaction tick | apps/web/src/components/chat/ContextWindowMeter.tsx | w d | M
- [ ] B54 Compact chip: offered on return after prompt cache expiry | docs/user/providers-claude.md | w d | M
- [x] B55 Composer banners: provider, update, clone, retry notices | apps/web/src/components/chat/ComposerBannerStack.tsx | w d | M
- [x] B56 Persistent composer context: keeps branch controls after first send | packages/contracts/src/settings.ts | w d | S
- [x] B57 Compact controls menu: narrow composers fold model, traits, permission and plan controls into one overflow menu | apps/web/src/components/chat/CompactComposerControlsMenu.tsx | w d | S | web done
- [x] B58 Text direction: each composer block gets left-to-right or right-to-left direction from its own text | apps/web/src/composer-text-direction.ts | w d | S
- [x] B59 Composer editor switches: turn live Markdown styling off, show or hide skills in the slash menu (skills still appear with `$`), show context meter | packages/contracts/src/settings.ts | w d m | S
- [ ] B60 Compact composer on phone: sheets for command popover, queued-message edit, attachment button and error notice | apps/mobile/src/features/threads/ComposerCommandPopover.tsx | m | M | scope: excluded | reason: mobile client only
- [x] B61 Steer delivery states: each mid-turn message reports pending, delivered or failed by id; a failed one returns to the queue; engines with no mid-turn input hold it for the next turn | src-tauri/src/providers/steering.rs | w d s | M | web done: the reply says delivered or queued, with no per-message mark in the timeline | status: partial | remaining: per-message pending, delivered and failed timeline marks are missing
- [ ] B62 Response style packs: per-thread output-saving packs added as one folded block only when the selection changes and every N messages | src/token-saver.ts | w d | M | beyond T3 | scope: excluded | reason: no matching T3 response-pack selector or reinjection workflow in the inspected reference; preserve engine output-style metadata without adding this surface
- [ ] B63 Workflow recipes: local step lists (prompt, slash command, check, approval) with a dry run showing supported, fallback or blocked per engine; run goes through the normal queue | docs/recipes.md | w d s | M | beyond T3 | scope: excluded | reason: no matching T3 recipe editor or composite step runner in the inspected reference; ordinary project actions and slash commands remain separately required
- [ ] B64 Turn checks: optional run of the checkout's own quick check after a clean turn; a failure queues one editable fix message, never a loop; needs trusted folder | src-tauri/src/checks.rs | w d s | M | beyond T3 | scope: excluded | reason: T3 post-turn refresh is not automatic checkout validation and repair-prompt generation; no matching surface was found
- [ ] B65 Prompt context chips: documents and folders become context blocks; sent blocks render as read-only chips that open the file, reveal the path or show the text | src/message-attachments.ts | w d | M | beyond T3 | scope: mixed | local: typed sent file and attachment context chips with file-opening and attachment-preview actions, as in apps/web/src/components/chat/UserMessageContextChips.tsx | excludes: additional context-block provenance surfaces without a T3 counterpart

## C. Timeline and rendered output
- [x] C1 Live streaming: per-turn or per-paragraph mode | packages/contracts/src/settings.ts | w d m s | L | web done
- [x] C2 Timeline follow and anchoring: position restore and sticky scroll | apps/web/src/components/chat/useTimelineFollow.ts | w d m | L
- [x] C3 Tool activity groups: expandable summaries with category counts | apps/web/src/components/chat/TimelineWorkGroupRows.tsx | w d m | L
- [ ] C4 Orchestrator summaries: action-specific wording, failures not counted | docs/user/activity-log.md | w d | M
- [x] C5 Command output: live tail, exit codes, full subscription | apps/web/src/components/chat/CommandOutputPanel.tsx | w d m s | M
- [x] C6 Open diff from tool row: review a file change | docs/user/activity-log.md | w d | S
- [x] C7 Item inspector: raw turn item view | apps/web/src/components/chat/V2ItemInspector.tsx | w d s | M
- [x] C8 Proposed plan card: collapse, copy, save/download, follow-up | apps/web/src/components/chat/ProposedPlanCard.tsx | w d m | M
- [x] C9 Plan follow-up banner: implement plan from a banner | apps/web/src/components/chat/ComposerPlanFollowUpBanner.tsx | w d | M
- [ ] C10 Claude task lists: Tasks row via env flag | docs/user/providers-claude.md | w d | S
- [x] C11 Subagent bar: live delegated agents and tooltips | apps/web/src/components/chat/ProviderSubagentBar.tsx | w d m | M
- [x] C12 Markdown renderer: streaming blocks, tables, details, direction handling | apps/web/src/components/ChatMarkdown.tsx | w d m | L
- [x] C13 Code blocks: highlighting and copy | apps/web/src/components/chat/MarkdownCodeBlock.tsx | w d m | M
- [x] C14 Math: opt-in TeX, inline and block | apps/web/src/components/chat/MarkdownMath.tsx | w d m | M
- [x] C15 Mermaid: rendered diagrams | apps/web/src/components/chat/MermaidDiagram.tsx | w d | M
- [x] C16 File links: line-aware opening in viewer | apps/web/src/components/chat/MarkdownFileLink.tsx | w d m | M
- [x] C17 Thread links: render and navigate | apps/web/src/components/chat/MarkdownThreadLink.tsx | w d | S
- [x] C18 External link menu: open target and context actions | apps/web/src/components/chat/MarkdownExternalLink.tsx | w d | S
- [ ] C19 Media in messages: image gallery, video, save/copy path | apps/web/src/components/chat/ChatMarkdownMedia.tsx | w d m | M
- [x] C20 Image lightbox: zoomable expanded view | apps/web/src/components/chat/ExpandedImageDialog.tsx | w d | S
- [ ] C21 HTML renders: sandboxed agent pages with theme and zoom | apps/web/src/components/chat/HtmlRenderFrame.tsx | w d m s | L
- [ ] C22 Render publish: embeds local images, deleted with thread | apps/server/src/htmlRender | s | M
- [ ] C23 Render verification: headless screenshots, one 120 MB browser download | docs/user/html-renders.md | s | M
- [ ] C24 MCP Apps: interactive tool UI inline, Codex only today | apps/web/src/components/chat/McpAppFrame.tsx | w d m s | L
- [ ] C25 MCP App controls: tool-call and message approvals, full screen | docs/user/html-renders.md | w d m | L
- [ ] C26 MCP App model context: latest note sent with next message | packages/contracts/src/mcpApps.ts | w d m s | M
- [x] C27 Elapsed timers: per-turn agent timing | apps/web/src/components/chat/AgentElapsed.tsx | w d | S
- [x] C28 Status line: current activity beneath the timeline | apps/web/src/components/chat/ThreadStatusLine.tsx | w d | S
- [x] C29 Accessibility announcers: activity and background thread announcements | apps/web/src/components/chat/ThreadActivityAnnouncer.tsx | w d | S
- [x] C30 Word wrap and chat width: comfortable, wide, full | packages/contracts/src/settings.ts | w d | S
- [ ] C31 Right panel tabs: add-tab menu (Browser, Terminal, Files, Diff, Pull request, Linked pull requests, Device, Side chat), mute tab, close, maximize, resize handle, sheet on small screens | apps/web/src/components/RightPanelTabs.tsx | w d | M
- [x] C32 Proactive panels: opt-in setting opens the linked PR, or the Changes panel after a turn touching at least 3 files or 50 lines; a panel you opened or closed wins | apps/web/src/hooks/useProactivePanels.ts | w d | M
- [x] C33 Thread end lines: sync state, reconnect, goal and status lines at the end of the timeline share one family with icon, detail and actions | apps/web/src/components/chat/ThreadNow.tsx | w d m | S | web done
- [x] C34 Changed files tree in timeline: per-turn file list with open-diff action | apps/web/src/components/chat/ChangedFilesTree.tsx | w d | S
- [x] C35 Error banner: thread-level error with dismiss and retry actions | apps/web/src/components/chat/ThreadErrorBanner.tsx | w d m | S
- [x] C36 Lifecycle rows: system dividers and lifecycle rows mark restarts, handoffs and context boundaries | apps/web/src/components/chat/V2LifecycleRow.tsx | w d m | S | web done
- [ ] C37 Sentence tool trace: each tool call is a verb-object row with kind icon; calls group in fives with a count summary; live view bounded to 30 rows; turn folds to a summary at the end | src/tool-trace.ts | w d | L
- [x] C38 Bounded tool snapshots: input preview 4 KiB, output preview 8 KiB, UTF-8-safe truncation notice, 64 snapshots per run | docs/providers.md | s | S | server done: arguments 16 KiB rather than 4, because cut JSON no longer parses
- [x] C39 Delta coalescing: text deltas merged for 33 ms or 8 KiB before sending, only new text per event | src-tauri/src/providers.rs | s | S | server done
- [ ] C40 Rich question content: agent questions render Markdown, charts and sanitised SVG or static HTML in an isolated root; remote images become links | src/rich-markdown.ts | w d | M | beyond T3 | scope: mixed | local: question prose uses Markdown including supported Mermaid and media, as in apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx and ChatMarkdown.tsx | excludes: a separate arbitrary HTML or SVG question surface and a blanket remote-image-to-link rule not established by T3 | status: partial | remaining: PR74 renders question Markdown and Mermaid with a real-service browser proof; media and native evidence remain unverified

## D. Files, search and attachments
- [x] D1 File browser panel: tree explorer in right panel | apps/web/src/components/files/FileBrowserPanel.tsx | w d m | L | web done
- [x] D2 Go to file: quick picker | apps/web/src/components/files/ProjectFilePicker.tsx | w d | M
- [x] D3 Project content search: full-text dialog | apps/web/src/components/search/ProjectContentSearchDialog.tsx | w d s | L
- [x] D4 Show ignored files: separate listing | packages/contracts/src/rpc.ts | s | S | server done
- [x] D5 Edit and save files: save coordination, conflict revision tracking | apps/web/src/components/files/fileSaveCoordinator.ts | w d s | L
- [x] D6 Source preview: read-only highlighted view | apps/web/src/components/files/ReadOnlySourcePreview.tsx | w d m | M | web done
- [x] D7 Large text viewer: worker-backed partial viewing | apps/web/src/components/files/LargeTextViewer.tsx | w d | M | web done: byte ranges rather than a worker
- [x] D8 Markdown preview: rendered/raw toggle | apps/web/src/components/files/FileMarkdownPreview.tsx | w d m | S
- [x] D9 CSV/TSV tables: virtualized delimited view | apps/web/src/components/files/DelimitedTablePreview.tsx | w d m | M
- [x] D10 PDF viewer: embedded pages, native on mobile | apps/web/src/components/files/PdfViewer.tsx | w d m | L | web done: the browser's own PDF view
- [ ] D11 Office viewer: Open XML documents via worker | apps/web/src/components/files/OfficeViewer.tsx | w d | L
- [x] D12 Notebook preview: renders notebooks | apps/web/src/components/files/NotebookPreview.tsx | w d | M
- [x] D13 Mermaid file preview: renders diagram files | apps/web/src/components/files/MermaidViewer.tsx | w d | S
- [x] D14 Font viewer: font file samples | apps/web/src/components/files/FontViewer.tsx | w d | M | web done
- [x] D15 Binary viewer: hex-style inspection | apps/web/src/components/files/BinaryViewer.tsx | w d | M | web done
- [x] D16 Audio/video/image previews: playback and decoded images | apps/web/src/components/files/AudioPreview.tsx | w d m | M | web done
- [x] D17 HTML file preview: sandboxed render plus source mode | apps/web/src/components/files/BrowserDocumentFrame.tsx | w d m | M
- [ ] D18 ZIP browsing: up to 50 MB shown as folder list | docs/user/composer.md | w d m | M
- [ ] D19 File comments: annotations feed review chips | apps/web/src/components/files/fileCommentAnnotations.ts | w d | M
- [x] D20 Tree drag mention: drag file into composer | apps/web/src/components/files/fileTreeDragMention.ts | w d | S | web done
- [ ] D21 Outside-workspace files: read-only, isolated HTML | docs/user/composer.md | w d s | M
- [x] D22 Open in editor: favorite editor picker including JetBrains | apps/web/src/components/chat/OpenInPicker.tsx | w d s | M | server done | web done
- [x] D23 File context menu: Open, Reveal in Finder/File Explorer/Files (label by OS) and Open with any available editor | apps/web/src/fileContextMenu.ts | w d | S | web done
- [x] D24 Editor catalog: 20 editors plus the system file manager (Cursor, Trae, Kiro, VS Code, Insiders, VSCodium, Zed, Antigravity, ten JetBrains IDEs) detected per host by command, each with path, goto or line-column launch style | packages/contracts/src/editor.ts | s w d | M | server done | web done
- [ ] D25 Favorite editor: last used editor remembered per browser, fallback to first available, menu shows its shortcut, hidden when the host cannot launch editors | apps/web/src/editorPreferences.ts | w d | S
- [ ] D26 Open in editor over remote: for non-local environments the picker builds editor links (VS Code family, Cursor, Zed, JetBrains) to the host via SSH alias, Tailscale or mDNS name, or shows unavailable | apps/web/src/remoteOpen.ts | w d | M | scope: excluded | reason: remote editor access
- [ ] D27 Attached file viewer controls: Copy contents, Save file, view toggle; on mobile Save or share and Open in file viewer; ZIP entries can be added to chat on mobile | docs/user/composer.md | w d m | M
- [ ] D28 Mobile file browser: tree, source scroll position, image, video, web, ZIP and delimited previews with error state | apps/mobile/src/features/files/FileTreeBrowser.tsx | m | L | scope: excluded | reason: mobile client only
- [ ] D29 Document viewer: PDF, Word and spreadsheet files open in a tab; zips size-checked before parsing; Word rendered in an isolated root | src/office-viewer.ts | w d | L | beyond T3 | scope: local | local: PDF, Word and spreadsheet previews in the existing file surface, as in apps/web/src/components/files/OfficeFilePreview.tsx; preserve bounded archive handling without prescribing T3 implementation technique
- [ ] D30 Mockup sketcher: draw a sketch and attach it as an image | src/sketch.ts | w d | M | beyond T3 | scope: excluded | reason: no drawing-and-attachment sketcher in the inspected T3 composer or file surfaces; HTML mockups and screenshot annotations are different existing features

## E. Diffs, checkpoints and revert
- [x] E1 Turn checkpoints: hidden git ref at each turn end | apps/server/src/checkpointing/CheckpointStore.ts | s | L | server done
- [x] E2 Turn diff: shows only that turn's work | docs/user/source-control.md | w d m s | L
- [x] E3 Full thread diff: cumulative view | packages/contracts/src/orchestrationV2.ts | w d m s | M
- [x] E4 Branch comparison: everything against base | apps/server/src/review/ReviewService.ts | w d m s | M
- [x] E5 Commits source: newest 100, one commit at a time | docs/user/source-control.md | w d s | M
- [x] E6 Commit link routing: opens local commit in Diff pane | docs/user/source-control.md | w d | M | web done: other commits go to the host
- [x] E7 Diff layout: stacked or split | packages/contracts/src/settings.ts | w d | S
- [x] E8 Diff preferences: collapse files, ignore whitespace, color scheme | packages/contracts/src/settings.ts | w d | S
- [x] E9 Diff file tree: navigable with hide-tests filter | apps/web/src/components/diffs/DiffFileTree.tsx | w d | M
- [ ] E10 Inline diff comments: annotations to composer chips | apps/web/src/components/diffs/DiffCommentAnnotation.tsx | w d m | L
- [x] E11 Find in diff: search within diff | docs/user/keybindings.md | w d | M
- [x] E12 Copy diff path: per-file button | apps/web/src/components/DiffFilePathCopyButton.tsx | w d | S
- [x] E13 Restore workspace: rollback with shared-directory refusal | packages/contracts/src/orchestrationV2.ts | w d s | L | server done | web done
- [x] E14 Conversation rewind: trims provider history where supported | docs/user/composer.md | w d s | L
- [ ] E15 Codex thread revert: native rollback integration | apps/server/src/provider/CodexThreadRevert.ts | s | M
- [ ] E16 Native mobile diff: custom diff view with word diffs | apps/mobile/src/features/review/ReviewSheet.tsx | m | L | scope: excluded | reason: mobile client only
- [x] E17 Diff status markers: per-file added, modified, deleted, renamed badges and plus/minus counts | apps/web/src/components/diffs/DiffFileStatus.tsx | w d m | S
- [ ] E18 Large diff loading: very large uncommitted diffs load files as you scroll; find covers loaded files only | docs/user/keybindings.md | w d | S
- [x] E19 Write-attributed changes: a turn's change list holds only files the thread declared (begin and complete handshake) or the engine reported, frozen at tool completion; never inferred from status; caps 200 paths, 1 MiB per file, 32 MiB per turn | docs/turn-changes.md | s w | L | beyond T3 | server done: both ends kept, with a restore and `orbyn_track_files` as the handshake | web done | scope: mixed | local: authored-only turn changes for review, as in docs/user/source-control.md and apps/server/src/checkpointing/CheckpointDiffQuery.ts; independent core attribution and retention remain internal | excludes: the extra per-file historical Restore control | status: partial | remaining: remove the visible per-file restore deviation via PR 72 and verify the integrated package

## F. Source control, worktrees and pull requests
- [x] F1 GitHub connection: saved token, env token, or gh | docs/user/source-control.md | w d s | M | server done, through `gh` only: saved and env tokens stay out under rule 1 | web done | scope: mixed | local: forge access through the unmodified gh CLI | excludes: app-held or app-read forge tokens
- [x] F2 GitHub Enterprise: custom host support | docs/user/source-control.md | s | M | server done
- [ ] F3 Multi-account host picker: account per host, host off | apps/web/src/components/settings/SourceControlHostSettings.tsx | w d s | M | scope: mixed | local: enable or disable a source-control host | excludes: account picker and account management
- [ ] F4 GitHub app sign-in: in-app access and notices | packages/source-control-github/src/GitHubAppSignIn.ts | w d s | M | scope: excluded | reason: in-app sign-in
- [x] F5 Forgejo/Gitea: fj then tea, Codeberg included | packages/source-control-forgejo/src/ForgejoCli.ts | s | M | server done, through `tea` only
- [x] F6 GitLab: glab-based merge requests | packages/source-control-gitlab/src/GitLabCli.ts | s | M | server done
- [ ] F7 Bitbucket: access token or account email plus API token | packages/source-control-bitbucket/src/BitbucketApi.ts | w d s | M | [auth-risk] no CLI exists, and this needs a stored token | scope: excluded | reason: stored forge credentials; no CLI route in this reference
- [x] F8 Azure DevOps: az CLI integration | packages/source-control-azure-devops/src/AzureDevOpsCli.ts | s | M | server done
- [ ] F9 GitCafe: API token or cafe login | packages/source-control-gitcafe/src/GitCafeApi.ts | w d s | M | scope: excluded | reason: forge login or stored API token
- [x] F10 Rescan: rediscover hosts and auth | packages/contracts/src/rpc.ts | w d s | S | server done | web done
- [x] F11 New project: repo with README, icon, first commit, optional private publish | docs/user/source-control.md | w d m s | M | server done | web done
- [x] F12 Add existing folder: picker with filesystem browse | apps/web/src/components/CommandPaletteAddProject.tsx | w d m s | M | server done | status: partial | remaining: the row records service completion without client evidence
- [x] F13 Clone project: background clone, prompt early, retry and cancel | apps/web/src/components/ProjectCloneToastCoordinator.tsx | w d m s | L | server done | web done: Cancel, Retry and the reason on a card that stays
- [x] F14 Clone SSH fallback: HTTPS when SSH is refused | docs/user/source-control.md | s | S | server done
- [x] F15 Publish repository: create remote, push commits | packages/contracts/src/rpc.ts | w d s | M | server done | web done
- [x] F16 Initialize Git: vcs init from project | packages/contracts/src/rpc.ts | w d s | S | server done | status: partial | remaining: the row records service completion without client evidence
- [x] F17 Git actions: commit, push, create PR and combinations with phases | apps/web/src/components/GitActionsControl.tsx | w d m s | L | server done | web done
- [ ] F18 AI commit and PR text: generated messages, titles, descriptions | apps/server/src/textGeneration/TextGeneration.ts | s | M
- [ ] F19 Writing style: repo conventions or custom, follows templates | apps/web/src/components/settings/SourceControlWritingSettings.tsx | w d m s | M
- [x] F20 Branch switcher and create: picker with ref listing | apps/web/src/components/BranchPicker.tsx | w d m s | M | server done | web done
- [ ] F21 Environment mode selector: local vs new worktree, environment choice | apps/web/src/components/BranchToolbarEnvModeSelector.tsx | w d m | M | scope: mixed | local: local checkout versus new sibling worktree | excludes: remote environment choice
- [x] F22 Worktree creation: per thread with base branch | apps/web/src/components/WorktreeBaseBranchPicker.tsx | w d m s | L | server done | web done
- [ ] F23 Worktree setup scripts: progress card, cancel | apps/web/src/components/chat/WorktreeSetupCard.tsx | w d s | M
- [x] F24 Previous worktree: resume earlier worktree | apps/web/src/components/PreviousWorktreeItemContent.tsx | w d | S | web done
- [x] F25 Branch naming: static, semantic or custom | apps/web/src/components/settings/BranchNamingSettings.tsx | w d m s | M | server: static prefix only; semantic and custom need text generation | status: partial | remaining: semantic and custom branch naming are missing
- [x] F26 Worktree location: custom absolute directory | docs/user/project-settings.md | w d s | S | server done | web done | scope: excluded | reason: owner requires the fixed sibling worktree location, with no custom-location control | evidence: real orbynd browser regression verifies removed control/search result, rejected API edits and sibling worktree creation; Core regressions retain ignored legacy values and preserve existing registered worktrees in place; isolated packaged macOS screen and search confirm removal, Windows GUI unverified
- [x] F27 Submodule policy: recursive, top level, skip | docs/user/project-settings.md | w d s | S | server done | web done
- [x] F28 Start from origin: new worktrees use remote head | packages/contracts/src/settings.ts | s | S | server done
- [x] F29 Automatic pull: fast-forward clean default branch | docs/user/project-settings.md | w d m s | M | server done | web done
- [x] F30 Storage cleanup: worktree rules, keep-when policy, reports | apps/server/src/storageCleanup.ts | w d m s | L | server done | web done
- [x] F31 PR list page: grouped filters across environments, quick actions | apps/web/src/components/pullRequest/PullRequestsPage.tsx | w d m s | L | server done | web done
- [x] F32 PR summary tab: description, state, editing | apps/web/src/components/pullRequest/PullRequestSummaryTab.tsx | w d m | M | server done | web done
- [x] F33 PR timeline: activity with filters | apps/web/src/components/pullRequest/PullRequestTimelineTab.tsx | w d m | M | server done | web done
- [x] F34 PR code tab: file review with revisions | apps/web/src/components/pullRequest/PullRequestCodeTab.tsx | w d m | L | server done | web done: files, viewed marks, line comments and one commit at a time; comments stay on the whole change
- [x] F35 Checks popover: status detail, fork workflow approval | apps/web/src/components/pullRequest/PullRequestChecksPopover.tsx | w d m | M | server done | web done
- [x] F36 Review submission: line drafts, submit review | apps/web/src/components/pullRequest/PullRequestReviewForm.tsx | w d m s | L | server done | web done
- [x] F37 Comments and threads: reply, edit, resolve, react | apps/web/src/components/pullRequest/PullRequestCommentForm.tsx | w d m s | L | server done | web done
- [x] F38 Reviewers and labels: search and set | apps/web/src/components/pullRequest/PullRequestReviewerPicker.tsx | w d m s | M | server done | web done
- [x] F39 Merge actions: method choice, auto-merge, revert PR, bulk close | apps/web/src/components/pullRequest/PullRequestDetailActions.tsx | w d m s | L | server done | web done
- [x] F40 Remove agent credits: strips agent lines on merge | packages/source-control-core/src/mergeMessage.ts | w d m s | S | server done | web done
- [x] F41 Files viewed: GitHub-synced or server-kept marks | apps/web/src/components/pullRequest/filesViewedStore.ts | w d m s | M | server done | web done
- [ ] F42 Review guides beta: AI stop-by-stop tour, shared on server | apps/web/src/components/pullRequest/PullRequestGuideTab.tsx | w d m s | L
- [ ] F43 Guide instructions and model: override per project | packages/contracts/src/settings.ts | w d s | S
- [ ] F44 Ask about stop: opens thread seeded with guide stop | docs/user/source-control.md | w | M
- [x] F45 Linked PRs panel: multiple PRs, stacks, unlink | apps/web/src/components/pullRequest/ThreadPullRequestsPanel.tsx | w d m s | L | server done | web done
- [x] F46 Automatic link: branch PR found, plus `gh`/`glab` detection | docs/user/source-control.md | s | M | server done
- [x] F47 PR watch: 2-minute polling wakes agent, with stop rules | apps/server/src/pullRequest | w d s | L | server done | web done
- [x] F48 GitHub stacks: position badge, layer navigation | apps/web/src/components/pullRequest/PullRequestStackHeader.tsx | w d m s | L | server done | web done
- [x] F49 Merge and rebase stack: submit or rebase layers | packages/source-control-github/src/githubStackActions.ts | w d s | L | server done | web done
- [ ] F50 PR routing: Read/Read-and-act via another environment | apps/web/src/components/settings/PullRequestRoutingSettings.tsx | w d m s | L | scope: excluded | reason: remote PR routing
- [x] F51 Work on PR: draft thread prepares branch worktree | apps/web/src/components/chat/usePullRequestDraftThread.ts | w d m s | M | server done | web done
- [ ] F52 Offline PR cache: mobile keeps loaded reviews readable | docs/user/source-control.md | m | M | scope: excluded | reason: mobile client only
- [x] F53 PR quick actions: Close, Reopen, Merge, Ready for review buttons on rows and detail header | apps/web/src/components/pullRequest/PullRequestSpeedActions.tsx | w d m s | M | server done | web done
- [x] F54 PR draft state: Convert to draft and Ready for review from the actions menu | apps/web/src/components/pullRequest/PullRequestActionsMenu.tsx | w d m s | S | server done | web done
- [x] F55 PR branch actions: Delete branch (with reconnect prompt), Revert changes, Allow edits from maintainers toggle | apps/web/src/components/pullRequest/PullRequestActionsMenu.tsx | w d s | M | server done | web done
- [x] F56 PR title and base: inline title editing with save error, base branch change, stacked marker, Update branch and Update with rebase | apps/web/src/components/pullRequest/PullRequestBaseBranch.tsx | w d s | M | server done | web done
- [x] F57 PR list filters: checks, draft, review state (approved, changes requested, review required, none), author, label, project and text; sort saved in the URL; compact menu on narrow widths; empty and unavailable states | apps/web/src/components/pullRequest/PullRequestListFilters.tsx | w d m | M | server done | web done
- [x] F58 Manual PR link: dialog with candidate picker by number or search to link a PR to a thread | apps/web/src/components/pullRequest/LinkPullRequestDialog.tsx | w d s | S | server done | web done
- [x] F59 PR checkout: check out in a worktree or locally, with a warning toast when the checkout is not on the latest commit | apps/web/src/components/pullRequest/PullRequestDetailActions.tsx | w d s | M | server done | web done
- [ ] F60 PR link menu: right-click a PR link for Copy link and Open on the host; hover preview card | apps/web/src/components/pullRequest/pullRequestLinkContextMenu.ts | w d | S | web: Copy link and Open on the host; no hover card | status: partial | remaining: the hover preview is missing
- [x] F61 PR link opening: setting chooses in-app or host site for PR links; per-repository merge method overrides and default | packages/contracts/src/settings.ts | w d | S | web done
- [ ] F62 PR environment assignment: a repository present on several environments lists each PR once, preferring the current environment | apps/web/src/components/pullRequest/pullRequestProjectAssignment.logic.ts | w d | S | scope: excluded | reason: multiple remote environments
- [x] F63 Retention for artifacts and logs: storage cleanup also removes browser artifacts and logs after N days, with per-kind report entries | packages/contracts/src/settings.ts | w d s | M | server done | web done
- [x] F64 Previous worktree directories: old worktree locations stay discoverable after changing the worktree directory | packages/contracts/src/settings.ts | s | S | server done
- [x] F65 Windows Git paths: strip the extended-length prefix before worktree creation; keep stored paths canonical | src-tauri/src/workspace.rs | s | S | server done: stops servers in the checkout, run on the Windows CI matrix
- [ ] F66 Jujutsu checkouts: status and change panel for non-colocated repositories | docs/jj.md | s w | L | beyond T3 | scope: excluded | reason: T3 SourceControlDiscovery advertises Jujutsu with implemented false; it has no non-colocated status/change panel to reproduce

## G. Terminal
- [x] G1 Thread terminals: per-thread drawer, persistent across switches | apps/web/src/components/ThreadTerminalDrawer.tsx | w d m s | L
- [x] G2 Splits and tabs: horizontal, vertical, new, close | packages/contracts/src/keybindings.ts | w d | M
- [x] G3 Scrollback: 5,000 lines and 8 MiB retained on server | docs/user/terminal.md | s | M | server done
- [x] G4 Scroll and selection keys: page, jump, select all | docs/user/terminal.md | w d | S | web done
- [ ] G5 Terminal context: excerpt becomes composer chip | apps/web/src/components/chat/TerminalContextInlineChip.tsx | w d m | M
- [x] G6 Link opening: terminal links open in preview | apps/web/src/components/preview/openTerminalLinkInPreview.ts | w d | S | web done: follows the Chat link setting
- [x] G7 Terminal observe: read-only watcher of a running terminal | packages/contracts/src/rpc.ts | w d m s | M | server done | web done
- [ ] G8 Native mobile terminal: dedicated surface with paste and menu | apps/mobile/src/features/terminal/NativeTerminalSurface.tsx | m | L | scope: excluded | reason: mobile client only
- [x] G9 Fish handling: startup tweak avoiding query waits | docs/user/terminal.md | s | S | server done
- [x] G10 Project scripts control: run scripts, keybindings per script | apps/web/src/components/ProjectScriptsControl.tsx | w d m s | M | server done | web done
- [ ] G11 Mobile terminal preferences: font size 6 to 14 in half steps, theme, paste handling, session menu with status labels, exit navigation | apps/mobile/src/features/terminal/terminalPreferences.ts | m | S | scope: excluded | reason: mobile client only
- [x] G12 Windows shell choice: native PowerShell executable first, then ComSpec; ignore a POSIX `SHELL`; flags as arguments | src-tauri/src/terminal.rs | s | S | server done: stops servers in the checkout, run on the Windows CI matrix
- [x] G13 Terminal close order: end the process tree before closing the pseudo console so the close cannot hang | src-tauri/src/terminal.rs | s | S | server done
- [ ] G14 Engine console: open the engine's own terminal UI resumed on the thread's session with the same model and mode, where the engine supports it | src-tauri/src/terminal.rs | w d s | M | beyond T3 | scope: excluded | reason: no generic open-resumed-engine-console action in inspected T3 thread actions; provider authentication terminals and Pi interactive sessions remain separate features

## H. Browser preview and devices
- [x] H1 Browser panel: embedded tabs per thread | apps/web/src/components/preview/PreviewPanel.tsx | w d m | L
- [x] H2 Address bar and search engines: six engines plus custom template | packages/contracts/src/settings.ts | w d | S
- [x] H3 Zoom, viewport, appearance defaults: per-browser preferences | packages/contracts/src/preview.ts | w d | M | zoom and appearance per tab, defaults in `preview_zoom` and `preview_appearance`; the service side ran in a real browser
- [x] H4 Local server discovery: lists ports from thread processes | apps/web/src/components/preview/useDiscoveredLocalServers.ts | w d m s | M
- [x] H5 Mini player: floating preview over chat | apps/web/src/components/preview/ThreadPreviewMiniPlayer.tsx | w d m | M | `PreviewFloat`, read-only, seen in a real run
- [ ] H6 Agent cursor: visual trace of agent input | apps/web/src/components/preview/AgentBrowserCursor.tsx | w d | M | blocked: agents do not act on a preview tab yet, so there is no input to trace
- [x] H7 Picked element and annotation: page element to composer chip | apps/desktop/src/preview/PickPreload.ts | d | L | crosshair in the panel; the element is quoted into the draft; seen in a real run
- [ ] H8 Recording: frame rate, key and mouse press overlays | apps/desktop/src/preview/RecordingInput.ts | d s | L | server: changed frames as JPEG files; no overlays or video
- [ ] H9 Passkeys: bridge for sites in preview | apps/desktop/src/preview/Passkeys.ts | d | L | N/A: a headless streamed browser has no platform authenticator
- [x] H10 Browser profiles: named profiles, clear profile | packages/contracts/src/browserProfile.ts | w d s | M | named profiles keep their folder and hold one tab at a time, since a browser locks its profile; no Settings page to add one yet, only the API | status: partial | remaining: the profile settings surface is missing
- [ ] H11 Browser import: cookies from other browsers, one time | apps/desktop/src/preview/BrowserImport/BrowserImport.ts | d | L | N/A: reading another browser's cookies means reading its keychain-protected secrets, which this app will not do | scope: excluded | reason: browser login-cookie and keychain import
- [ ] H12 Safari import permission: Full Disk Access guidance | apps/desktop/src/preview/BrowserImport/SafariPermission.ts | d | M | N/A: follows H11 | scope: excluded | reason: permission for the excluded browser-login import
- [ ] H13 Default browser: macOS links open in T3 | docs/user/default-browser.md | d | M | open: needs `http` and `https` registered with the OS, on top of the deep link path
- [x] H14 Link target: system or in-app | packages/contracts/src/settings.ts | w d | S
- [x] H15 Remote browser tabs: headless Chrome on host, streamed | docs/user/remote-access.md | w d m s | L, local only | scope: mixed | local: stream a browser running on this local service | excludes: remote hosts and access
- [x] H16 Take control: agent/human handover, read-only watch | docs/user/remote-access.md | w d m s | L | server: human hold and read-only watch; agents do not act on a preview tab yet | status: partial | remaining: agent control of a preview is missing
- [ ] H17 Remote clipboard, file picker, downloads: bridged to device | docs/user/remote-access.md | w d m | L | N/A as written: remote access is out of scope; a local tab has no clipboard, file picker or download bridge yet | scope: mixed | local: clipboard, file-picker and download bridges for the local preview | excludes: remote device bridges
- [ ] H18 Picture-in-picture: phone preview floats over apps | docs/user/remote-access.md | m | M | out of scope: mobile | scope: excluded | reason: mobile client only
- [ ] H19 Browser host setup: sandbox and library guidance | apps/server/src/cli/browser.ts | c s | M | open: Settings shows no browser check yet
- [ ] H20 Device panel: live iOS Simulator or Android Emulator | apps/web/src/components/device/DevicePanel.tsx | w d s | L | open: needs a device tool chain; not started
- [ ] H21 Device setup: three-step hub, platform, agent access | apps/web/src/components/device/DeviceSetup.tsx | w d s | M | open: needs a device tool chain; not started
- [ ] H22 Device tabs and float: multiple tabs, rename, float over chat | apps/web/src/components/device/DeviceWorkspace.tsx | w d | M | open: needs a device tool chain; not started
- [ ] H23 Device input: touch, type, Home, Back, Recents, rotate, power | apps/web/src/components/device/DeviceControlsRail.tsx | w d m | L | open: needs a device tool chain; not started
- [ ] H24 3D device view: model with fold and hinge controls | apps/web/src/components/device/DeviceDuoViewport.tsx | w d | L | N/A: depends on T3's 3D device assets
- [ ] H25 Android fold controls: fold or unfold | apps/web/src/components/device/DeviceAndroidFoldControls.tsx | w d | M | N/A: depends on a foldable device tool chain
- [ ] H26 Device tools drawer: appearance, text, accessibility, location, permissions, push | apps/web/src/components/device/DeviceToolsPanel.tsx | w d s | L | open: needs a device tool chain; not started
- [ ] H27 Agent devices: `agent-device` CLI, permission toggle | docs/user/devices.md | s | L | open: needs the `agent-device` CLI, not integrated
- [ ] H28 SSH device hosts: test connection, pinned tools | apps/web/src/components/settings/DeviceHostEditor.tsx | w d s | L | out of scope: remote hosts | scope: excluded | reason: SSH device hosts
- [ ] H29 EAS device hosts: EAS simulator source | apps/web/src/components/settings/EasDeviceHostEditor.tsx | w d s | M | [hosted]: EAS is a hosted service | scope: excluded | reason: hosted device service
- [ ] H30 Simlock hosts: alpha leased device pool | apps/web/src/components/settings/SimlockDeviceHostEditor.tsx | w d s | L | [hosted]: a leased device pool | scope: excluded | reason: hosted device pool
- [ ] H31 Device tool versions: check and auto install | apps/web/src/components/device/DeviceToolVersions.tsx | w d s | M | open: needs a device tool chain; not started
- [ ] H32 Mobile device viewer: stream and control in app, shake detection | apps/mobile/src/features/devices/DevicePreviewRouteScreen.tsx | m | L | out of scope: mobile | scope: excluded | reason: mobile client only
- [ ] H33 SnapShots: window capture to draft with app metadata | apps/desktop/src/snapShot/DesktopSnapShot.ts | d | L | open: not started
- [ ] H34 SnapShot setup by platform: accessibility data, GNOME, KDE, Hyprland, Niri, shortcut, sound | apps/desktop/src/snapShot/LinuxSnapShot.ts | d | L | N/A for Linux; the macOS and Windows parts follow H33 | scope: mixed | local: macOS and Windows capture setup | excludes: Linux desktop setup
- [ ] H35 Preview more menu: hard reload, DevTools, separate preview window, move to another panel, device toolbar toggle, light/dark/system appearance, zoom, clear cookies, clear cache | apps/web/src/components/preview/PreviewMoreMenu.tsx | w d | M | hard reload, zoom, appearance, device toolbar, clear cookies and cache done; DevTools, separate window and move to another panel are not | status: partial | remaining: DevTools, separate window and move-to-panel actions are missing
- [ ] H36 Device toolbar: responsive mode, viewport presets, rotate, drag handles to resize the page | apps/web/src/browser/BrowserDeviceToolbar.tsx | w d | M | presets and rotate done; drag handles are not | status: partial | remaining: viewport resize handles are missing
- [x] H37 Preview start page: recent URL cards, discovered local server cards, unreachable page with mapped error messages | apps/web/src/components/preview/PreviewEmptyState.tsx | w d | S
- [ ] H38 Browser history and favicons: address bar suggestions from visited URLs, remembered tab icons | apps/web/src/browserHistoryStore.ts | w d | S | address bar suggestions done; favicons are not, since the UI blocks remote images | status: partial | remaining: favicons are missing
- [x] H39 Webview crash recovery: reloads a crashed page up to 3 times within 30 seconds with growing delay | apps/web/src/browser/webviewCrashRecovery.ts | d | S | three growing tries in 30 seconds; a killed browser came back in a real run
- [x] H40 Incognito tabs: private tabs reopen only until reload or quit and reopen in a fresh session | docs/user/keybindings.md | w d | S | private tabs stay out of history; every tab without a named profile already ends with the tab
- [x] H41 Open file in preview: workspace files and terminal links open as browser tabs | apps/web/src/browser/openFileInPreview.ts | w d | S | HTML files from the Files panel, inside the checkout only; terminal links not yet | status: partial | remaining: terminal links do not open files in preview yet
- [x] H42 Agent browser access: global switch, per-project override, and device support onboarding flag | packages/contracts/src/settings.ts | w d s | M | `enable_agent_browser_access` now stops agent preview tools, globally or per project; the device flag is stored and unused | status: partial | remaining: the local device-support flag is stored but has no effect
- [x] H43 Auto-show floating preview: setting opens the mini player when an agent opens a page | packages/contracts/src/settings.ts | w d m | S
- [ ] H44 Mobile browser preview: streamed page, tab menu, thread float; shake toggles device preview controls | apps/mobile/src/features/browser/BrowserTabMenu.tsx | m | M | out of scope: mobile | scope: excluded | reason: mobile client only
- [x] H45 Windows listener list: loopback listeners with process names from a bounded PowerShell query | src-tauri/src/local_servers.rs | s | S | server done: stops servers in the checkout, run on the Windows CI matrix

## I. Providers

Surveyed against PandaCode 0.3.85's engine list. Any ACP agent runs here as a custom
engine, with its models, modes and config options read from `session/new`. Engines with
no row of their own are in I62. A CLI that speaks ACP is found and launched by itself, per
`engines/known.rs`; its login checks are not built in.

- [ ] I1 Codex CLI login: existing install and login | docs/user/providers-codex.md | s | M | [auth-risk] | scope: excluded | reason: engine login
- [ ] I2 Connect ChatGPT: managed sign-in with sharing | apps/server/src/provider/CodexChatGptAuth.ts | w d s | L | [auth-risk] [hosted] | scope: excluded | reason: managed login and hosted account sharing
- [ ] I3 Managed token broker: brokers ChatGPT tokens to Codex | apps/server/src/provider/CodexManagedTokenBroker.ts | s | L | [auth-risk] | scope: excluded | reason: engine-token brokering
- [ ] I4 ChatGPT account picker: multiple accounts, reconnect, disconnect | apps/web/src/components/settings/ChatGptAccountPicker.tsx | w d s | M | [auth-risk] | scope: excluded | reason: account management
- [ ] I5 ChatGPT profile handoff: import and reconnect profile | packages/contracts/src/rpc.ts | w d s | M | [auth-risk] | scope: excluded | reason: account credential handoff
- [ ] I6 Shared usage control: manage sharing and credits link | apps/web/src/components/chat/ChatGptSharingControl.tsx | w d m | S | [auth-risk] | scope: excluded | reason: account sharing and credits
- [ ] I7 Codex shadow homes: per-account auth over shared state | apps/server/src/provider/Drivers/CodexHomeLayout.ts | s | L | [auth-risk] | scope: excluded | reason: per-account credential homes
- [ ] I8 Account switch in thread: compatible Codex instances | docs/user/providers-codex.md | w d s | M | [auth-risk] | scope: excluded | reason: account switching
- [ ] I9 Codex feedback: send feedback upstream | packages/contracts/src/rpc.ts | w d s | S
- [ ] I10 App access approvals: MCP elicitation handling | apps/server/src/provider/CodexMcpElicitation.ts | s | M
- [ ] I11 Claude provider: uses Claude Code login and config | apps/server/src/provider/ClaudeProvider.ts | s | L | [auth-risk] | scope: mixed | local: run the installed Claude CLI with its own login and config | excludes: login UI, credential handling and account homes
- [ ] I12 Claude config homes: multiple accounts by config directory | apps/server/src/provider/Drivers/ClaudeHome.ts | w d s | M | [auth-risk] | scope: excluded | reason: multiple engine accounts
- [ ] I13 Claude auto-compact window: threshold from 100k to 1M | packages/contracts/src/settings.ts | w d s | S
- [x] I14 Idle compaction: on return, before cache expiry, never | packages/contracts/src/settings.ts | w d s | M
- [ ] I15 Claude skills: config, project and plugin sources | apps/server/src/provider/Drivers/ClaudeSkills.ts | s | M
- [ ] I16 Router presets: OpenRouter via instance env variables | docs/user/providers-claude.md | w d s | S | [auth-risk] | scope: excluded | reason: credential-bearing provider environment presets
- [ ] I17 Cursor provider: official SDK local agent runtime | packages/provider-cursor/src/adapter.ts | s | L
- [ ] I18 Cursor browser sign-in: per-instance saved credential | packages/provider-cursor/src/credentialStore.ts | w d m s | M | [auth-risk] | scope: excluded | reason: saved engine credential and browser sign-in
- [ ] I19 Cursor Keychain usage: reads CLI login for usage | packages/provider-cursor/src/CursorKeychain.ts | s | M | [auth-risk] | scope: excluded | reason: reading engine login from the keychain
- [ ] I20 Grok provider: ACP adapter with xAI extension | packages/provider-grok/src/adapter.ts | s | L | [auth-risk] | scope: mixed | local: Grok ACP integration through an installed CLI | excludes: xAI credential handling
- [ ] I21 OpenCode provider: local or external server, 1.x and 2.x | packages/provider-opencode/src/adapter.ts | s | L | [auth-risk] | scope: mixed | local: OpenCode local CLI or local server integration | excludes: external-server access and stored passwords
- [ ] I22 Antigravity provider: Google ACP agent | apps/server/src/provider/AntigravityProvider.ts | s | L
- [ ] I23 Antigravity sign-in: Google, Enterprise, API key, Vertex, remote callback paste | apps/server/src/provider/AntigravityAuth.ts | w d m s | L | [auth-risk] | scope: excluded | reason: engine sign-in
- [ ] I24 Antigravity runtime: managed install and removal | apps/server/src/provider/AntigravityInstallation.ts | w d s | M
- [ ] I25 Pi provider: RPC integration with MCP injection | packages/provider-pi/src/adapter.ts | s | L
- [ ] I26 Muse Code provider: opt-in, Supervised and Full access | packages/provider-muse/src/adapter.ts | s | L | [auth-risk] | scope: mixed | local: Muse CLI or protocol integration and supported permission modes | excludes: engine credentials and login
- [ ] I27 fx provider: Supervised and Auto with effort | packages/provider-fx/src/adapter.ts | s | M
- [x] I28 ACP Registry search: find and add agents | apps/web/src/components/settings/AcpRegistrySearchStep.tsx | w d s | L | web done
- [x] I29 ACP install: checksummed binaries, npx/uvx prefixes | packages/provider-acp-registry/src/AcpRegistrySupport.ts | s | L | server done
- [x] I30 Local ACP command: executable with literal arguments | apps/web/src/components/settings/AddProviderInstanceDialog.tsx | w d s | M | server done, as a custom engine | web done
- [ ] I31 ACP v1/v2 negotiation: preview protocol with fallback | packages/provider-acp/src/AcpSessionRuntime.ts | s | L
- [ ] I32 ACP sign-in: browser or terminal methods, sign out | apps/web/src/components/settings/ProviderAuthTerminal.tsx | w d m s | M | [auth-risk] | scope: excluded | reason: engine sign-in and sign-out
- [ ] I33 ACP native sessions: list, import, delete | apps/web/src/components/settings/AcpSessionManagementSection.tsx | w d s | M
- [ ] I34 Named ACP agents: Claude, Copilot, Devin, Droid adapters | packages/provider-acp-registry/src/droidAcp.ts | s | M | server: Copilot and Devin launch when found; Claude runs natively, and Droid comes through the registry
- [x] I35 Provider instances: multiple per driver, accent color, enable | apps/web/src/components/settings/ProviderInstanceCard.tsx | w d s | L | server done: `provider_instances` launches its own program and arguments; the model picker lists them as engines, and no settings page edits them yet
- [ ] I36 Instance environment: variables with sensitive marking | packages/provider-core/src/instanceEnvironment.ts | w d s | M | [auth-risk] | scope: excluded | reason: provider environment and sensitive values are outside the architecture settings contract
- [ ] I37 Provider credential store: server-side secret storage | apps/server/src/provider/ProviderCredentialStore.ts | s | L | [auth-risk] | scope: excluded | reason: engine credential storage
- [ ] I38 Provider install flow: start, cancel, subscribe, remove | apps/web/src/components/settings/ProviderSetupSection.tsx | w d s | M
- [ ] I39 Provider updates: per-provider and update-all | apps/web/src/components/ProviderUpdatesAction.tsx | w d m s | M
- [ ] I40 Model catalog: refreshed discovery with manifest | apps/server/src/provider/ModelManifest.ts | s | M | [hosted] | scope: mixed | local: refresh model discovery from an installed engine | excludes: T3-hosted model manifest service
- [ ] I41 Status banners: provider health in composer | apps/web/src/components/chat/ProviderStatusBanner.tsx | w d m | S
- [x] I42 Per-project provider toggle: enable or disable per project | packages/contracts/src/settings.ts | w d s | M | server done | web done
- [x] I43 Fallback model: alternate on unavailable default | packages/contracts/src/settings.ts | s | S | server done: for one turn, with a warning, when the engine's own list has dropped the model
- [x] I44 Text generation model: titles and branch names | packages/contracts/src/settings.ts | w d s | S
- [ ] I45 Permission-mode matrix per provider: fx Supervised and Auto; Muse Supervised and Full; Pi Supervised, Auto-accept edits, Full (stored Auto shows Supervised); OpenCode Auto equals Supervised; mode change restarts the provider session | docs/user/permission-modes.md | w d m s | M
- [ ] I46 fx behavior: shared machine login, Default model from `fx status`, Medium effort start, `$` skill dedupe rules, steer stops the turn, mode saved as fx default, sub-agent threads with shortened replies that wait on permission, unsupported list (plan, full access, commit and PR text, titles) | docs/user/providers-fx.md | s w | M | scope: mixed | local: fx turn, model, effort, skill, steering and subagent behavior through its own CLI | excludes: login or account handling by Orbyn
- [ ] I47 Muse behavior: host key from login, server-inherited key ignored, per-instance key wins, custom models for inaccessible ones, no `$` skills, fork copies context, no rewind, no in-app install or sign-in | docs/user/providers-muse.md | s w | M | [auth-risk] | scope: mixed | local: Muse model, skill, fork and rewind behavior through its own CLI | excludes: host keys, per-instance keys and login handling
- [ ] I48 Pi behavior: 0.80.5 minimum, launch-argument validation, remote login paste, native resume, rollback and fork, extension dialogs in composer, notifications in work log, `$` skills, untrusted-folder notice, Pi default fallback model, thinking-level defaults | docs/user/providers-pi.md | s w | L | scope: mixed | local: Pi local protocol, version, session, model and permission behavior | excludes: remote login paste and login handling
- [ ] I49 OpenCode behavior: 1.14.19 minimum, 2.x detection, Limited support label on 1.x, local helper vs external URL and password, `.env` approvals, Allow once vs for workspace, 30-second config cache, reconnect on next prompt | docs/user/providers-opencode.md | s w m | M | [auth-risk] | scope: mixed | local: OpenCode local version, session, approval and reconnect behavior | excludes: external URL/password configuration
- [ ] I50 Cursor behavior: per-instance sign-in, API key override, Change account and Sign out stop that instance's threads, `auto` maps to default model, read-only task sub-agent threads, interrupt-and-restart steering, Windows sandbox rules | docs/user/cursor.md | s w d m | M | [auth-risk] | scope: mixed | local: Cursor local turn, model, task, steering and sandbox behavior | excludes: sign-in, API keys and account switching
- [ ] I51 Version compatibility warning: provider card flags versions with known problems and offers recommended version install | docs/user/install.md | w d m s | M
- [ ] I52 Update route by installer: Homebrew, npm, pnpm, Yarn, Bun, Volta, Vite+ detected; mise handled manually; Cursor and Antigravity update with the app | docs/user/install.md | s w d | M
- [x] I53 Provider discovery: server-host PATH lookup, binary path override, Cursor `cursor-agent` name | docs/user/faq.md | s w | S | server done: the override is an instance's `program`
- [x] I54 Child environment hygiene: remove AppImage variables, the nested-session marker and vendor desktop markers from every engine spawn | src-tauri/src/child_env.rs | s | S | server done
- [x] I55 Prefer saved login: scrub inherited credential and endpoint variables so the engine uses its own login; report only variable names and endpoint origin | src-tauri/src/providers/claude_auth.rs | s w | M | beyond T3 | server done | web done | scope: excluded | reason: no matching T3 Prefer saved login toggle or credential-inheritance disclosure; remove the toggle via PR 72 and retain necessary invisible launch hygiene under I54
- [x] I56 Login probe without secrets: run the engine's own status command with settings sources empty, time and size bounded, output wiped; map to signed in, not signed in, other credentials, unknown | src-tauri/src/providers/claude_auth.rs | s | S | server done: three states, with inherited keys reported by I55 rather than a fourth
- [ ] I57 Agent telemetry switch: one setting applies each engine's own telemetry opt-outs to every spawn; coverage table shows off, manual or unknown per engine | src-tauri/src/providers/privacy.rs | s w d | M | beyond T3 | scope: excluded | reason: no engine-wide telemetry opt-out toggle and coverage table in inspected T3 provider settings; T3 product telemetry and diagnostics have their own separately tracked owners
- [x] I58 Codex fast tier from catalog: offered only when the model list names the tier | src-tauri/src/command_operations.rs | s w | S | server done | status: partial | remaining: the row records service completion without client evidence
- [x] I59 Discovery without leftovers: engines that report per-model options only after a switch are probed in throwaway sessions that are deleted afterwards | src-tauri/src/providers/devin.rs | s | M | server done
- [ ] I60 Model health pauses: a failing model is paused with a cooldown that survives restart; same model on another engine is offered as failover; Settings can allow it now | src-tauri/src/model_health.rs | s w | M | beyond T3 | scope: excluded | reason: no persistent per-model cooldown/failover Settings surface in inspected T3 provider settings; provider health classification does not implement this proposed control
- [ ] I61 Warm next turn: start the next Claude process in the background and adopt it only when every launch input matches | src-tauri/src/providers/warm.rs | s | M | beyond T3
- [ ] I62 Extra engines: Kimi Code, DeepSeek, Command Code, Cline, Kilo Code, Hermes Agent and ZCode with their documented quirks (Cline effort by flag, ZCode private protocol) | docs/providers.md | s | L | beyond T3 | server: all but ZCode launch over ACP when found, proved with the fake agent only; Cline's effort flag and ZCode's protocol are not built

## J. Usage and limits
- [x] J1 Usage page: tokens, cache savings, estimated cost | apps/web/src/components/usage/UsagePage.tsx | w d m s | L
- [ ] J2 Cost split: token type, speed, Premium, Other | docs/user/usage.md | w d | M
- [x] J3 Provider history readers: per-provider native scans | packages/provider-opencode/src/usage.ts | s | L | server done
- [ ] J4 Environment filter: scanning status, dims stale figures | docs/user/usage.md | w d m | M | scope: mixed | local: local history scan status and stale figures | excludes: remote environment filtering
- [ ] J5 Model breakdown: trend, cache hit, cost per million | apps/web/src/components/usage/UsageModelDialog.tsx | w d | M
- [x] J6 Custom prices: per-model rates, Mixed, retry saves | apps/web/src/components/usage/UsagePriceOverrides.tsx | w d s | L | server done | web done
- [x] J7 Model aliases: Map to another model | packages/contracts/src/settings.ts | w d s | S | server done | web done
- [x] J8 Refresh rates: rescan and pricing update | packages/contracts/src/rpc.ts | w d s | S | server done | web done
- [x] J9 Usage host identity: stable host ID file | docs/user/usage.md | s | S | server done
- [x] J10 Pooled limits: one number per window across accounts | apps/web/src/components/usage/UsageLimitsPooled.tsx | w d m | L | server done | web done | scope: mixed | local: pool limits reported by installed engines | excludes: account credential access or account management
- [x] J11 Account detail: plan, location, reset time | apps/web/src/components/usage/UsageLimits.tsx | w d m | M | server done | web done | scope: mixed | local: display only details the engine itself reports without credentials | excludes: account API calls made by Orbyn
- [ ] J12 Claude usage limits: reads subscription windows | apps/server/src/provider/claudeUsageLimits.ts | s | M | [auth-risk] | scope: local | local: subscription windows reported by the unmodified Claude CLI get_usage control protocol; no direct credential reads or SDK dependency | status: partial | remaining: PR77 implements the promptless CLI route with parser and real-service protocol evidence; live authenticated subscription windows and their integrated UI remain unverified
- [ ] J13 Codex usage limits: reads subscription windows | apps/server/src/provider/codexUsageLimits.ts | s | M | [auth-risk] | scope: mixed | local: subscription windows reported through the Codex CLI protocol | excludes: reading engine credentials or calling account APIs directly
- [ ] J14 Other provider limits: Antigravity, OpenCode Go, Cursor, Grok | apps/server/src/provider/antigravityUsageLimits.ts | s | M | [auth-risk] | scope: mixed | local: limits reported by each named engine through a credential-free CLI or supported session protocol | excludes: reading provider token files or brokering credentials for direct quota HTTP requests | status: partial | remaining: establish and test the allowed route separately for Antigravity, OpenCode Go, Cursor and Grok; unsupported routes remain explicit
- [ ] J15 Reset credits: Use reset redeems banked credit | apps/server/src/provider/resetCreditCoordinator.ts | w d m s | M | [auth-risk] | scope: excluded | reason: authenticated account credit redemption
- [ ] J16 CLIProxyAPI hub: pooled limits with management key | apps/web/src/components/settings/AddUsageLimitSourceDialog.tsx | w d s | M | [auth-risk] | scope: excluded | reason: credential-bearing management hub
- [x] J17 Thread details limits: remaining windows row | apps/web/src/components/chat/ThreadDetailsUsage.tsx | w d | S | server done | web done
- [x] J18 Composer limits panel: inline result | apps/web/src/components/chat/ComposerUsageLimits.tsx | w d m | S | server done | web done
- [x] J19 Auto check throttle: 5-minute client limit | docs/user/usage.md | w d m | S | server done | web done
- [ ] J20 Subscription widget: iOS and Android home-screen quota | apps/mobile/src/widgets/SubscriptionUsage.tsx | m | L | scope: excluded | reason: mobile client only
- [x] J21 Usage shortcuts: C, T, L, period keys | apps/web/src/components/usage/usageShortcuts.ts | w d | S | server done | web done
- [ ] J22 Tunnel usage: T3 Connect usage display | apps/web/src/components/cloud/TunnelUsage.tsx | w d | S | [hosted] | scope: excluded | reason: T3-hosted tunnel usage
- [ ] J23 Usage charts: per-provider chart and share bar | apps/web/src/components/usage/UsageProviderChart.tsx | w d | S
- [ ] J24 Mobile usage page: daily chart, environment selection, pooled limits, ChatGPT summary | apps/mobile/src/features/usage/UsageRouteScreen.tsx | m | M | scope: excluded | reason: mobile client only
- [x] J25 Usage in thread details: setting shows usage row, off by default | packages/contracts/src/settings.ts | w d | S | web done
- [x] J26 Resume at reset: when an engine reports a reset time, offer to send Continue at that time; overdue resumes recovered at startup before queued messages | src-tauri/src/providers/limits.rs | s w | M | beyond T3 | web done | scope: local | local: reset-time continuation and independent snoozing, as in docs/user/thread-sidebar.md and apps/web/src/components/chat/UsageLimitRecoveryBanner.tsx | status: partial | remaining: match Resume after usage limits, Cancel auto-resume and Wake now controls and verify integrated behavior

## K. Settings, appearance and notifications
- [ ] K1 Settings scope: choose project and environments, fan-out edit | apps/web/src/components/settings/SettingsScopeSentence.tsx | w d m | L | scope: mixed | local: edit local environment defaults or one logical project and its local checkout members; changing defaults preserves project overrides | excludes: fan-out to remote environments | status: partial | evidence: real orbynd version-fenced atomic settings API and local-web regression distinguish environment defaults, logical groups and physical checkouts; isolated packaged macOS walkthrough verifies group and checkout edits, preserved defaults and overrides, accurate checkout labels and explicit group selection | remaining: finish all UI bindings, repository-subfolder registration and Windows native qualification
- [ ] K2 Inheritance display: chain, Mixed, Reset all | apps/web/src/components/settings/SettingInheritance.tsx | w d | L | status: partial | evidence: real local-web and orbynd walkthrough verifies actual file provenance and Inherit; isolated packaged macOS walkthrough verifies grouped Mixed edits, untouched Mixed text, physical-checkout isolation and Reset all without changing environment defaults | remaining: custom provider, storage and observability forms still need scoped bindings; Windows native qualification
- [x] K3 Settings search: finds settings by query | apps/web/src/components/settings/settingsSearch.ts | w d | M | web done | evidence: exact-row search reveals Advanced, focuses the row and saves through real orbynd in narrow local web and a packaged macOS arm64 fixture at bf09a68; native reload retained the saved value, and project-scoped search preserved the selected target | limits: Windows native search has not been separately exercised
- [x] K4 Advanced folds: collapsed sections | apps/web/src/components/settings/FoldedSettingsSection.tsx | w d | S | web done
- [x] K5 Project defaults: model, mode, workspace, scripts | apps/web/src/components/settings/ProjectDefaultsSettings.tsx | w d m s | M | server done | web done | status: partial | evidence: real orbynd and browser verify effective checkout defaults and script precedence, menu execution in a real terminal, explicit empty lists, Inherit, unchanged files, actual-worktree file resolution and saved setup hooks; isolated packaged macOS menu executes a saved default and keeps its output tab selected during refresh | evidence: isolated packaged macOS also runs manual actions and opens their saved previews from both menus | remaining: complete remaining K9 action/editor auditing; final integrated native and Windows qualification
- [ ] K6 Project page: name, icon, actions, checkouts, removal | apps/web/src/components/settings/ProjectSettingsPanel.tsx | w d m s | M
- [ ] K7 Project icons: icon, emoji, monogram, image, automatic | apps/web/src/components/settings/ProjectIconPickerDialog.tsx | w d s | M
- [x] K8 t3.json project file: scripts, icon, workspace defaults, submodules | packages/contracts/src/t3ProjectFile.ts | s | M | server done | status: partial | evidence: real orbynd and Git verify recursive, top-level and none against nested submodules without rewriting t3.json; legacy spellings remain readable | evidence: real orbynd also consumes async action defaults and synchronous setup completion, with real setup processes and protocol-double engine ordering | remaining: project icons; Windows execution awaits section CI
- [ ] K9 Project actions: run on worktree create, settle, async, preview URL | apps/web/src/components/settings/ProjectActionsSettings.tsx | w d s | M | status: partial | evidence: real orbynd browser cases verify real synchronous setup completion before engine release, async overlap, exit failure, cancellation, held late queues and preservation of action metadata during command editing; engine processes are protocol doubles. Separate real-process restart proof preserves completed setup, rejects interrupted setup and fences an older schema writer. Both manual menus launch saved previews through real orbynd and a real headless browser, select the new tab without replacing an existing page, honor auto-open off and report preview failure separately from command execution. An isolated packaged macOS fixture also opens both menu actions, selects the new preview and script tabs, displays the real local page/output and exits with every owned child stopped. Version-fenced real-orbynd action add/update/remove operations also preserve each checkout's Mixed list, reject group-wide duplicates or missing targets atomically, retain forward metadata and leave project files unchanged. The form edits action metadata through this API and retains failed drafts; native fixture create/edit is qualified at 0b575dc, with later browser-qualified focus corrections. Stable IDs survive targeted renames and keep similarly named real script terminals/output separate. Real-service browser tests also capture, run, rename and clear environment-wide action shortcuts, select the real output terminal even with terminal input focused, execute while the initial catalog is held, and retain an already-saved action after a real shortcut-file error so retry cannot duplicate it | evidence: real-service preparation Retry preserves captured command/input/attachments/provider/model and current permissions, fences stale attempts, retains other-provider session/handoff and unrelated queue holds, and refuses missing local executables before setup; protocol doubles verify engine ordering. Real-service browser replacement-output regression verifies the selected action tab reconnects to a restarted process. Terminal relay tests cover final output, late replay and revoked input authority after child exit. A frozen macOS fixture captures/saves/executes the shortcut through native UI, but its output pane remained blank and no native composer turn was attempted | remaining: complete editor auditing; final integrated native output, shortcut, composer and Windows qualification
- [x] K10 Keybindings editor: rebind, when conditions, conflicts | apps/web/src/components/settings/KeybindingsSettings.tsx | w d s | L
- [x] K11 Keybindings file: lenient JSON with late defaults | apps/server/src/keybindings.ts | s | M | server done
- [x] K12 Workspace focus: F6 area cycling, tree navigation | docs/user/keyboard-focus.md | w d | M | web done
- [x] K13 Command palette: threads, actions, projects, settings, submenus | apps/web/src/components/CommandPalette.tsx | w d m | L
- [x] K14 Themes: built-in, per-light/dark selection | apps/web/src/components/settings/ThemeSettings.tsx | w d m | M
- [x] K15 Theme editor: palette editing with element inspector | apps/web/src/components/settings/ThemeEditorPanel.tsx | w d | L
- [x] K16 Theme import/export: T3 or VS Code, JSON | apps/web/src/components/settings/ThemeImportDialog.tsx | w d | M
- [ ] K17 Environment themes: server-published with applied-once default | apps/server/src/environmentTheme.ts | w d c s | M | scope: mixed | local: theme defaults published by the local service | excludes: remote environments
- [x] K18 Typography: fonts and sizes for four surfaces | apps/web/src/components/settings/TypographySettings.tsx | w d m | M
- [x] K19 Glass, contrast, smoothing: visual tuning | packages/contracts/src/settings.ts | w d | S
- [x] K20 Panel animations: 0–400 ms slider | apps/web/src/components/settings/PanelAnimationsPreview.tsx | w d | S
- [x] K21 Timestamp format: locale, 12-hour, 24-hour | packages/contracts/src/settings.ts | w d m | S
- [ ] K22 Environment identification: artwork, pill, none | packages/contracts/src/settings.ts | w d | S | scope: mixed | local: Dev and Nightly artwork or version pill for the local environment | excludes: remote environment identity
- [ ] K23 Material You: Android dynamic colors and layout | docs/user/appearance.md | m | M | scope: excluded | reason: mobile client only
- [x] K24 Notifications: off, notifications, sound, both; in-app | apps/web/src/components/settings/NotificationSettings.tsx | w d m | M | web done
- [ ] K25 Dock badge: unread count | apps/web/src/components/ThreadNotificationCoordinator.tsx | d | S
- [x] K26 Background activity profiles: fetch and health cadence, pause rules | apps/web/src/components/settings/BackgroundActivitySettings.tsx | w d s | M | status: partial | remaining: profiles and cadence values are stored without runtime consumers; lock, battery and low-power pause behavior is not implemented
- [ ] K27 Quit confirmation: direct, hold, double-click | apps/web/src/components/QuitHoldOverlay.tsx | d | S
- [x] K28 Labs: opt-in beta toggles | apps/web/src/components/settings/LabsSettingsPanel.tsx | w d m | S | web done
- [x] K29 Diagnostics: processes, signals, traces, resource history | apps/web/src/components/settings/DiagnosticsSettings.tsx | w d m s | L | server done | web done: warnings and errors stand in for traces, and Stop ends a process, so no other signals | status: partial | remaining: actual trace history and identity-fenced cross-platform signals beyond Stop are not implemented; native resource-history proof remains open
- [x] K30 OpenTelemetry export: per-signal OTLP URL with test | apps/web/src/components/settings/TelemetryExportSettings.tsx | w d s | M | server done | web done | status: partial | remaining: URLs are saved and an endpoint check runs, but no runtime signal exporter consumes observability settings
- [ ] K31 Product telemetry: hashed usage events, env opt-out | docs/user/telemetry.md | s d | M | [hosted] | scope: excluded | reason: hosted product telemetry
- [x] K32 Database storage notice: suggests repair at 1 GiB reclaimable | apps/web/src/components/settings/DatabaseStorageNotice.tsx | w d m s | S | server done | web done
- [ ] K33 Secrets: secret providers, references, 1Password driver | apps/web/src/components/settings/SecretsSettings.tsx | w d s | L | [auth-risk] | scope: excluded | reason: secret-provider brokering
- [ ] K34 Triage: playbook thread with source for server version | apps/server/src/triage/TriageService.ts | w d m c s | M
- [ ] K35 Welcome wizard: computers, agents, project import | apps/web/src/components/onboarding/WelcomeWizard.tsx | w d | L | scope: mixed | local: existing local agent and project-import steps | excludes: remote computer setup and any library setup step
- [ ] K36 Agent history import: scans Claude, Codex, Pi with limits | packages/contracts/src/agentSessions.ts | w d s | L
- [x] K37 Open source licenses: in-app legal list | apps/web/src/components/settings/OpenSourceLicenses.tsx | w d m | S | web done
- [x] K38 GitHub star prompt: occasional prompt | apps/web/src/components/GitHubStarPrompt.tsx | w d | S | scope: local | local: occasional dismissible GitHub-star prompt as in apps/web/src/components/GitHubStarPrompt.tsx; public repository identity follows this app | status: partial | evidence: real orbynd and browser verify sixth-send display, button/swipe dismissal across reload and existing-star suppression; storage-failure and inter-tab race checks pass | remaining: desktop restart persistence across per-launch origins and packaged Windows/macOS walkthrough
- [x] K39 Thread shortcuts: stop turn (unbound), steer first queued, edit queued, previous and next, jump 1 to 9 (desktop only), copy reference, settle, pin, global undo with mod+z | packages/contracts/src/keybindings.ts | w d | M | web done
- [x] K40 Model picker shortcuts: toggle, previous and next provider, jump 1 to 9 inside the picker, Left or Shift+Tab to the provider list | docs/user/keybindings.md | w d | S | web done
- [ ] K41 Composer menu shortcuts: model, host, cycle host, effort, step effort up and down (wrapping), permissions, workspace, previous worktree, branch, stash | docs/user/keybindings.md | w d | M | web done except host and cycle host, which need remote environments | scope: mixed | local: model, effort, permission, checkout, branch and stash shortcuts | excludes: host and cycle-host shortcuts | status: partial | remaining: the local shortcut subset is recorded as web done but the row is still unchecked; retain it for recheck
- [x] K42 Panel and navigation shortcuts: sidebar toggle, back and forward, right panel toggle, new, maximize, close, thread panel toggle, reopen closed tab, diff toggle, terminal toggle, split, new, close | packages/contracts/src/keybindings.ts | w d | M
- [x] K43 Preview shortcuts: toggle, refresh, focus URL, zoom in, out and reset | packages/contracts/src/keybindings.ts | w d | S
- [x] K44 Search and new-thread shortcuts: palette, file picker, project search, find in thread, new thread, local new thread, new without project, open favorite editor, copy PR number | packages/contracts/src/keybindings.ts | w d | S
- [x] K45 Theme shortcuts: pick theme, cycle appearance, toggle theme editor, open usage | packages/contracts/src/keybindings.ts | w d | S | web done
- [x] K46 When contexts: terminal, preview, picker, composer, draft route, turn running, editable focus, web or desktop; negation, and, or, parentheses; last match wins | docs/user/keybindings.md | w d s | M
- [x] K47 Keybinding file notices: toast when file reloads or is invalid, warning when it cannot be opened | apps/web/src/components/KeybindingsUpdateToast.tsx | w d | S | web done
- [ ] K48 Reserved keys: mod+w never closes the desktop window; browsers need alt+w style rebind | docs/user/keybindings.md | w d | S
- [ ] K49 Snap Shot settings: shortcut (including both Shift keys), sound choice, flash, animations, include accessibility data, setup dialog | apps/web/src/components/settings/SnapShotSettings.tsx | d | M
- [x] K50 Legacy features: legacy sidebar, Build/Plan with /plan, /default and Shift+Tab, context meter | apps/web/src/components/settings/SettingsPanels.tsx | w d | S | web done
- [ ] K51 Health toasts: slow requests, host frozen, legacy thread migration, permission update | apps/web/src/components/SlowRpcRequestToastCoordinator.tsx | w d m | S | web: slow requests, which also covers a frozen host; the other two have no event here | status: partial | remaining: permission-update and migration events are not established
- [x] K52 Provider update checks: toggle checking CLIs and model catalogs for updates | packages/contracts/src/settings.ts | w d s | S
- [ ] K53 Default theme and environment icon: default theme preference with set time, machine-kind icon picker | apps/web/src/components/settings/EnvironmentIconPicker.tsx | w d | S
- [x] K54 New projects base directory: default parent folder for new and cloned projects | packages/contracts/src/settings.ts | w d s | S
- [x] K55 Settings navigation: sidebar nav, breadcrumb, section deep links across 24 settings pages | apps/web/src/components/settings/SettingsSidebarNav.tsx | w d | M
- [ ] K56 Capability inventory: read-only list of each engine's commands, MCP server names, hook event names, plugin names and skill folders; no secrets, bodies or absolute config paths | docs/capabilities.md | w d s | M | beyond T3 | scope: excluded | reason: no combined read-only engine capability inventory in inspected T3 settings; existing separate commands, MCP, plugins and skills surfaces remain required
- [x] K57 Network disclosure: Settings lists every automatic outbound request with host and cadence | README.md | w d | S | beyond T3 | web done | scope: excluded | reason: no matching T3 automatic outbound-request inventory in Settings; remove the existing Network group via PR 72 while retaining invisible internal inventory

## L. Remote access, pairing and auth
- [ ] L1 T3 Connect tunnel: reach host without port forwarding | docs/user/remote-access.md | w d m c s | L | [hosted] | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L2 Connect sign-in: Clerk-based account, CLI code flow | apps/web/src/components/cloud/ConnectCliAuthSurface.tsx | w d m c | L | [hosted] | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L3 Machine limit: 3 machines, more with T3 Chat | docs/user/remote-access.md | w d | M | [hosted] | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L4 Link T3 Chat: raises machine limit | apps/web/src/components/clerk/T3ChatUserProfilePage.tsx | w d | M | [hosted] | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L5 Deregister environment: frees host space | apps/web/src/components/clerk/RemoveT3ConnectEnvironmentDialog.tsx | w d m | S | [hosted] | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L6 Idle tunnel cleanup: tunnel recreated on host wake | docs/user/remote-access.md | s | M | [hosted] | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L7 Hosted web app: app.t3.codes as remote client | docs/user/remote-access.md | w | L | [hosted] | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L8 Relay client install: installer dialog and status | apps/web/src/components/cloud/RelayClientInstallDialog.tsx | w d s | M | [hosted] | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L9 Connect onboarding: dialog and environment connect list | apps/web/src/components/cloud/ConnectOnboardingDialog.tsx | w d m | M | [hosted] | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L10 LAN pairing: network access toggle, one-time links | apps/web/src/components/settings/ConnectionsSettings.tsx | w d c s | M | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L11 Pairing route: claim page plus QR | apps/web/src/components/auth/PairingRouteSurface.tsx | w d m | M | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L12 Pairing deep link: `t3code://pair` with confirmation | docs/user/remote-access.md | d | S | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L13 Custom CA on Android: trusts user-installed CA | docs/user/remote-access.md | m | S | scope: excluded | reason: mobile client only
- [ ] L14 Multi-route environments: LAN, Tailscale, VPN, URL, SSH, Connect | apps/web/src/components/settings/EnvironmentRoutesList.tsx | w d m | L | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L15 Add/reorder routes: speed-ordered, drag, remove | apps/web/src/components/settings/EnvironmentRow.tsx | w d m | M | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L16 Learned routes: LAN and Tailscale auto-added | docs/user/remote-access.md | w d m s | L | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L17 Failover and recovery: moves back to earlier route | docs/internals/connection-runtime.md | w d m | L | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L18 Permissions view: scopes for in-use route | apps/web/src/components/settings/SessionPermissions.tsx | w d m | S | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L19 Connection diagnosis: failure details and trace ID | apps/web/src/components/settings/ConnectionDiagnosisDetails.tsx | w d m | M | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L20 Auto balance: machine weights for new threads | apps/web/src/components/settings/LoadBalancingSettings.tsx | w d | M | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L21 Host resource checks: CPU and memory feed balancing | packages/contracts/src/resourceTelemetry.ts | s | M | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L22 Tailscale HTTPS: serve mapping and endpoint | packages/tailscale/src/tailscale.ts | d c s | M | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L23 Desktop-managed SSH: starts or reuses remote server, forwards port | apps/desktop/src/ssh/DesktopSshEnvironment.ts | d | L | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L24 SSH password prompt: in-app secure entry | apps/web/src/components/desktop/SshPasswordPromptDialog.tsx | d | S | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L25 WSL backend: runs agents and projects inside distro | apps/desktop/src/wsl/DesktopWslBackend.ts | d | L | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L26 Remote-only desktop: disables local environment | apps/web/src/components/settings/LocalEnvironmentSetting.tsx | d | M | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L27 Scoped access: 16 permission scopes, guarded RPCs | packages/contracts/src/auth.ts | s | L | scope: mixed | local: local route, launch-token, Host and Origin checks | excludes: remote permission scopes and remote access
- [ ] L28 Client sessions: list, issue, revoke | apps/web/src/components/settings/AuthorizedClientsSettings.tsx | w d c s | M | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L29 Pairing links management: create, list, revoke | apps/server/src/cli/auth.ts | w d c s | M | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L30 Outside agents: OAuth MCP sign-in with mode choice | docs/user/outside-agents.md | s | L | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L31 Copy MCP URL: per-route address | docs/user/outside-agents.md | w d | S | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L32 Linked environments: beta, agents act across machines | apps/web/src/components/settings/LinkedEnvironmentsSettings.tsx | w d m c s | L | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L33 Link access rules: capped by mode, 30-day expiry, From marker | docs/user/remote-access.md | s | L | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L34 Remote delegation: `delegate_task` across link | apps/server/src/peer/RemoteDelegation.ts | s | L | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L35 Guest links: browser follows one thread, 24-hour link | apps/web/src/components/guest/GuestPage.tsx | w s | L | [hosted] | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L36 Guest requests: send or dismiss in sidebar and mobile | apps/web/src/components/chat/GuestShareControls.tsx | w d m s | M | [hosted] | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L37 Guest attachments: 4 files, 10 MB per message | apps/server/src/guest/guestAttachments.ts | w s | M | [hosted] | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L38 Prompt links: draft from URL, never auto-runs | apps/web/src/components/promptLinks/NewThreadLinkView.tsx | w d m | M | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L39 Prompt link landing: destination choice with remember | apps/web/src/components/promptLinks/HostedPromptLinkLanding.tsx | w | M | [hosted] | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L40 Hidden character stripping: warns on invisible text | docs/user/prompt-links.md | w d m | S | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L41 Protocol version gate: refuses mismatched client and server | docs/user/updating.md | w d m s | M | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L42 Agent activity publishing: mobile push and Live Activity | apps/server/src/relay/AgentAwarenessRelay.ts | s m | L | [hosted] | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L43 Connect troubleshooting guide: device, relay, host tunnel, host app chain; Details names first failing part; error table with fixes; copy diagnostics and trace ID | docs/user/t3-connect-troubleshooting.md | w d m s | M | [hosted] | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L44 Host-side check: `t3 connect status` and Settings, Sharing and access test the host's own address and explain failure | apps/server/src/cli/connect.ts | w d c s | S | [hosted] | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L45 Blocked tunnel hints: outbound port 7844, Tailscale exit node, VPN and firewall advice, direct-route fallback | docs/user/t3-connect-troubleshooting.md | w d | S | [hosted] | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L46 Clock skew detection: reports a device or host clock that breaks signed requests | docs/user/t3-connect-troubleshooting.md | w d m s | S | [hosted] | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L47 Account pages: Connect profile, mobile clients and T3 Chat profile pages, remove environment dialog | apps/web/src/components/clerk/T3ConnectAccountPages.tsx | w d m | M | [hosted] [auth-risk] | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L48 Hosted channel switch: setting moves the hosted web app between release channels | apps/web/src/components/settings/SettingsPanels.tsx | w | S | [hosted] | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L49 Connection status dot: per-environment health indicator | apps/web/src/components/ConnectionStatusDot.tsx | w d m | S | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L50 Mobile app promo row: store links and QR in Settings, About | apps/web/src/components/settings/MobileAppSettingsRow.tsx | w d | S | scope: excluded | reason: section L is outside the local-replica scope, except L27
- [ ] L51 Revoke other clients: one action revokes all sessions except the current one | apps/web/src/components/settings/AuthorizedClientsSettings.tsx | w d | S | scope: excluded | reason: section L is outside the local-replica scope, except L27

## M. Automations, subagents and orchestration
- [x] M1 Scheduled tasks: interval, fixed time, weekdays | apps/server/src/scheduledTasks/ScheduledTaskService.ts | w d m s | L
- [x] M2 Task manager UI: edit, pause, resume, run now, delete | apps/web/src/components/settings/ScheduledTasksSettings.tsx | w d m | M | web done
- [ ] M3 Thread automations panel: tasks tied to a thread | apps/web/src/components/chat/ThreadAutomationsPanel.tsx | w d | M
- [x] M4 Webhook trigger: public URL, rotate token | apps/server/src/scheduledTasks/webhookRoute.ts | w d m s | L | [hosted] | server done, reachable only where the host is; no relay | web done | scope: mixed | local: local webhook endpoint, token rotation and delivery | excludes: T3-hosted or relayed public URL
- [x] M5 Webhook templates: placeholders with untrusted-data wrapping | apps/server/src/scheduledTasks/webhookTemplate.ts | s | M | server done
- [x] M6 Webhook signatures: header, encoding, prefix | apps/server/src/scheduledTasks/webhookVerification.ts | w d s | M | server done | web done
- [x] M7 Webhook filters: up to 16 conditions | apps/server/src/scheduledTasks/webhookFilter.ts | w d s | M | server done | web done
- [x] M8 Replay and coalesce: dedupe with windows | apps/server/src/scheduledTasks/webhookDedupe.ts | s | L | server done
- [x] M9 Webhook deliveries log: request and prompt detail | packages/contracts/src/rpc.ts | w d s | M | server done | web done
- [ ] M10 Hold webhooks offline: relay stores up to 24 hours | apps/server/src/relay/HeldHooksWaker.ts | s | L | [hosted] | scope: excluded | reason: hosted webhook relay
- [x] M11 Skip stale deliveries: maximum age per task | packages/contracts/src/scheduledTask.ts | s | S | server done
- [x] M12 Delegated subagents: child threads with result wake | apps/server/src/mcp/OrchestratorMcpService.ts | w d m s | L | server done | web done
- [ ] M13 Workflows: script view and stop | packages/contracts/src/orchestrationV2.ts | w d m s | L
- [x] M14 Batch thread creation: agents start many threads | apps/server/src/mcp/toolkits/orchestrator/tools.ts | s | M | server done
- [ ] M15 Secret request tool: agent requests secret securely | apps/server/src/secrets/SecretRequests.ts | s | M | [auth-risk] | scope: excluded | reason: secret brokering
- [x] M16 Portable handoffs: budgeted history with fresh-session recovery | packages/provider-core/src/handoffBudget.ts | s | L | server done
- [x] M17 After-thread trigger: a schedule that fires when another thread finishes, optionally only on success; run history capped at 200 per thread | docs/schedules.md | s w | M | server done, within a minute of the end; firings are not capped since each is a thread of its own | web done
- [x] M18 Silence watchdog: a delegated run with no event for twice the longest tool timeout is stopped; waits on approvals and questions do not count | src-tauri/src/architect/watchdog.rs | s | S | server done
- [x] M19 Interrupted marking: a Stop is saved before the signal so a quit after it is not counted as restart interruption; unfinished tool rows get an interrupted note | src-tauri/src/storage.rs | s | M | server done

## N. MCP tools for agents
- [x] N1 Environment: `t3_environment_read`, `t3_environment_preferences_update` | apps/server/src/mcp/toolkits/environment/tools.ts | s | M | server done, as `orbyn_*`; a tool sets project preferences only
- [x] N2 Worktree: `t3_worktree_handoff`, `_status`, `_list` | apps/server/src/mcp/toolkits/worktree/tools.ts | s | M | server done, as `orbyn_*`
- [ ] N3 HTML: `html_preview`, `html_render` | apps/server/src/mcp/toolkits/html/tools.ts | s | M
- [x] N4 Attachments: `t3_attachment_prepare_upload`, `_discard`, `t3_thread_send_attachments` | apps/server/src/mcp/toolkits/attachment/tools.ts | s | M | server done, as `orbyn_attachment_add`, which takes a checkout file, `_discard` and `orbyn_thread_send`
- [x] N5 Preview controls: `t3_preview_list`, `t3_preview_close` | apps/server/src/mcp/toolkits/previewControls/tools.ts | s | S | server done, as `orbyn_*`
- [ ] N6 Projects: `t3_project_list`, `_read`, `_create`, `_update`, `_delete`, `_clone` | apps/server/src/mcp/toolkits/project/tools.ts | s | M | server: read and rename the caller's own project; create, clone and delete reach past it, so tools do not offer them
- [x] N7 Thread launch: `t3_thread_launch` | apps/server/src/mcp/toolkits/project/tools.ts | s | M | server done, as `orbyn_*`
- [x] N8 Browser automation: `preview_status`, `_open`, `_dialog`, `_navigate`, `_resize`, `_set_appearance` | apps/server/src/mcp/toolkits/preview/tools.ts | s | L | server done: all six, under `orbyn_preview_*`, with back and forward
- [ ] N9 Browser inspection: `preview_snapshot`, `_act`, `_evaluate`, `_wait_for` | apps/server/src/mcp/toolkits/preview/tools.ts | s | L
- [x] N10 Browser recording: `preview_recording_start`, `_stop` | apps/server/src/mcp/toolkits/preview/tools.ts | s | M | server done, as `orbyn_*`: changed frames as JPEG files
- [ ] N11 Devices: `device_list`, `_open`, `_screenshot`, `_close` | apps/server/src/mcp/toolkits/device/tools.ts | s | M
- [ ] N12 Thread organize and config: `t3_thread_organize`, `t3_thread_configure`, `t3_thread_transfer` | apps/server/src/mcp/toolkits/thread/tools.ts | s | M | server: organize and configure; transfer reaches past the project
- [x] N13 Queue and requests: `t3_queue`, `t3_pending_request` | apps/server/src/mcp/toolkits/thread/tools.ts | s | M | server done, as `orbyn_*`
- [x] N14 Thread search: `t3_thread_search` | apps/server/src/mcp/toolkits/thread/tools.ts | s | S | server done, as `orbyn_*`
- [x] N15 Thread lifecycle: `t3_thread_list`, `_read`, `_update`, `_send`, `_wait`, `_interrupt` | apps/server/src/mcp/toolkits/orchestrator/tools.ts | s | M | server done, as `orbyn_*`
- [x] N16 PR links: `link_pull_request`, `unlink_pull_request`, `list_thread_pull_requests` | apps/server/src/mcp/toolkits/pullRequests/tools.ts | s | M | server done, as `orbyn_*`, core calls tested through `gh`
- [x] N17 PR watch: `watch_pull_request`, `unwatch_pull_request` | apps/server/src/mcp/toolkits/pullRequests/tools.ts | s | M | server done, as `orbyn_*`, core calls tested through `gh`
- [ ] N18 Guides: `write_pull_request_guides`, `read_pull_request_guide` | apps/server/src/mcp/toolkits/pullRequests/tools.ts | s | M
- [ ] N19 Delegation: `orchestrator_capabilities`, `delegate_task`, `task_status`, `task_cancel`, `t3_workflow_stop`, `t3_background_wait` | apps/server/src/mcp/toolkits/orchestrator/tools.ts | s | L | server: all but workflow stop, since M13 is not built; `orbyn_thread_wait` is the background wait
- [x] N20 Scheduling: `schedule_task`, `list_scheduled_tasks`, `delete_scheduled_task`, `run_scheduled_task_now` | apps/server/src/mcp/toolkits/orchestrator/tools.ts | s | M | server done, as `orbyn_*`
- [ ] N21 Agent requests: `request_secret`, `create_threads` | apps/server/src/mcp/toolkits/orchestrator/tools.ts | s | M | [auth-risk] | server: `orbyn_threads_create`; `request_secret` stays out under rule 1 | scope: mixed | local: local batch thread creation | excludes: request_secret
- [ ] N22 Links: `t3_environment_links`, `_link`, `_unlink` | apps/server/src/mcp/toolkits/orchestrator/tools.ts | s | M | scope: excluded | reason: links between machines
- [x] N23 Tool call budgets: app tools answer within 45 s, approval waits cap at 240 s, calls end when the client disconnects, bodies and results size-capped | src-tauri/src/providers/mcp_host.rs | s | M | server done: 512 KiB requests, 256 KiB replies; the permission prompt keeps its own timeout

## O. CLI
- [x] O1 `t3` / `t3 start`: starts server and opens browser | apps/server/src/cli/server.ts | c | M | server done, as `orbyn` and `orbyn start` | status: partial | remaining: opening a browser is opener-contract tested; a real CLI-launched browser still needs proof
- [x] O2 `t3 serve`: headless server with host, LAN, Tailscale options | apps/server/src/cli/server.ts | c | M | server done, as `orbyn serve`; remote options are out of scope | scope: mixed | local: headless local service | excludes: LAN, Tailscale and other remote options
- [x] O3 `t3 app`: opens project in desktop app | apps/server/src/cli/app.ts | c d | S | server done, as `orbyn app`, through the `orbyn://` link | status: partial | remaining: no-path invocation does not select the current directory and the deep link is not acknowledged by the desktop; packaged project-opening proof remains open
- [ ] O4 `t3 up`: prompted or flag-driven access setup | apps/server/src/cli/up.ts | c | L | [hosted] | scope: excluded | reason: remote access setup
- [x] O5 `t3 status`: current access settings, JSON | apps/server/src/cli/up.ts | c | S | server done, as `orbyn status`, for the running service
- [ ] O6 `t3 connect` and subcommands: login, link, status, publish, unlink, logout | apps/server/src/cli/connect.ts | c | L | [hosted] | scope: excluded | reason: hosted connection and sign-in
- [ ] O7 `t3 pair`: pairing link with scopes and Tailscale | apps/server/src/cli/pair.ts | c | M | scope: excluded | reason: Tailscale pairing
- [ ] O8 `t3 auth pairing`: create, list, revoke | apps/server/src/cli/auth.ts | c | M | scope: excluded | reason: pairing management
- [ ] O9 `t3 auth session`: issue, list, revoke | apps/server/src/cli/auth.ts | c | M | scope: excluded | reason: remote client session management
- [x] O10 `t3 service`: install, update, restart, status, uninstall | apps/server/src/cli/service.ts | c | L | server done, as `orbyn service`: install again to update; macOS/Linux plans and dry runs tested without loading a real login service; Windows background setup reports unsupported, as in T3 | status: partial | remaining: real macOS service installation, update, restart, status and uninstall have not been exercised in an isolated OS service manager; Windows unsupported response awaits matrix execution
- [ ] O11 `t3 service protect`: memory and OOM protection, undo | apps/server/src/cli/service.ts | c | M | scope: excluded | reason: pinned T3 supports this command only on Linux with systemd; neither is a supported product target
- [x] O12 `service.env`: literal environment file | docs/user/background-service.md | c s | S | server done, in the data folder: dotenv quoting, comments, export and multiline values without shell expansion; launcher PATH/data directory are protected; missing files are ignored and other read failures stop startup | evidence: real `orbyn service run` and real `orbynd` workspace API verify exact literal values, selected bundle, owned data directory and inherited Git path on macOS; Windows execution awaits CI
- [ ] O13 `t3 update`: exact version, channel, downgrade | apps/server/src/cli/update.ts | c | M
- [ ] O14 `t3 uninstall`: removes launcher, service, versions | apps/server/src/cli/uninstall.ts | c | S
- [x] O15 `t3 doctor`: database repair, dry run, fix | apps/server/src/cli/doctor.ts | c | M | server done, as `orbyn doctor`, `--dry-run` and `--fix`, through a running service
- [x] O16 `t3 thread`: list, start, send, show with wait and JSON | apps/server/src/cli/thread.ts | c | M | server done, as `orbyn thread`
- [x] O17 `t3 project`: add, remove, rename | apps/server/src/cli/project.ts | c | S | server done, as `orbyn project`
- [ ] O18 `t3 environment`: link, list, unlink | apps/server/src/cli/environment.ts | c | M | scope: excluded | reason: linked environments
- [x] O19 `t3 theme`: set, clear, show | apps/server/src/cli/theme.ts | c | S | server done, as `orbyn theme`, through the `default_theme` preference | status: partial | remaining: set, clear and show change a stored preference; the running UI does not consume it or watch CLI theme files yet
- [x] O20 `t3 browser setup`: host sandbox and libraries | apps/server/src/cli/browser.ts | c | M | scope: mixed | local: `orbyn browser setup` matches the macOS/Windows no-op response without requiring a service or changing the host | excludes: Linux AppArmor, package and font installation | evidence: real CLI with and without a real service on macOS; Windows execution awaits CI
- [x] O21 `t3 trace summary`: trace reporting | apps/server/src/cli/trace.ts | c | S | evidence: real orbynd emits bounded operation timings and real CLI reads counts, latency percentiles, outcomes, since and limit online or offline; no request payloads in records | verification: macOS local checks; Windows execution awaits section CI
- [ ] O22 `t3 triage`: starts Claude or Codex in terminal | apps/server/src/cli/triage.ts | c | S
- [x] O23 Config inputs: flags, environment, home directory | apps/server/src/cli/config.ts | c | M | server done: `--data-dir` and `ORBYN_DATA_DIR`; `orbyn serve` takes `orbynd serve` options
- [ ] O24 Hidden helpers: ACP MCP bridge and call, SSH helper, service launcher, Claude history | apps/server/src/cli/acpMcpBridge.ts | c | M | scope: mixed | local: local ACP bridge, service launcher and credential-free history helpers | excludes: SSH helper
- [x] O25 Start in directory: `t3 <path>` starts there, bare names only if the folder exists, existing server reported, `--base-dir` isolates a second server | docs/user/install.md | c | S | server done, as `orbyn <path>`; `--data-dir` isolates a second service
- [ ] O26 Try without install: `npx t3@latest`; `t3 help` full reference | docs/user/install.md | c | S
- [ ] O27 Render benchmark: replay a seeded 50 KB reply in fixed deltas into this UI and the reference UI in fresh browsers, record main-thread time, heap and mutations | bench/t3-compare/README.md | c | M | beyond T3 | scope: excluded | reason: an internal comparative benchmark rather than a T3 product surface; optional engineering evidence remains useful

## P. Desktop shell
- [x] P1 Bundled backend: pool of managed local servers | apps/desktop/src/backend/DesktopBackendPool.ts | d | L | one managed `orbynd`; a pool serves remote hosts, which are out of scope | scope: mixed | local: one bundled local backend | excludes: a pool of remote hosts
- [x] P2 Shell environment: loads profile PATH and variables | apps/desktop/src/shell/DesktopShellEnvironment.ts | d | M | `child_env` tool search (P31) replaces reading the profile; no shell is sourced and profile variables are not loaded
- [ ] P3 Auto updater: state machine with release notes | apps/desktop/src/updates/DesktopUpdates.ts | d | L | the state machine, notes and install are tested over the shell channel; nothing is proved end to end until a signed release and update endpoint exist
- [x] P4 Update everything: providers, servers, desktop in order | apps/web/src/components/sidebar/UpdateEverythingDialog.tsx | w d s | L | `apply-all` runs engines, library, app and stops at a failure; run on the service, the desktop step needs a release to install | status: partial | remaining: the desktop update step has not run through a released update
- [ ] P5 Remote updates: desktop relaunch for remote hosts | apps/desktop/src/updates/DesktopRemoteUpdates.ts | d | L | N/A: remote hosts are out of scope | scope: excluded | reason: remote-host updates
- [ ] P6 Update tracks: Stable and Nightly switching | apps/web/src/components/settings/UpdateTrackSwitchDialog.tsx | d | L | open: no Nightly build is published, so there is nothing to switch to
- [x] P7 Update sidebar pill: progress and retry | apps/web/src/components/sidebar/SidebarUpdatePill.tsx | w d | M | the pill opens a dialog with step progress and Retry
- [x] P8 Startup recovery: failure window with update or last-good version | apps/desktop/src/app/DesktopStartupRecovery.ts | d | M | the loader shows what the service said, with Try again; a last-good version is N/A: Tauri replaces the app in place and keeps none
- [x] P9 Deep links: protocol and Linux URL handler | apps/desktop/src/app/DesktopLinuxUrlHandler.ts | d | M | `orbyn://`, routes only; the Linux handler is N/A since Linux is not a target; not yet opened through Windows | scope: mixed | local: macOS and Windows deep-link handling | excludes: Linux protocol registration | status: partial | remaining: Windows deep-link opening has not been observed
- [x] P10 Web link coordinator: routes opened links | apps/web/src/components/desktop/DesktopWebLinkCoordinator.tsx | d | M
- [x] P11 App activation broker: single instance handoff | apps/desktop/src/app/DesktopAppActivationBroker.ts | d | M | seen on a packaged macOS app and in CI on an installed package
- [x] P12 CLI shim: installs `t3` from app | apps/desktop/src/app/DesktopCliShim.ts | d | M | installs `orbyn` from Settings; seen on a packaged macOS app, and the command found the service; the Windows `.cmd` has unit tests only | status: partial | remaining: Windows CLI installation has unit evidence only
- [x] P13 Application menu: native menus | apps/desktop/src/window/DesktopApplicationMenu.ts | d | S | seen on a packaged macOS app; the Windows menu is untested | status: partial | remaining: Windows application menus have not been exercised
- [ ] P14 Context menus: native including images | apps/desktop/src/window/ContextMenuImage.ts | d | S | N/A as written: the app draws its own menus, and the OS webview gives text and images its native menu; not checked on Windows
- [x] P15 Running-thread keep-alive: blocks sleep during work | apps/web/src/components/desktop/RunningThreadKeepAlive.tsx | d | S | seen holding a sleep assertion for a run and letting go after; Windows untested | status: partial | remaining: Windows keep-awake behavior has not been observed
- [ ] P16 Saved environments catalog: local secure store | apps/desktop/src/app/DesktopConnectionCatalogStore.ts | d | M | N/A: saved environments are remote access, out of scope | scope: excluded | reason: remote environment catalog
- [x] P17 Mac permissions helper: checklist with settings window | apps/desktop/src/permissions/MacPermissions.ts | d | M | Settings lists Accessibility and Screen Recording with a link to each pane; macOS only
- [ ] P18 Provider auth callback: Codex sign-in return | apps/desktop/src/app/CodexAuthCallback.ts | d | M | [auth-risk] | N/A: hard rule 1, engines keep their own login | scope: excluded | reason: engine sign-in callback
- [x] P19 Local environment auth: tokens for bundled server | apps/desktop/src/backend/DesktopLocalEnvironmentAuth.ts | d | M | per-launch token over loopback, set by `orbynd`; desktop viewer storage now uses a stable bundled asset origin and an authenticated explicit loopback transport. An isolated macOS package retained Light across service recovery and full quit/relaunch, rendered a real local SVG and terminal prompt, and handled a second-launch route. Windows GUI qualification of this transport remains unverified; this is not a full final-package walkthrough
- [ ] P20 V1 local storage merge: drafts, stash, layout, theme | apps/desktop/src/legacyLocalStorageMerge.ts | d | M | N/A: there is no earlier version of this app to merge from | status: not_doable | reason: Orbyn has no predecessor released local-storage format to merge; there is no legacy source for this upgrade
- [ ] P21 Linux secret storage: keyring integration | apps/desktop/src/linuxSecretStorage.ts | d | M | N/A: Linux is not a target, and the shell stores no secrets | scope: excluded | reason: Linux is outside the macOS and Windows target
- [ ] P22 Windows foreground: focus handling | apps/desktop/src/electron/WindowsForeground.ts | d | M | tao forces the foreground in `set_focus`, so no code is owed; not observed on Windows
- [ ] P23 View menu: reload, force reload, DevTools, actual size, zoom in and out (including keypad keys), full screen | apps/desktop/src/window/DesktopApplicationMenu.ts | d | S | all items built and zoom seen working and restored; Reload, Force Reload and DevTools not pressed on a real app yet
- [ ] P24 Edit and Window menus: paste as plain text, macOS Speech, minimize, zoom, File menu Settings and Close Window | apps/desktop/src/window/DesktopApplicationMenu.ts | d | S | all items built; Paste as Text and Speech not pressed on a real app yet
- [ ] P25 Desktop packaging channels: winget, Homebrew cask, deb (self-updating with password prompt), AUR stable and nightly, Nix, GitHub Releases | docs/user/install.md | d | M | open: needs a public release first; only GitHub Releases applies today, and it is unpublished | scope: mixed | local: macOS and Windows desktop distribution channels | excludes: Linux packages and Linux package-manager prompts
- [ ] P26 CLI install scripts: shell and PowerShell installers to `~/.local/bin`, nightly channel and exact-version pins, Intel Mac desktop only | docs/user/install.md | c | M | open: needs published `orbyn` assets; the app can install the command itself (P12)
- [x] P27 System theme following: reads Linux color scheme and OS theme | apps/desktop/src/electron/LinuxColorScheme.ts | d | S | the webview follows the OS and `App.tsx` applies it; Linux is N/A | scope: mixed | local: macOS and Windows system-theme following | excludes: Linux color-scheme integration
- [ ] P28 Menu-bar popover: icon with running count; popover lists running, needs you, finished unseen and plan usage read on open | src-tauri/src/tray.rs | d | L | beyond T3 | beyond T3: the tray shows the running count and tooltip; the popover is not built | scope: excluded | reason: no menu-bar task/usage popover in inspected T3 desktop sources; the extra Orbyn tray behavior requires separate removal review before final shell parity
- [ ] P29 Quick launcher: global shortcut opens a small window for new and running threads; manual open when shortcut registration fails | src-tauri/src/overlay.rs | d | L | beyond T3 | beyond T3: not built | scope: excluded | reason: no global-shortcut thread-launcher window in inspected T3 desktop sources; screenshot shortcuts and the normal CLI are separate features
- [x] P30 Idle-gated update install: install and restart only with no run active and two idle minutes; modes Automatic, Notify, Off | src/app-updates-policy.ts | d | S | server done: `off` stops installs here; background checks keep their own setting | status: partial | remaining: the shell-side update behavior still needs native evidence
- [x] P31 Deterministic tool search path: ordered install folders, version-manager defaults and npm prefix read from config, added once at startup without sourcing a shell | src-tauri/src/providers/launch.rs | d s | M | alternative to P2 | server done: `crates` side; PATH for the desktop shell is the lead's | status: partial | remaining: the shell-side search path still needs native evidence
- [x] P32 Windows installer settings: per-user install, silent WebView2 bootstrapper, static C runtime, native arm64 build | scripts/release/build.mjs | d | M | per-user NSIS, embedded silent bootstrapper, static C runtime checked in CI on the installed files; arm64 is built, not run | status: partial | remaining: the native arm64 package has not been run
- [x] P33 Packaged-app startup smoke: install the built package on a disposable hosted runner with isolated profile folders and no secrets, and check it stays alive | scripts/release/ci-startup-smoke.mjs | d c | M | `scripts/smoke-app.mjs`: both platforms, and the UI must connect from the window
- [x] P34 Release evidence: per-asset checksums, installer and lockfile SBOMs, coverage report where an empty scan reads "incomplete", actions pinned by commit | docs/releasing.md | c | M | `scripts/release-evidence.mjs`: checksums and a lockfile SBOM, and an empty source fails; installers themselves are not scanned | status: partial | remaining: installer contents are not covered by the recorded SBOM scan
- [ ] P35 Notarization check: require credentials for Developer ID builds, verify with stapler and spctl, retry stapling | scripts/release/build.mjs | d c | S | `scripts/verify-macos-release.sh` is written and checked for syntax only: no Developer ID build has run it

## Q. Mobile
- [ ] Q1 Adaptive workspace: phone tabs, tablet panes, inspector | apps/mobile/src/features/layout/AdaptiveWorkspaceLayout.tsx | m | L | scope: excluded | reason: mobile client only
- [ ] Q2 Native navigation: iOS glass and Android bars | apps/mobile/src/features/workspace/WorkspaceNativeTabs.ios.tsx | m | L | scope: excluded | reason: mobile client only
- [ ] Q3 Home thread list: filters, search, swipe actions | apps/mobile/src/features/home/HomeScreen.tsx | m | L | scope: excluded | reason: mobile client only
- [ ] Q4 New task flow: project, branch, model pickers | apps/mobile/src/features/threads/NewTaskDraftScreen.tsx | m | L | scope: excluded | reason: mobile client only
- [ ] Q5 Thread screen: feed, composer, header | apps/mobile/src/features/threads/ThreadDetailScreen.tsx | m | L | scope: excluded | reason: mobile client only
- [ ] Q6 Native composer editor: custom module | apps/mobile/modules/t3-composer-editor | m | L | scope: excluded | reason: mobile client only
- [ ] Q7 Native highlighter: code module | apps/mobile/modules/t3-highlights | m | L | scope: excluded | reason: mobile client only
- [ ] Q8 Git sheets: overview, branches, commit, confirm | apps/mobile/src/features/threads/GitOverviewSheet.tsx | m | M | scope: excluded | reason: mobile client only
- [ ] Q9 Agents sheet: subagent list and stop | apps/mobile/src/features/threads/ThreadAgentsSheet.tsx | m | M | scope: excluded | reason: mobile client only
- [ ] Q10 Guest bar: send or dismiss guest messages | apps/mobile/src/features/threads/ThreadGuestShareBar.tsx | m | S | [hosted] | scope: excluded | reason: mobile client only
- [ ] Q11 Connections: environments list, routes, pairing | apps/mobile/src/features/connection/ConnectionsRouteScreen.tsx | m | L | scope: excluded | reason: mobile client only
- [ ] Q12 QR pairing: scan pairing link | apps/mobile/src/features/connection/pairing.ts | m | M | scope: excluded | reason: mobile client only
- [ ] Q13 Connect profile: account and deregister | apps/mobile/src/features/cloud/T3ConnectProfilePage.tsx | m | M | [hosted] | scope: excluded | reason: mobile client only
- [ ] Q14 Connect onboarding: first-run sign-in path with opt-out | apps/mobile/src/features/cloud/ConnectOnboardingRouteScreen.tsx | m | M | [hosted] | scope: excluded | reason: mobile client only
- [ ] Q15 Push notifications: finish, fail, approval, input alerts | apps/mobile/src/features/agent-awareness/remoteRegistration.ts | m | L | [hosted] | scope: excluded | reason: mobile client only
- [ ] Q16 Live Activities: iOS ongoing agent state | apps/mobile/src/features/agent-awareness/agentLiveActivity.ios.ts | m | L | [hosted] | scope: excluded | reason: mobile client only
- [ ] Q17 Android ongoing cards: Live Update where supported | apps/mobile/src/features/agent-awareness/androidNotifications.ts | m | L | [hosted] | scope: excluded | reason: mobile client only
- [ ] Q18 Mobile palette: iPad keyboard Cmd+K | apps/mobile/src/features/keyboard/CommandPalette.tsx | m | M | scope: excluded | reason: mobile client only
- [ ] Q19 Hardware keyboard: thread shortcuts | apps/mobile/src/features/keyboard/HardwareKeyboardCommandProvider.tsx | m | M | scope: excluded | reason: mobile client only
- [ ] Q20 App shortcuts: launcher quick actions | apps/mobile/src/features/shortcuts/appShortcuts.ts | m | S | scope: excluded | reason: mobile client only
- [ ] Q21 Over-the-air updates: background download, apply on leave | apps/mobile/src/features/updates/app-updates.ts | m | M | [hosted] | scope: excluded | reason: mobile client only
- [ ] Q22 Crash reports: relay to Axiom, toggle | apps/mobile/src/features/diagnostics/crash-log-model.ts | m | S | [hosted] | scope: excluded | reason: mobile client only
- [ ] Q23 Client storage page: local data view | apps/mobile/src/features/settings/SettingsClientStorageRouteScreen.tsx | m | S | scope: excluded | reason: mobile client only
- [ ] Q24 Server controls: maintenance per environment | apps/mobile/src/features/settings/SettingsServerControlsRouteScreen.tsx | m | M | scope: excluded | reason: mobile client only
- [ ] Q25 Provider accounts: mobile sign-in | apps/mobile/src/features/settings/SettingsProviderAccountsRouteScreen.tsx | m | M | [auth-risk] | scope: excluded | reason: mobile client only
- [ ] Q26 Mobile scheduled tasks: full task editor | apps/mobile/src/features/settings/SettingsScheduledTasksRouteScreen.tsx | m | M | scope: excluded | reason: mobile client only
- [ ] Q27 Mobile PR guide: next/back stop reader | apps/mobile/src/features/pull-requests/PullRequestGuideScreen.tsx | m | M | scope: excluded | reason: mobile client only
- [ ] Q28 Android FAB: home new-thread action | apps/mobile/src/features/home/AndroidHomeFab.tsx | m | S | scope: excluded | reason: mobile client only
- [ ] Q29 Mobile HTML/MCP renders: webviews with sizing | apps/mobile/src/features/threads/McpAppWebView.tsx | m | M | scope: excluded | reason: mobile client only
- [ ] Q30 Mobile add project: local, repository, new routes | apps/mobile/src/features/projects/AddProjectScreen.tsx | m | M | scope: excluded | reason: mobile client only
- [ ] Q31 Navigation tabs setting: reorder, hide and reset phone tabs | apps/mobile/src/features/settings/SettingsNavigationRouteScreen.tsx | m | S | scope: excluded | reason: mobile client only
- [ ] Q32 Return key setting: Return sends or inserts a new line on hardware keyboard | apps/mobile/src/features/settings/SettingsKeyboardRouteScreen.tsx | m | S | scope: excluded | reason: mobile client only
- [ ] Q33 Mobile appearance: text scale per role, code surface, terminal text, Android navigation style | apps/mobile/src/features/settings/appearance/sections/TextAppearanceSection.tsx | m | M | scope: excluded | reason: mobile client only
- [ ] Q34 Project grouping setting: mobile grouping choice | apps/mobile/src/features/settings/SettingsProjectGroupingRouteScreen.tsx | m | S | scope: excluded | reason: mobile client only
- [ ] Q35 Floating working status: pill shows working, syncing, compacting, child input, background work and snoozed, settled or woke with an action | apps/mobile/src/features/threads/floating-working-status.ts | m | M | scope: excluded | reason: mobile client only
- [ ] Q36 Undo notice and git progress: undo bar on the thread list; progress overlay for git actions | apps/mobile/src/features/threads/GitActionProgressOverlay.tsx | m | S | scope: excluded | reason: mobile client only
- [ ] Q37 Mobile review sheet: review sections menu, file visibility, line selection, comment composer sheet | apps/mobile/src/features/review/ReviewSheet.tsx | m | L | scope: excluded | reason: mobile client only
- [ ] Q38 Mobile PR screens: discussion, inline comment, labels, edit, filter search, merge controls | apps/mobile/src/features/pull-requests/PullRequestDiscussionScreen.tsx | m | L | scope: excluded | reason: mobile client only
- [ ] Q39 Startup crash log: Settings, Diagnostics lists last 7 days with error and component stack to copy | apps/mobile/src/features/diagnostics/SettingsDiagnosticsRouteScreen.tsx | m | S | scope: excluded | reason: mobile client only
- [ ] Q40 Legal documents: terms and privacy pages in settings | apps/mobile/src/features/settings/SettingsLegalRouteScreen.tsx | m | S | scope: excluded | reason: mobile client only

## R. RPC surface, grouped (`packages/contracts/src/rpc.ts`, plus `orchestrationV2.ts`)

Orbyn has HTTP routes where T3 has RPC methods. A group is ticked only when every method
it names has an equivalent route, and each open group says what it lacks. Reconciled
against `docs/architecture.md`'s route table on 1 November 2026.

- [ ] R1 Projects (10): listEntries, listIgnoredFiles, readFile, searchContents, searchEntries, writeFile, mutate, ensureScratch, createNew, createFromThread | w d m s | L | server: all but `mutate`, which has no route: `files/content` only reads and saves
- [ ] R2 Shell, filesystem, sessions, assets (9): shell.openInEditor; filesystem.browse, getMetadata; agentSessions.scan, import; assets.createUrl, persistChatAttachments; attachments.createUploadUrl, delete | M | server: open in editor, `fs/browse` and attachments; no `getMetadata`, session scan or import (I33), or asset URLs, since `files/raw` serves bytes
- [ ] R3 MCP Apps (4): callTool, toolInfo, readResource, updateModelContext | M | not built: C24 to C26
- [ ] R4 Provider (15): uploadFeedback; auth start, complete, respond, cancel, logout, subscribe; consumeResetCredit; chatgpt reconnect-profile, import-profile, handoff.subscribe; install start, cancel, subscribe, remove | L | [auth-risk] | server: `/api/acp/registry` covers install and remove; feedback (I9) is not built and the rest stays out under rule 1 | scope: mixed | local: provider feedback and local installation, progress and removal | excludes: authentication, accounts and credit redemption
- [ ] R5 VCS and git (11): vcs pull, refreshStatus, listRefs, createWorktree, removeWorktree, createRef, switchRef, init; git runStackedAction, resolvePullRequest, preparePullRequestThread | L | server: all but `refreshStatus` and `removeWorktree`: a worktree is made with its thread and goes through storage cleanup
- [x] R6 Review and terminal (10): review getBranchCommits, getDiffPreview, getDiffFileContents; terminal open, attach, observe, write, resize, clear, close | L | server done: `commits`, `diff` and `changes/file` for review; `/ws/terminal` and `/terminals` for terminals
- [ ] R7 Preview and devices (19): preview open, resize, adjust, close, list, clearProfile, reportProfiles, reportStatus, stopLocalServer; device configure, list, testHost, easAccount, simlockIdentity, open, close, shutdown, detail, action | L | server: all of preview, with `reportProfiles` and `reportStatus` not needed since the service owns tabs; devices are not built (section H)
- [ ] R8 Server core (14): probe, getConfig, getNpmRelease, refreshProviders, updateProvider, updateServer, updateServerWithProgress, commitDesktopUpdate, upsertKeybinding, removeKeybinding, runStorageCleanup, getStorageCleanupReport, getDatabaseStorage, updateSettings | L | server: all but `removeKeybinding`, and `updateServerWithProgress`, which `/api/updates/events` covers; `getNpmRelease` has no meaning without an npm package
- [ ] R9 ACP Registry (11): search, prepareAgent, uninstallManagedBinary, acceptUrlAuth, listSessions, importSession, deleteSession, listProviders, setProvider, disableProvider, logout | L | [auth-risk] | server: search, install and remove; sessions are I33, and URL auth and provider logout stay out under rule 1 | scope: mixed | local: local registry, installation and native-session management | excludes: URL authentication, logout and account/provider credential handling
- [ ] R10 Diagnostics and usage (12): discoverSourceControl, getTraceDiagnostics, getProcessDiagnostics, getHostResources, getProcessResourceHistory, getResourceTelemetryHistory, retryResourceTelemetry, checkOtlpEndpoint, prepareTriage, signalProcess, reportClientActivity, getUsageSummary, refreshUsageRates | M | server: `/api/diagnostics`, `/api/forges`, the OTLP check and `/api/usage`; process and resource telemetry, trace and triage are not built
- [ ] R11 Links, tasks, secrets, sharing, cloud (15): peerLinks list, link, unlink, answerRequest; scheduledTasks subscribe, upsert, setEnabled, delete, runNow, rotateWebhookToken, listWebhookDeliveries, getWebhookDelivery; secrets.answerRequest; guestShare.create; cloud getRelayClientStatus, installRelayClient | L | [hosted] | server: all of `scheduledTasks` under `/api/tasks`; links, secrets, sharing and cloud are out of scope | scope: mixed | local: local scheduled-task operations and deliveries | excludes: peer links, secrets, guest sharing and cloud relay
- [ ] R12 Pull requests (31): list, listStats, filterOptions, summary, routing, routingIdentity, stack, linkedThreads, detail, preview, checks, activity, reviewGuide, generateReviewGuide, threadComments, diffFileContents, filesViewed, changeBreakdown, setFilesViewed, runAction, update, comment, updateComment, submitReview, replyToThread, setThreadResolution, setReaction, invalidate, reportState, subscribeRefreshes, reviewerCandidates, requestReviewers, labelCandidates, setLabels | L | server: all but review guides (F42), `routing` and `routingIdentity` (F50)
- [ ] R13 Source control, clones, subscriptions (24): sourceControl lookupRepository, cloneRepository, publishRepository, signInStart, signInWait, signInCancel, appAccess, starred; projectClone start, cancel, retry; worktreeSetup.cancel; subscribe ProjectClones, VcsStatus, WorktreeSetup, TerminalMetadata, PreviewEvents, DiscoveredLocalServers, DeviceState, ServerConfig, ServerLifecycle, AuthAccess, ResourceTelemetry | L | server: clones and publishing; sign-in stays out under rule 1, and subscriptions are SSE per stream, with no device or resource stream | scope: mixed | local: local source-control, clone, worktree and subscription operations, including local desktop device/emulator state | excludes: sign-in, hosted app access and remote/device-host subscriptions
- [ ] R14 Orchestration (18): dispatchCommand, getTurnDiff, getFullThreadDiff, searchThreads, searchThread, searchThreadStream, getArchivedShellSnapshot, getThreadFamily, getWorktreeThreadIds, getOlderSettledThreads, getThreadProjection, getWorkflowScript, stopWorkflow, forceStopThread, getTurnItem, launchThread, subscribeShell, subscribeThread, subscribeCommandOutput | L | server: all but `getWorkflowScript` and `stopWorkflow` (M13); `subscribe*` are the event streams
