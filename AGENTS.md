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

[CONTRIBUTING.md](CONTRIBUTING.md) holds the detail. Standing orders:

- Parity work: one branch per section and one small commit per completed row
  ([branches and commits](CONTRIBUTING.md#branches-and-commits)). Merge `main` into
  active branches at least daily and deliver ready green batches daily.
- Each checkout and worktree builds into its own `target/`; never share one
  `CARGO_TARGET_DIR` ([why](CONTRIBUTING.md#keep-cargo-artifacts-private-to-each-worktree)).
- Merge only with every required check green on the current head, by merge commit,
  never squash. Never weaken a check or merge red ([protected main](CONTRIBUTING.md#protected-main)).
- Commit `web/src/generated` in the same commit as every contract change.
- No agent or tool attribution in commits, titles or branch names. AI use goes only
  in the pull request's [AI usage](CONTRIBUTING.md#ai-usage) section.
- Titles are `type(scope): summary`, at most 72 characters ([titles](CONTRIBUTING.md#titles)).
- Anything deferred gets an issue before the pull request merges
  ([leaving work behind](CONTRIBUTING.md#leaving-work-behind)).

Windows and macOS are both supported targets. Never add a Unix-only path, shell
or signal without its Windows branch and a test on the CI matrix.

Shared engineering methods live in the outer `orbyn-fullstack-skills` workspace.
Do not copy them into this repository.
