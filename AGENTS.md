# Orbyn Engineering app

Picking this project up? Start with [docs/handoff.md](docs/handoff.md).

Read [docs/architecture.md](docs/architecture.md) before changing behavior. Its
hard product rules and lifecycles are the contract; change that document in the
same commit as any change to them.

## Layout

- `crates/orbyn-contracts`: wire types. Run `npm run generate` in `web` after edits.
- `crates/orbyn-core`: all product behavior, in capability groups under `src/`.
  A new module joins a group in [its README](crates/orbyn-core/README.md#groups),
  and a new group adds its own README and a row there.
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

Every pull request fills in the template's AI usage section: whether AI was used
or the change was written by hand; if AI was used, the harness (such as Claude Code
or Codex) with its version, every model by exact ID and what each did, the effort
level, what a person decided or changed, and every outside source. Write only what
actually ran. The PR check fails while the section is empty.

Commits and branch names carry no agent or tool attribution: no `Co-Authored-By`
trailer for an assistant, no generated-by line, and no model or tool name in commit
messages, pull request titles or branch names. The AI usage section is the one place
for it.

Pull request and issue titles use `type(scope): summary`, with a kind from
CONTRIBUTING.md's list and a summary of at most 72 characters; the Title check
fails while a title does not fit.

Windows and macOS are both supported targets. Never add a Unix-only path, shell
or signal without its Windows branch and a test on the CI matrix.

Shared engineering methods live in the outer `orbyn-fullstack-skills` workspace.
Do not copy them into this repository.
