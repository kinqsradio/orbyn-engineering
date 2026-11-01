# Orbyn Engineering app

Picking this project up? Start with [docs/handoff.md](docs/handoff.md).

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

## Delivery

For parity work, use one active branch per section. Make one small commit per
completed row, and keep the commits separate so a regression can be found and
reverted. Run the affected local checks before pushing.

Open one pull request when a section or a coherent group of about 20 rows is
ready. Merge it into `main` only after every required check is green on the current
head: Rust and desktop on both macOS and Windows, Web, and E2E. Never weaken checks
or merge red. Use a merge commit; do not squash the per-row commits. Keep branches
current by merging `main` into active section branches at least daily, and deliver
ready green batches daily. Use short-lived `feat/`, `fix/`, `docs/` or `chore/`
branches named for the section or purpose.

Commit `web/src/generated` in the same commit as every contract change.

Commits and pull requests carry no agent or tool attribution. Do not add
`Co-Authored-By` trailers for an assistant, generated-by lines, or a model or tool
name to commit messages, pull request titles or bodies, or branch names.

Windows and macOS are both supported targets. Never add a Unix-only path, shell
or signal without its Windows branch and a test on the CI matrix.

Shared engineering methods live in the outer `orbyn-fullstack-skills` workspace.
Do not copy them into this repository.
