# web

The React UI, shared by the desktop app and the browser. It holds task flows
only: authority and lifecycle rules live in the service
([docs/architecture.md](../docs/architecture.md)).

## Contract

It talks to `orbynd` only through the HTTP API and streams in `src/api`, using
the types generated from `crates/orbyn-contracts` into `src/generated`. Run
`npm run generate` after a contract change. It imports no Tauri API; ESLint
enforces that.

## Consumers

- `orbynd` serves the built `dist/` as its static UI.
- `desktop/src-tauri` bundles the same build.

## Folders

| Folder | Owns |
| --- | --- |
| `src/app` | The shell, shortcuts and startup |
| `src/features/<name>` | One capability each: onboarding, panels, pulls, settings, thread, usage, workspace |
| `src/api` | The HTTP client, streams, origin and token |
| `src/state` | App-wide stores: route, UI, workspace, health toasts |
| `src/ui` | Visual primitives and shared presentation, content rendering and interaction helpers |
| `src/lib` | Small helpers shared by several features |
| `src/styles` | Tokens, themes and page styles |
| `src/generated` | Generated contract types; never edited by hand |

Imports point inward: `app` may use features, and features may use the shared
folders (`api`, `state`, `ui`, `lib`, `styles`, `generated`). Shared folders never
import a feature or `app`, and ESLint fails the change that tries. A file used by
one feature lives in that feature.

Features compose another capability only through its explicit `public.ts` entry
point. These entry points expose the components needed by real callers; local
implementation files keep direct imports within their own feature. ESLint rejects
cross-feature deep imports in static imports, re-exports, dynamic imports and
TypeScript import types. App composition may select feature implementation files.

Reusable owners live inward rather than behind feature re-exports:

- `state/thread` owns event projection and live thread logs; `state/composer`
  owns context chips shared by panels and the composer.
- `state/threads` owns list actions, grouping and undo; `state/sideChat` owns
  opening and selecting side chats.
- `lib/projectActions` owns project-script execution and preview routing.
- `ui/markdown`, `ui/pullLink` and `ui/FileMedia` own shared content rendering;
  `ui/starPrompt`, `ui/RunState` and `ui/FolderBrowser` own reused presentation.

Feature entry points expose higher-level composition: thread conversation and
model controls, panel surfaces, pull details and history import. Thread views
compose panels, and panels compose conversation components; these UI composition
edges remain explicit. Shared stores and rendering code never depend on them.

## Tests

Unit tests sit beside their file as `*.test.ts(x)` and run with `npm test`.
Browser tests are in `e2e/`, against the mock API (`mock/`) or a real service
(`e2e/real`).

## Known limitations

- `src/lib` still holds project image and identity helpers used by both `ui` and
  `settings`.
- Boundary checks cover relative module paths. Computed dynamic import paths and
  test fixtures are not checked. The project defines no source import aliases.
