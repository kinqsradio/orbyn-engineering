# Design

Orbyn's own look. Every feature in `docs/parity.md` stays; the interface no longer
copies T3 Code's appearance or layout. `docs/ui-parity-audit.md` remains the record of
behaviour checks; its pixel measurements against T3 are no longer targets.

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
- Project folders is the default arrangement ("Project folders" in Settings › Labs keeps
  working). A folder row shows the project badge, its name and an amber count of threads
  waiting on you. Its threads are nested rows (25px, 32px left padding, 12.5px) with the
  status at the right: spinner, amber dot, age or "Failed" in red. The flat arrangement
  still has pinned rows, the Working shelf, snoozed and settled groups, and drag and drop.
- Main sheet: `--color-background`, 12px top-left radius, 1px `--color-border` on the
  left and top. It has no border or radius when the sidebar is hidden.
- Page heading (`.topbar`, the shared `.ph`): 22px/28px padding, a 22px medium title with
  -0.015em tracking, a muted sub line (branch, run status) and actions at the right. The
  thread header, the new-thread header and Pull requests use it; `PageHeader` has the
  same title size. Page content pads 28px.
- Side panel: 380px (`--context-w`; a dragged width still wins), `--color-background`, 1px
  left border, and six fixed text tabs without icons (30px, 8px radius, 12.5px; the
  selected tab has the selected fill): Diff, Files, Browser, Activity, PRs ("Pull
  requests" to a screen reader) and Side chat. Maximise, the terminal toggle and Close end
  the row. Several of a kind live one level down, as 24px pills above the content: the
  Browser's pages (each closable, plus New tab) over its address bar, and a thread's side
  chats (plus New side chat). The terminal is a drawer under the thread with its own tabs.
  Choosing the selected tab again, or "Open a surface…" in the command palette, shows the "Open a surface" list with its letter shortcuts; Escape returns to the tab. The tab row is one tablist (arrow keys, Home, End) and fades at its edge when it overflows.

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
Labs.

## Planned with the Orbyn platform

The Orbyn Engineer Designs also draw four screens that need engine work that does not
exist yet (connected-app scopes and a remote-access relay): Sign in to Orbyn, Connect
Orbyn Planner, Remote access and pairing, and On a phone. They are not built, not even as
placeholders, and `docs/parity.md` records them as L52–L55.
