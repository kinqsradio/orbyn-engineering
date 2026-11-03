# Contributing

Thanks for helping. Everyone here follows the [code of conduct](CODE_OF_CONDUCT.md).
Read [AGENTS.md](AGENTS.md) and
[docs/architecture.md](docs/architecture.md) before you change behaviour. The
architecture's product rules and lifecycles are the contract; change that document
in the same commit as any change to them.

## Before you start

- Open an issue first for anything larger than a small fix, so the maintainer of
  that area can agree the approach. Use the issue forms; blank issues are off.
- Features come from the planned list in [docs/parity.md](docs/parity.md). Cite
  the row in the issue. A screen, control or status word that is not on the list
  needs the maintainer's agreement first.
- Write your own code. Do not copy source from another project. Packages and
  programs the app uses are listed in [UPSTREAM.md](UPSTREAM.md).
- Windows and macOS are both supported. Never add a Unix-only path, shell or signal
  without its Windows branch and a test on the CI matrix.

## Maintainers

Each area has a maintainer, who is asked for review automatically through
[.github/CODEOWNERS](.github/CODEOWNERS). Tag them in an issue with the mention
below, and use the area label.

| Area | Paths | Label | Maintainer |
| --- | --- | --- | --- |
| Core behaviour: runs, drivers, workspace, approvals, storage | `crates/orbyn-core/` | `area: core` | @kinqsradio |
| Wire contracts and generated types | `crates/orbyn-contracts/`, `web/src/generated/` | `area: contracts` | @kinqsradio |
| Local service and CLI | `crates/orbynd/` | `area: service` | @kinqsradio |
| Web UI | `web/` | `area: web` | @kinqsradio |
| Desktop shell, packaging and updates | `desktop/` | `area: desktop` | @kinqsradio |
| Bundled skills library | `scripts/library.lock`, `scripts/prepare-bundle.mjs` | `area: library` | @kinqsradio |
| CI, release and repository settings | `.github/`, `scripts/` | `area: ci` | @kinqsradio |
| Documentation | `docs/`, `*.md` | `area: docs` | @kinqsradio |
| Security reports | [SECURITY.md](SECURITY.md) | `security` | @kinqsradio |

One person maintains every area today. To take on an area, open an issue that
names it; the maintainer adds you here and in CODEOWNERS in the same pull request.

## Labels

Labels are defined in [.github/labels.json](.github/labels.json). Pull requests
get area labels from the paths they change, through
[.github/labeler.yml](.github/labeler.yml). After editing the definitions, a
maintainer applies them with:

```bash
node scripts/sync-labels.mjs
```

| Group | Labels |
| --- | --- |
| Kind | `bug`, `enhancement`, `documentation`, `question`, `accessibility`, `security`, `dependencies` |
| Area | `area: core`, `area: contracts`, `area: service`, `area: web`, `area: desktop`, `area: library`, `area: ci`, `area: docs` |
| Engine | `engine: claude`, `engine: codex`, `engine: acp` |
| Platform | `platform: macos`, `platform: windows` |
| Workflow | `needs triage`, `parity`, `good first issue`, `help wanted`, `duplicate`, `invalid`, `wontfix` |

## Branches and commits

- Branch from `main` with a short purpose name: `feat/`, `fix/`, `docs/`,
  `chore/` or `refactor/`.
- For parity work, use one branch per section and one small commit per completed
  row, so a regression can be found and reverted.
- Write [Conventional Commits](https://www.conventionalcommits.org/) subjects,
  such as `fix(codex): wait for tools before the first turn`.
- Commit `web/src/generated` in the same commit as every contract change. Run
  `npm run generate` in `web` after editing `crates/orbyn-contracts`.
- Commits and pull requests carry no agent or tool attribution: no
  `Co-Authored-By` trailer for an assistant, no generated-by line, and no model or
  tool name in messages, titles, bodies or branch names.
- Keep active branches current by merging `main` into them at least daily.

## Checks

Run the affected checks locally before pushing:

```bash
cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
```

```bash
cd web && npm run check && npm test
```

Six CI checks are required on the current head before a merge: Rust on macOS and
Windows, Web, E2E, and the unsigned desktop build on macOS and Windows. Never
weaken a check or merge red. Do not turn on auto-merge until E2E has passed on that
exact commit.

The end-to-end suite runs in Playwright's headless shell, never your installed
Chrome. Launch the packaged app after changes to the desktop shell; a passing build
has hidden a crash on startup before.

## Pull requests

- Open one pull request when a section, or a coherent group of about 20 rows, is
  ready. Fill in the template.
- Say what you verified and what you did not. Mock data and the fake engines have
  hidden real bugs, so name any real engine or platform run.
- Merge with a merge commit. Do not squash the per-row commits.
- Never include secrets, engine credentials, personal data or files from your own
  machine. The repository is public.

## Dependencies

Dependabot opens weekly grouped minor and patch updates for Cargo, npm and GitHub
Actions. Review them like any other change: every required check must pass. It does
not propose major versions of Cargo or npm packages: those change APIs, so they are
planned work in an issue labelled `dependencies`, done in their own pull request.
Pin GitHub Actions to a full commit SHA with the version in a comment.
