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

## AI usage

<!-- Required. Tick "Written by hand", or fill in every line below from what
actually ran. The PR check fails while this section is empty. -->

- [ ] Written by hand, with no AI
- Harness and version: <!-- such as Claude Code 2.1.150, Codex 0.166.0, Cursor -->
- Models: <!-- every model by exact ID and what it did, such as claude-opus-5-5 (lead, all code), or claude-opus-5-5 (plan, review) and claude-sonnet-5-5 (code) -->
- Effort: <!-- low, medium or high, per model if they differ -->
- Human role: <!-- what you decided, reviewed or changed yourself -->
- Sources: <!-- every outside project, document or page used, with a link, or "none" -->

## Checklist

- [ ] Works on Windows and macOS: no Unix-only path, shell or signal without its Windows branch and a CI test.
- [ ] `web/src/generated` is committed with any contract change.
- [ ] `docs/architecture.md` is updated in the same commit as any rule or lifecycle change.
- [ ] No source is copied from another project.
- [ ] No secrets, engine credentials, personal data or files from my machine.
- [ ] No agent or tool attribution in commits, the title or the branch name; AI use is recorded above.

Related issue:
