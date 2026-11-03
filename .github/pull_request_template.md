## What changes

<!-- What a user sees or what behaviour changes, and why. -->

## Parity rows

<!-- Row IDs from docs/parity.md this closes or changes, such as I13 and I52, or "none". -->

## Verification

<!-- Commands you ran and what they showed. Name any real engine or platform run;
mock data and the fake engines have hidden real bugs before. -->

- [ ] `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings` and `cargo test --workspace`
- [ ] `npm run check` and `npm test` in `web`
- [ ] Launched the packaged app, if the desktop shell changed

Not verified:

## Checklist

- [ ] Works on Windows and macOS: no Unix-only path, shell or signal without its Windows branch and a CI test.
- [ ] `web/src/generated` is committed with any contract change.
- [ ] `docs/architecture.md` is updated in the same commit as any rule or lifecycle change.
- [ ] No source is copied from another project.
- [ ] No secrets, engine credentials, personal data or files from my machine.
- [ ] No agent or tool attribution in commits, the title, this body or the branch name.

Related issue:
