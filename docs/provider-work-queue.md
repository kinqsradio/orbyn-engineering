# Provider work without engine logins

Decision for [issue #129](https://github.com/orbyn-dev/orbyn-engineering/issues/129):
queue the credential-free portion of section I as the next provider batch: I40,
I41 and I51. I9 is a conditional follow-up, subject to the protocol check below.
This queues implementation work; it completes no parity row and changes no scope
or product rule. Read [section I](parity.md#i-providers) and the
[architecture rules](architecture.md#hard-product-rules) before starting.

## Queued batch

| Row | Work that can start without an engine login | Evidence needed before completion |
| --- | --- | --- |
| I40 | Refresh local model discovery through an installed engine, including its local manifest/cache handling. The T3-hosted model manifest service remains excluded. | Exercise refresh, stale or failed discovery, and recovery through the real service. Name the installed engine and version used to prove its discovery protocol. If discovery requires authentication, keep that provider's integration open until it can be observed with the engine's own login. |
| I41 | Show provider health in the composer from service-reported status, following the T3 surface already cited by the row. | Run the composer against real `orbynd`, with tests for relevant status changes and recovery. Controlled status fixtures can prove display behavior; they do not prove a provider handshake or authenticated health probe. |
| I51 | Show known-problem version warnings and a recommended-version install action on the provider card. Use the existing version-support and installer ownership boundaries. | Exercise the card against real `orbynd`, including affected and unaffected versions and the recommended-install route. Prove the installer owns the binary, keep manual instructions for an unknown owner, and reject updates during an active run. Record any platform or provider route still unverified. |

Keep one active section-I branch and separate commits for completed rows, as
[AGENTS.md](../AGENTS.md#delivery) requires. Check for an existing owner before
starting. Implement the batch without collecting credentials or introducing a
hosted service. Local UI and service work can proceed while a provider-specific
check is blocked, but record the missing evidence and keep the row open or partial.

## I9: establish the feedback route first

I9 means sending feedback upstream; approval-decline feedback is a different
feature. Before adding I9 to the implementation batch:

1. Inspect the installed Codex app-server's supported feedback request and record
   its version, request shape, response and session/authentication requirements.
2. Establish whether the supported request works without a live authenticated
   session. Do not infer this from a mock accepting a request.
3. If that route is available, queue the service and client plumbing, including
   success, unsupported and failure behavior, then verify the real supported
   feedback route before marking the row complete. Use a deliberate, sanitized
   test report only with authorization to send it upstream.
4. If a live session or engine login is required, leave I9 open, identify that
   dependency in the row or follow-up issue, and defer end-to-end qualification to
   someone with that access. Local plumbing alone does not complete I9.

No feedback was sent and no credential-free Codex feedback route was established
by this documentation decision. The route was established later; see the I9
implementation evidence below.

## Remaining provider work

The other open section-I rows are not queued by this decision. They remain open
or partial under their existing scope, rather than becoming excluded or declared
maintainer-only. Before taking one, record the specific engine binary/version,
supported protocol and any engine-owned login needed to demonstrate its local
behavior. Protocol-dependent work such as ACP v1/v2 negotiation and named agents
also needs evidence against the actual supported engine/protocol version.

Engine access is a qualification dependency, not permission for Orbyn to read,
store or forward credentials. Sign-in/account handling and hosted services already
excluded in parity remain excluded. This decision adds no CI login, credential
store or authenticated CI matrix.

## Completion and handoff

Use the real-service and client/platform evidence required by each row in
[parity.md](parity.md#scope-and-counting). A fake engine may test orchestration,
failure paths and status presentation; it cannot prove that a real provider
handshake, model catalog or upstream feedback service works. Name those limits in
the row and PR instead of ticking it from mock-only evidence.

After each slice, update its parity row with observed evidence and remaining
dependencies. Put unfinished work in a repository issue linked to the row, as
[CONTRIBUTING.md](../CONTRIBUTING.md) requires. Missing engine access does not
waive the required current-head CI checks or the maintainer's merge decision.

## I40 implementation evidence — 5 November 2026

The provider card now offers forced discovery, including after an initially empty
or failed list. It retains the available models during refresh or a transport
failure, reports failure, and permits retry. A newer refresh fences older replies
and failures. The existing service caches remain in process memory.

On Windows, real `orbynd` used an unmodified copy of installed Codex 0.160.0 under
fresh task-owned profile/configuration/data directories and an ephemeral credential
store. The service reported `logged_out` and discovered eight models. Making only
that task-owned executable copy unavailable caused forced discovery to fail while
retaining the good catalog with an error. Restoring the unchanged copy recovered
the same catalog. No turn, login or installed-user-state change was involved.
Direct app-server initialization and two `model/list` requests also succeeded
with `account/read` reporting a null account. Catalog discovery is not evidence
of inference access.

The real-service browser test in
`web/e2e/real/provider-model-refresh.spec.ts` covers initial failure, manual refresh,
retaining the good list, and recovery. Its protocol double tests orchestration;
the separate installed-Codex run establishes the actual discovery protocol.
Claude was not invoked.

On macOS the same path was exercised through real `orbynd` with an unmodified copy
of installed Codex 0.166.0 under fresh task-owned profile, configuration and data
directories. The engine reported `logged_out` throughout and no turn or login ran.
Forced discovery returned its nine models from the engine's own app-server; a plain
read with that copy moved away served the cached list with no error; a forced refresh
reported the move while keeping the last good list; restoring the copy recovered the
same list with no error. The macOS copy is task-owned, so it proves no installer
ownership. Claude discovery is unobserved without its own login, and the model caches
were still in process memory at this point; the durable copy below closes that gap.

## I40 durable copy — 5 November 2026

The service now keeps each engine's last good model list in
`<data-dir>/model-cache/catalog.json` and serves it after a restart when the engine
cannot be asked and the stored catalog key still matches. The file is written only
after a successful discovery, is replaced by an atomic rename, and holds at most 32
engines, evicting the oldest `checked_at`. Every cache IO, parse and rename failure
is ignored, so a bad cache cannot fail a model read. `EngineModels` is unchanged.

On macOS, real `orbynd` used a task-owned copy of installed Codex 0.166.0 with a
fresh `CODEX_HOME` and data directory. Forced discovery returned nine models and
wrote `catalog.json` with `version: 1`. After stopping the service and moving only
that copy away, a plain read against a new service process returned the same nine
models with the stored `checked_at` and the error `<path> was not found on this
machine.`; a forced refresh did the same. Restoring the copy and forcing a refresh
discovered nine models again with no error and a new `checked_at`, and rewrote the
file. No turn, login or installed-user-state change was involved.

Claude's discovery was then observed through the same service on macOS with
installed Claude Code 2.1.318, a task-owned `CLAUDE_CONFIG_DIR` and data directory.
The engine reported signed out (`tokenSource: none`) and forced discovery returned
its five models from the engine, `source: engine` with no fallback, and wrote the
`claude` entry to `catalog.json`. Its catalog key includes the CLI version and login
state, so a missing binary or a different login is treated as a different engine
rather than answered from the stored list. Claude discovery on Windows is still
unobserved.

`cargo fmt --all --check`, `cargo clippy -p orbyn-core --all-targets -- -D warnings`,
`cargo test -p orbyn-core engines::` (39 passed) and
`cargo test -p orbyn-core catalog_cache` (5 passed) were clean. The unit tests cover
round trip, a changed key not being served, corrupt JSON, an unusable directory, the
32-engine cap, and a successful empty answer not being replaced by the stored list.

## I41 implementation evidence — 5 November 2026

The composer now includes the service's reported problem and update-in-progress
state alongside its existing missing-installation and signed-out warnings.
Unknown authentication alone does not imply a signed-out engine. It follows
status changes after the existing explicit provider refresh; no automatic health
polling or authenticated health probe was added.

`web/e2e/real/provider-health.spec.ts` runs against real `orbynd` with controlled
engine-status responses. It uses Settings → Providers → Check again → Close
settings to exercise problem, missing, signed-out, updating and recovered states
in the same document, while preserving an unsent draft. A component test also
covers state transitions and unknown authentication. These prove presentation
and manual-refresh recovery, not an authenticated engine handshake. Both passed on
`cabb8fe` on macOS: the browser test in 6.2 s and the component test in the web
suite's 648 passing tests. Packaged Windows/macOS webview qualification remains
open under #140.

## I9 protocol check — 5 November 2026

Installed Codex 0.166.0 generates `feedback/upload`, whose parameters are
`classification`, `includeLogs`, `reason`, `threadId`, `extraLogFiles` and `tags`
and whose response is `threadId` plus an optional `promptHash`; it also generates
`feedback/save`, which writes a ZIP to a caller-owned path on the app-server host.
The
[official app-server documentation](https://developers.openai.com/codex/app-server)
describes the request and version-specific schema generation.

Run against the installed app-server with a task-owned `CODEX_HOME` holding no
credentials, where `account/read` reported `{"account":null,"requiresOpenaiAuth":true}`,
`feedback/upload` raised no authentication or session error. It attempted an upload
to `https://o33249.ingest.us.sentry.io/...` and failed only because the probe pointed
every proxy variable at a closed local port (`Connection refused`). The supported
request therefore does not need a live authenticated session: the remaining
dependency is authorization to send one sanitized report and observe the accepted
response. Nothing was sent, no feedback UI or service route was added, and I9 stays
open under #140.

## I9 implementation evidence — 5 November 2026

`POST /api/engines/{id}/feedback` sends `EngineFeedbackRequest` through the
engine's own route and returns `EngineFeedbackReceipt`. Only the Codex driver
implements it: a short-lived app-server calls `feedback/upload` with
`classification: "bug"`, `includeLogs` from the request, and `reason` or
`threadId` only when they are non-blank after trimming. A reply without
`threadId` is an internal error rather than an invented receipt. Claude, ACP,
terminal and AG-UI drivers keep the default `unsupported` answer, which the
service maps to `422`.

Settings → Providers shows Send feedback on Codex engines and their instances.
The dialog explains that the report goes to OpenAI through Codex, takes an
optional reason, leaves Include Codex logs unchecked, and reports the returned
report id after success. A failed send stays in the dialog with the service's
message. It is not shown for engines without the route.

An authorized sanitized report through installed Codex 0.166.0's app-server,
using a task-owned `CODEX_HOME` with no credentials, no live thread and no turn,
returned:

```json
{"threadId":"no-active-thread-01a1aa37-453f-7150-b95c-7c4901b64fb5","promptHash":null}
```

The request-shape helpers are unit-tested. The fake app-server records the
`feedback/upload` parameters, and a service test sends through the real route
and checks the Codex parameters plus Claude's `unsupported` answer. Component
tests cover the unchecked log box, the trimmed reason, the success line and a
failed send. Not verified: the route and dialog against installed Codex (the
protocol run above called the app-server directly), Windows, and the packaged
app. I9 stays partial under #140.

## I51 implementation evidence — 5 November 2026

The provider card warns only from the signed manifest. A version below an engine's
signed `minimum` is `unsupported`; an optional signed `known_problems` entry can
name a version `broken` or `graceful`, and an optional signed `recommended` pins
the replacement. Without that field the newest signed `tested` version is the
recommendation, so the owner changes the policy by signing the manifest, and a
version the manifest does not mention raises nothing. An untested version is still
not evidence of a known problem. The card shows the warning, offers
`Install <version>`, and prints the exact installer command in its confirmation.

That action runs through the installer that provably owns the binary, pinned to one
version: package arguments for npm, pnpm, Bun, Yarn, Volta and Vite+, and winget's
`--version`. Homebrew, an engine's own updater and mise cannot install one version,
so the action stays off and the card keeps the manual hint. A version the service
did not itself recommend is refused, and an active run or update still refuses any
install before the installer starts.

On macOS, real `orbynd` read a real `npm install -g @openai/codex@0.160.0` in a
task-owned prefix as `below_minimum` with the warning and the pinned
`npm install -g @openai/codex@0.166.0`. While a real run was active the install
answered `409 engine_busy`; once it settled, it ran that pinned npm command into
the task prefix (the audit names it, `changed 2 packages`, 0.160.0 to 0.166.0) and
the engine then read `tested` with no warning. The same below-minimum binary
outside the root npm reports kept the manual instructions and refused the install.
No user-installed engine, credential or account state was touched.

Both card states are component-tested. Not verified: the card in a browser against
that warning, Windows, Homebrew, winget, pnpm, Bun, Yarn, Volta and Vite+ pinning
beyond unit tests, and a signed `known_problems` entry or `recommended` pin, which
only the owner's key can add. I51 stays partial under #140.

Both rows remain tracked by #140. The PR for this supported slice must link to that
issue without closing it.
