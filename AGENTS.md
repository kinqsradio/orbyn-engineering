# Orbyn Engineering app

Read [docs/architecture.md](docs/architecture.md) before changing behavior. Its
hard product rules and lifecycles are the contract; change that document in the
same commit as any change to them.

## Layout

- `crates/orbyn-contracts`: wire types. Run `npm run generate` in `web` after edits.
- `crates/orbyn-core`: all product behavior.
- `crates/orbynd`: transport and CLI only.
- `web`: React UI. No Tauri imports, no lifecycle rules.
- `desktop/src-tauri`: thin shell.

## Checks

```bash
cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
```

```bash
cd web && npm run check && npm test
```

Windows and macOS are both supported targets. Never add a Unix-only path, shell
or signal without its Windows branch and a test on the CI matrix.

Shared engineering methods live in the outer `orbyn-fullstack-skills` workspace.
Do not copy them into this repository.
