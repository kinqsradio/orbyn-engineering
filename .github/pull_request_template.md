<!-- Title: `type(scope): summary` under 72 characters, such as
`fix(web): keep the composer focused after send`. See CONTRIBUTING.md#titles. -->

## Summary

<!-- What changes for a user, and why, in one to three sentences. -->

Closes #

## Parity rows

<!-- Row IDs from docs/parity.md this closes or changes, such as I13, or "none". -->

## Testing

- [ ] Rust: `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`
- [ ] Web: `npm run check` and `npm test` in `web`
- [ ] Launched the packaged app (desktop shell changes only)

<!-- Anything else you ran and what it showed. Name any real engine or platform run:
mock data and the fake engines have hidden real bugs before. -->

Not tested:

## Co-authors

<!-- Everyone else who wrote or amended commits here, with their commits, or "none". -->

none

## AI usage

<!-- Required, and checked. Tick "Written by hand", or fill in every line from what
actually ran. -->

- [ ] Written by hand, with no AI
- Harness and version: <!-- such as Claude Code 2.1.150 or Codex 0.166.0 -->
- Models: <!-- every model by exact ID and what it did, such as claude-opus-5-5 (all), or claude-opus-5-5 (plan) and claude-sonnet-5-5 (code) -->
- Effort: <!-- low, medium or high, per model if they differ -->
- Human role: <!-- what you decided, reviewed or changed yourself -->
- Sources: <!-- outside projects, documents or pages used, with links, or "none" -->

## Checklist

- [ ] Works on Windows and macOS.
- [ ] `web/src/generated` is committed with any contract change, and `docs/architecture.md` with any rule change.
- [ ] No copied source, secrets, engine credentials or personal data.
- [ ] No AI attribution in commits, the title or the branch name.
