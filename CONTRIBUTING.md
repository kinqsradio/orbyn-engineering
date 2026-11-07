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

## Titles

Pull request and issue titles say what kind of change it is, in the same form as a
[Conventional Commits](https://www.conventionalcommits.org/) subject, so a title
reads like the commit it becomes:

```
type(scope): summary
```

- A kind is required: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`,
  `ci`, `chore`, `style` or `revert`. An issue may also use `question`, when the
  issue only asks something and no change is settled yet.
- A scope is optional and lowercase, and names the area the change touches, such
  as `feat(web):` or `fix(core):`. `!` before the colon marks a breaking change,
  as in `feat(core)!:`.
- The summary is a short imperative phrase: lowercase first letter, no full stop
  at the end, no run of spaces, and a whole title of at most 72 characters.
- A title names the change and never credits a tool or an assistant for it. A
  change may still be *about* an engine or a model ("show the claude usage limit"),
  and a scope may name one, as in `fix(codex):`. AI use belongs in the body, as the
  AI usage section describes.
- The issue forms start the title with its kind. If the work changes shape, edit
  the title rather than opening a second issue.
- The [Title](.github/workflows/pr-title.yml) check fails a pull request whose
  title does not fit, and starts again when the title is edited. Dependabot opens
  its own titles and is skipped.

## Credit

A person who writes or amends the commits on a branch is an author of that change,
and the record should say so:

- Their own commits already carry them as author, which is the strongest record and
  needs nothing extra.
- The pull request lists every such person in its `## Co-authors` section, with the
  commits they wrote, so the change credits them where people read it.
- When their work is folded into a commit someone else authors, as happens when a
  review fix is amended into the row commit, that commit carries the trailer
  `Co-authored-by: Name <email>`.
- Assistants and tools are never an author, a trailer, a title or a branch name; what
  they did belongs in the AI usage section, which is the only place for it.

## Branches and commits

- Branch from `main` with a short purpose name: `feat/`, `fix/`, `docs/`,
  `chore/` or `refactor/`.
- For parity work, use one branch per section and one small commit per completed
  row, so a regression can be found and reverted.
- Write [Conventional Commits](https://www.conventionalcommits.org/) subjects,
  such as `fix(codex): wait for tools before the first turn`.
- Commit `web/src/generated` in the same commit as every contract change. Run
  `npm run generate` in `web` after editing `crates/orbyn-contracts`.
- Commits and branch names carry no agent or tool attribution: no `Co-Authored-By`
  trailer for an assistant, no generated-by line, and no model or tool name in
  commit messages, pull request titles or branch names. Record AI use in the pull
  request's AI usage section instead.
- Keep active branches current by merging `main` into them at least daily.

## Leaving work behind

Some work does not finish inside the pull request that found it: a row that was
deliberately deferred, a limit the change had to accept, a test that was already
failing, or a decision only the maintainer can make. None of it may stay in a chat,
a session or a local note, because nobody else can pick it up there.

Open an issue for it before the pull request merges, with the evidence that makes it
actionable:

- what is unfinished or wrong, and the row ID when a parity row owns it;
- how to reproduce it, with the command and its output;
- the options and the trade-off, when it is a decision;
- what done looks like, so someone else can finish it;
- the pull request it came from, and the label that puts it in the right queue
  (`parity`, the area label, and `help wanted` when it is deliberately left open).

The pull request then links the issue where it records the limit, so the two places
point at each other.

## Checks

### Keep Cargo artifacts private to each worktree

Use a separate target directory for every checkout, including worktrees in
`<repo>-wt/<purpose>/`. Never run builds, Clippy or tests from different checkouts
against one writable `CARGO_TARGET_DIR`. In [issue #123](https://github.com/orbyn-dev/orbyn-engineering/issues/123),
Cargo reported packages as `Fresh` while tests ran another checkout's binary;
concurrent runs also produced fingerprint errors and tried to spawn a partially
written `orbynd`.

Before running the checks below, select this worktree's own ignored `target/`
directory. These commands override an inherited shared `CARGO_TARGET_DIR` and use
an absolute path, so changing into a subdirectory keeps the same target.

From the selected worktree, in Bash (macOS or Git Bash):

```bash
export CARGO_TARGET_DIR="$(git rev-parse --show-toplevel)/target"
```

Or in PowerShell (Windows):

```powershell
$env:CARGO_TARGET_DIR = Join-Path (git rev-parse --show-toplevel) 'target'
```

Use that target for only this checkout, and finish its Cargo commands before
starting another verification run there. Do not launch an integration binary
while a build is replacing it.

If the selected target was previously shared or contains suspect artifacts, stop
its Cargo processes and test binaries, then run `cargo clean` with the private
target selected above and rebuild. Do not clean a target another checkout uses.
Before trusting an integration result, confirm the binary in the selected target
contains the change: exercise a new route or other changed behavior and check its
expected response. A `Fresh` message alone does not establish that.

Issue #123 records a hard-link-copy workaround. Hard links still share file
contents, so that copy is not independent of writes to the original cache. Prefer
a fresh private target for verification; do not use a hard-linked target alongside
a writer to the original. The per-worktree convention above works on both
supported platforms without a cache-copy tool.

Run the affected checks locally before pushing:

```bash
cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
```

```bash
cd web && npm run check && npm test
```

Seven checks are required on the current head before a merge: Rust on macOS and
Windows, Web, E2E, the unsigned desktop build on macOS and Windows, and the AI
usage section. Never
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
- Keep pull requests and issues short: bullets and fragments, under about 150 words
  outside AI usage. Leave out repair rounds, retries and CI results, which GitHub
  already shows. Link long logs instead of pasting them.
- Merge with a merge commit. Do not squash the per-row commits.
- Never include secrets, engine credentials, personal data or files from your own
  machine. The repository is public.

## Protected main

`main` accepts changes only through pull requests, for everyone, maintainers
included. Force pushes and deleting the branch are blocked.

- Seven checks must pass, reported by GitHub Actions: Rust and the unsigned desktop
  build on macOS and Windows, Web, E2E and the AI usage section.
- One approval from a code owner is required, and a new push dismisses it. Open
  review conversations must be resolved.
- Only merge commits are allowed.
- The maintainer can merge their own pull request without a second approval, because
  GitHub does not let authors approve their own. That bypass works only on a pull
  request whose checks have passed.

## AI usage

Every pull request says how it was made, so a change can be traced. Fill in the AI
usage section of the template from what actually ran:

- **Written by hand:** tick that box. Nothing else is needed.
- **With AI:** the harness, such as Claude Code, Codex or Cursor, with its version;
  every model by exact ID, such as `claude-opus-5-5`, and what each did, whether one
  model did everything or several shared it; the effort level, such as low, medium
  or high; and what you decided, reviewed or changed yourself.
- **Sources:** every outside project, document or page the change used, with its link,
  or "none".

The PR check fails while the section is empty. Dependabot's pull requests are exempt.
Issue forms ask the same question, with "Human only" as an answer.

## Dependencies

Dependabot opens weekly grouped minor and patch updates for Cargo, npm and GitHub
Actions. Review them like any other change: every required check must pass. It does
not propose major versions of Cargo or npm packages: those change APIs, so they are
planned work in an issue labelled `dependencies`, done in their own pull request.
Pin GitHub Actions to a full commit SHA with the version in a comment.
