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

Light, Dark (pure black) and Dim (neutral `#101010`, a built-in dark preset). Custom
theme files and the other presets keep working through `THEME_TOKENS`. Literal colours
live only in `web/src/styles/tokens.css`; `tokens.test.ts` enforces it.

## Type

Geist for the interface and JetBrains Mono for code, commands and paths, both SIL OFL
and bundled through Fontsource so the desktop app works offline. Headings are medium
weight, never bold. Sizes stay on the scale in `tokens.css`.

## Surfaces

Borders belong to inputs, menus and dividers; cards and panels separate by fill.
Only floating layers (menus, popovers, tooltips) cast a shadow.

## Layouts

Console is the default: sidebar by project, conversation, and a side panel for changes,
browser and terminal. Ledger (sidebar by status, one row per run) and Reading (one
document column, panels as drawers) are presets in Settings › Appearance, built from
the same components.
