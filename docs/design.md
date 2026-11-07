# Design

Orbyn's own look. Every feature in `docs/parity.md` stays; the interface follows the
internal designs, not another product's appearance or layout. `docs/design-inventory.md`
maps every design screen and motion to this app.

## Sources of truth

The internal designs, in order of authority:

1. Engineer Designs: the screens of Orbyn Engineering.
2. Components: the shared controls.
3. Motion Designs: timing, easing and reduced-motion forms.
4. Account Designs: the account and connected-app screens that Engineering shows.

These are named in words only; the repository links to none of them. Their HTML is the
source of values.

There is one token file, `web/src/styles/tokens.css`. Its values come only from the
design artifacts' HTML. Phase 1 fills it. Where this document and a design disagree
about a value, the design wins; fix this document.

## Principles

- The person's job is to keep control of agents: see what each one is doing and what
  is waiting on them. Whatever needs them is the most visible thing on screen.
- Quiet by default. Ink carries the interface; colour only marks state.
- Familiar where it helps: projects and threads on the left, the work in the middle,
  context on the right.

## Colour

At most three colours in the interface:

| Role | Tokens | Use |
| --- | --- | --- |
| Ink | `--color-text` … `--color-faint`, `--color-primary`, `--color-info`, `--color-success` | Everything, including working and done states |
| Amber | `--color-warn*` | The person must act: approvals, questions, limits |
| Red | `--color-danger*`, `--color-diffDel*` | Failures, errors and removed lines |

Working is a spinner and done is a check, both in ink. Added diff lines use an ink
tint. ANSI terminal colours, project colours and provider tints are content the person
or a program chose, and stay as they are. Code highlighting uses ink shades with amber
for strings and numbers.

## Themes

Light, Dark (pure black) and Dim (neutral `#101010` sidebar on a `#161616` sheet, a
built-in dark preset). Dim has its full token set in `tokens.css` under
`:root[data-theme="dark"][data-preset="dim"]`; `applyTheme` sets `data-preset` and writes
no inline colours for it, so only a custom colour overrides Dim. The other presets and
custom theme files keep working through `THEME_TOKENS`. Literal colours live only in
`web/src/styles/tokens.css`; `tokens.test.ts` enforces it.

Ink is alpha white or black over the surface (`--color-text` 92-94%, `--color-textSoft`
74-78%, `--color-muted` 60-64%, `--color-faint` 52-54%). Muted and faint sit a few points
above the reference mock-up so small text keeps at least 4.5:1 on its surface.

## Type

Geist for the interface and JetBrains Mono for code, commands and paths, both SIL OFL
and bundled through Fontsource so the desktop app works offline. Headings are medium
weight, never bold. Sizes stay on the scale in `tokens.css`.

## Frame

The window is a 40px title bar over two columns: the sidebar and the main sheet. Tokens:
`--titlebar-h` 40px, `--sidebar-w` 224px, `--context-w` 380px, `--rail-w` 300px (Ledger
details), `--drawer-w` 360px (Reading panel), `--lights-w` 78px. The sizes 12.5px
(`--text-nav`), 11.5px (`--text-label`) and 22px (`--text-page`) joined the type scale.

- Title bar (`app/TitleBar.tsx`): 12.5px muted text with the sidebar toggle, "Orbyn"
  (medium weight, ink) and the page label (the thread title on a thread, otherwise the page
  name or the settings section). It carries the build identity at the right and, in Ledger, "N waiting on you" in
  amber. In the desktop app on macOS it leaves `--lights-w` on the left for the traffic
  lights; the browser build shows no spacer.
- Sidebar, 6px 10px 10px padding: a 32px "Search or ask ⌘K" row that opens the command
  palette (which searches threads, commands and messages); labelled 30px nav rows with
  icons (New thread, Pull requests, Usage, Scheduled tasks); a "Projects" label (11.5px,
  faint) with three small tools (search the list, filter by project, add project); then
  the thread list; Settings pinned at the bottom with the update, provider-update and
  undo notices above it. The selected row has the `--color-selected` fill.
- Project folders is the default arrangement ("Group threads by project" in Settings › Threads
  keeps working). A folder row shows the project badge, its name and an amber count of threads
  waiting on you. Its threads are nested rows (25px, 32px left padding, 12.5px) with the
  status at the right: spinner, amber dot, age or "Failed" in red. The flat arrangement
  still has pinned rows, the Working shelf, snoozed and settled groups, and drag and drop.
- Main sheet: `--color-background`, 12px top-left radius, 1px `--color-border` on the
  left and top. It has no border or radius when the sidebar is hidden.
- Page heading (`.topbar`, the shared `.ph`): 22px/28px padding, a 22px medium title with
  -0.015em tracking, a muted sub line (branch, run status) and actions at the right. The
  thread header, the new-thread header and the pages below use it (`ui/PageBar.tsx`);
  `PageHeader` has the same title size. Page content pads 28px.
- Side panel: 380px (`--context-w`; a dragged width still wins), `--color-background`, 1px
  left border, and six fixed text tabs without icons (30px, 8px radius, 12.5px; the
  selected tab has the selected fill): Diff, Files, Browser, Activity, PRs ("Pull
  requests" to a screen reader) and Side chat. Maximise, the terminal toggle and Close end
  the row. Several of a kind live one level down, as 24px pills above the content: the
  Browser's pages (each closable, plus New tab) over its address bar, and a thread's side
  chats (plus New side chat). The terminal is a drawer under the thread with its own tabs.
  Choosing the selected tab again, or "Open a surface…" in the command palette, shows the
  "Open a surface" list with its letter shortcuts; Escape returns to the tab. The tab row
  is one tablist (arrow keys, Home, End) and fades at its edge when it overflows.

## Thread

- Transcript: your message is a right-aligned `--color-message` bubble; the agent's text is
  soft ink. Tool calls read as a short trail (a 1px rule at the left, 26px rows, 12.5px
  muted text, ink icons). A failed call is the only red row: a red cross, the command, and
  "Output" at the end. A finished turn folds into one trail row.
- Needs you: an approval or question is an amber card (`--color-warnSoft`, 16px radius) with
  the label "Needs you · command" or "The agent asks". An approval shows the exact command
  in a mono box, then Why and Reaches or Runs in rows when the engine reports them, and
  ends with More (cancel the run), Deny, Always allow and Allow. A question lists numbered
  options (keys 1-9 pick one, Enter submits when every question has an answer and focus is
  not in a field) and keeps Dismiss and Submit answers.
- Subagents the engine reports show as chips above the composer while a turn runs; queued
  messages show as one quiet bar ("Queued · sends when this turn ends") that keeps Steer,
  Edit, Send now and Remove.
- Composer: a 16px-radius box with a 26px control row (attach, Plan, model, effort, access,
  send). Menus (model, access, mentions, slash commands) are the floating layer: 12px
  radius, 30px rows, mono shortcuts and hints.
- Banners: a usage limit is amber, a failure is red (a flat tint, no border), and context
  or reconnecting notices stay ink. A new worktree's card lists Path, Branch and Setup.
- Minimap: a 6px strip near the right edge, shown when the pointer reaches it. Ticks for
  your messages are ink and can be clicked; failures (red) and decisions waiting on you
  (amber) are marks.

## Pages

Pull requests, Usage and Scheduled tasks are pages in the main sheet, not overlays. Each
has the page heading and 28px content padding.

- Pull requests: filter pills (Open and Drafts, each with a count) beside search, Sort,
  Filters (state, draft, review, checks, author, label), the project filter and Refresh.
  Rows are a table: select box, title with its number, branch, project and author, Checks
  (Running, Failing, Passing or No checks), Review (changes requested is an amber pill),
  Updated, and row actions (Reopen, Ready for review, Merge, Close) that show on hover or
  focus. Selecting rows offers Close selected. A row opens the pull request as its own
  page with a back button and its title in the title bar; the list keeps its filters. The
  tabs are Summary, Guide, Timeline and Code. Summary has the description and conversation
  beside a side column: status card (status, branch, checks, changes), a merge method,
  Work on this, Close and Merge, then checks, reviewers and labels. On the other tabs and
  on a narrow window those actions move to the heading. A thread's side panel keeps the
  compact detail.
- Usage: tabs Usage and Limits under the heading. Usage has period, provider and metric
  (Cost, Tokens) controls, tiles for tokens, estimated cost and cache hits, the daily bar
  chart (hover reads a day), the providers, and the breakdown by model or day, where a
  model name opens its price. Cost adds the split by token type and tier. Limits is its
  own tab, fetched only there: a card per window with its meter, amber once less than 15%
  is left, and Refresh in the heading. `c`, `t` and `l` switch the view.
- Scheduled tasks: a table of task (with its project), when (with the next run or
  Paused), last run (a failure in red) and an On switch, with Run, Webhook address,
  Deliveries, Edit and Delete on each row and New task in the heading. The editor asks
  for the prompt first, then the project, schedule and name. Settings keeps its own
  Scheduled tasks section, which task links from a thread still open.

## Surfaces

Borders belong to inputs, menus and dividers; cards and panels separate by fill.
Only floating layers (menus, popovers, tooltips) cast a shadow.

## Getting started

`features/onboarding/onboarding.css` holds these screens' styles; tokens only.

- Welcome steps sit above home, 720px wide, each with a 22px title: an overview of the
  three steps (agents, projects, how agents ask) with "Skip for now" and "Start", then
  Connect an agent (a row per engine with a Ready pill, and an ACP registry row that opens Settings › Providers; a missing engine says "Install
  <name>, then check again"; a signed-out one shows its command to copy), Add a project
  (with the history import) and how agents ask. The last step explains the modes and links to
  Settings › Threads, which owns the default. "Back" and "Continue" move between steps.
- The empty home is a centred 20px "Add your first project", one muted line and the
  buttons: Clone from GitHub (opens the palette on its Git URL view), Add project, Start
  without a project, Welcome steps.
- Trust is a 480px card (16px radius, ring and shadow) titled "Trust <folder>?" with
  the full path below it, "Not now" and "Trust folder".
- A draft with a project docks its composer at the bottom (draft-scoped CSS); the heading
  and four suggestion chips centre above it. A chip fills the message and never sends it.
  Checkout, branch and permissions under the composer are 28px chips.
- Add project is views of the command palette: a source list, then a path field in mono
  with "Folders" rows that carry a Git or Folder hint at the right, then a divider and
  "Clone from GitHub".

## Layouts

Settings › Appearance › Layout picks one of three arrangements of the same components.
It is a device preference (`workspaceLayout`), set on `<html data-workspace>`, and it
changes arrangement and density only, never colour or behaviour.

- Console, the default: sidebar by project with its threads nested, the thread in the
  middle, the side panel as a 380px column on the right.
- Ledger: the sidebar lists Needs you (amber), Failed (red), Running and Done today, each
  with a count, instead of project folders; every row names its project. The nav moves to
  the bottom, above Settings. Rows give the title the room: no project column, and only a waiting or failed status word. Rows are denser and the 300px details rail opens at the
  right edge. Inside a thread, a "Needs you" strip stays pinned at the top of the
  transcript while a decision waits, with Show to jump to it; the decision itself stays on
  its card.
- Reading: the sidebar column folds away (the title bar toggle brings it back) and the details card
  stays closed unless asked for, the thread
  is one 680px column with roomier lines, and on a wide window the side panel floats over
  the thread as a 360px drawer with a shadow.

Layout rules live in `web/src/styles/layouts.css`; ordering lives in `attentionRank`.

Saved preferences carry a `prefsVersion`. Version 1 (the frame) moves a saved sidebar width
of exactly 208px to 224px and turns project folders on, once; a custom width stays. Someone
with saved preferences gets a one-time notice with Turn off; the option lives in Settings ›
Threads.

## Settings

Settings is a page in the frame's main area, not a dialog. A 260px section list sits on
the left: "Find a setting" search (it lists matching settings and reveals the chosen
row), then General to Keybindings, the Agents group (Providers, Threads, Scheduled tasks), the Code group (Projects, Source control, Worktrees), then Maintenance, Labs, About and Archive.
The open section shows a 22px title with a close button, an optional scope line ("Applying settings for"
a project, or "Applies to this computer" in General), then rows: 52px, a label with a small
description at the left, the control at the right, one hairline between rows. Toggles are 30x18
switches; Theme is System, Light, Dark and Dim (Dim is the dark theme with the Dim preset);
Layout is three cards (Console, Ledger, Reading) with a small plan of each. Escape or the
close button returns to the page behind. The page is a labelled region, not a dialog.

## Planned with the Orbyn platform

The Orbyn Engineer Designs draw four screens that need engine work that does not
exist yet (connected-app scopes and a remote-access relay): Sign in to Orbyn, Connect
Orbyn Planner, Remote access and pairing, and On a phone. They are
`preview-only` rows in `docs/design-inventory.md`, together with the phone preview's
"Paired machine offline" state. They are built as real components on sample
data in `web/src/features/platform`, behind a development-only build flag
(`__ORBYN_PREVIEWS__`, true outside `vite build`). Nothing in the app links to them;
they open by hash route only: `#/preview/account`, `#/preview/connect-planner`,
`#/preview/pair-phone` and `#/preview/phone`. In a production build the routes fall
through to the normal app and the code is not in the output (`npm run build` fails if it
is). Every control is disabled with the reason "Available with Orbyn accounts", and the
screens make no request. `docs/parity.md` records them as L52–L55, still excluded until
the platform wiring lands.
