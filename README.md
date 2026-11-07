# Orbyn Engineering

Orbyn Engineering is the Builders app in the Orbyn line: a desktop workspace for
coding agents, with every builder tool inside. It runs on your own Claude, Codex and
other engine accounts, with their own login, inside the
[orbyn-fullstack-skills](https://github.com/orbyn-dev/orbyn-fullstack-skills)
library as the harness. It is free locally, with Pro for remote access and sync. The
core is Rust, the UI is React, and the desktop app is a thin Tauri 2 shell. It targets
Windows and macOS.

Orbyn apps share four promises: private by design, local first, one account and agent
ready. Memory, Review gate, Skills, Diagrams, Security audit and Inspect are features
inside this app, not separate apps.

The code is our own. [UPSTREAM.md](UPSTREAM.md) lists the outside programs,
protocols and packages it uses.

> [!IMPORTANT]
> The app is not finished. Run `python3 scripts/count-parity.py` for the current
> count of [docs/parity.md](docs/parity.md). There are no releases yet.

## What it does

- **Threads with real engines.** Claude through its CLI, Codex through its app
  server, any Agent Client Protocol agent, AG-UI agents and plain terminal tools.
  Orbyn never reads or stores engine credentials.
- **Built-in skills library.** The app ships a snapshot of the library and sets it
  up by itself on first start, then updates it in the background. There is no
  setup screen.
- **Projects in place.** Add any folder. Nothing is cloned or moved. Worktrees go
  in a `<repo>-wt/<purpose>/` sibling folder.
- **Approvals and modes.** Supervised by default, with every write checked by the
  approval gate. Full access and the other modes are offered too.
- **Source control.** Diffs, checkpoints, commit, push, pull requests and branch
  switching from a thread.
- **Terminals, files, preview and search** in the side panels.
- **Model, reasoning effort and speed** read live from each engine, so the choices
  match your plan.
- **Engine updates** from the app, through the installer that owns each binary.

## Status of features

Statuses are the product plan's own words for each feature inside Orbyn Engineering.

| Feature | Status |
| --- | --- |
| Skills library | Exists |
| Memory | Next |
| Review gate | Next |
| Diagrams | After Memory |
| Security audit | Later |
| Inspect | Later, niche |

The plan's line for this app is "Free locally, Pro for remote access and sync", and its
subscription line says "Teams later". Four screens exist only as development-only
previews; see [docs/design.md](docs/design.md#planned-with-the-orbyn-platform).

## Layout

| Path | What it holds |
| --- | --- |
| `crates/orbyn-contracts` | Wire types. They generate `web/src/generated`. |
| `crates/orbyn-core` | All product behaviour: runs, drivers, workspace, approvals, storage. |
| `crates/orbynd` | The local service and CLI: transport only. |
| `web` | The React UI, shared by the desktop app and the browser. |
| `desktop/src-tauri` | The thin desktop shell. |
| `scripts` | Bundling, release and parity tools. `library.lock` pins the bundled library. |
| `docs` | Architecture, parity list, design and design inventory, handoff. |

[docs/architecture.md](docs/architecture.md) is the contract: its product rules
and lifecycles govern every change.

## Build and run

You need Rust 1.90 or later, Node.js 22 or later and Git. To use an engine,
install it and sign in with its own tool, for example `claude` or `codex`.

Run the service with a UI build:

```bash
cd web && npm ci && npm run build
```

```bash
cargo run -p orbynd --bin orbynd -- serve --ui-dir web/dist
```

It prints a local address and a session token. It binds to loopback only.

Run the UI against its mock API while you work on it. Set `ORBYN_API` to a
running service's address to use the real one instead:

```bash
cd web && npm run dev
```

Build the desktop app, after `npm ci` in `web`. This bundles the service, the UI
and the skills library pinned in `scripts/library.lock`:

```bash
cd desktop && npm ci && npm run build
```

## Checks

```bash
cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
```

```bash
cd web && npm run check && npm test
```

CI also runs the end-to-end suite and unsigned desktop builds on macOS and
Windows, and checks each pull request's AI usage section. All seven are required
before a merge, and `main` takes changes only through pull requests; see
[CONTRIBUTING.md](CONTRIBUTING.md#protected-main).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Each area of the code has a maintainer,
listed there and in [.github/CODEOWNERS](.github/CODEOWNERS), who is asked for
review automatically.

Report vulnerabilities privately, as [SECURITY.md](SECURITY.md) describes.
Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

## License

Source-available under the [PolyForm Strict License 1.0.0](LICENSE): the source is
readable, but the license allows personal, non-commercial use only, with no copies,
changes or resale. Third-party packages keep their own licenses; see
[web/NOTICE](web/NOTICE) and [UPSTREAM.md](UPSTREAM.md).
