# Provider work without engine logins

Decision for [issue #129](https://github.com/kinqsradio/orbyn-engineering/issues/129):
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
by this documentation decision.

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
Claude was not invoked. Its integration and macOS protocol qualification remain
open under #140; this evidence does not complete the whole I40 row.

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
and manual-refresh recovery, not an authenticated engine handshake. Packaged
Windows/macOS webview qualification remains open under #140.

## I9 and I51 remain open

Codex 0.160.0's locally generated schema includes `feedback/upload`. Its parameters
include `classification`, `includeLogs`, `reason`, `threadId`, `extraLogFiles` and
`tags`; its response includes `threadId` and optional `promptHash`. The
[official app-server documentation](https://developers.openai.com/codex/app-server)
describes the request and version-specific schema generation. Neither that schema
nor the successful unauthenticated model-list requests establish that upstream
feedback works without authentication or a live session. No feedback was sent.
I9 remains open until an explicitly authorized sanitized submission establishes
the actual response and requirements. No feedback UI or speculative service route
has been added.

The signed `engines/tested-versions.json` contains only minimum and tested versions.
It has no known-problem advisories or recommended replacement policy, and existing
installer-owned update plans target latest rather than a recommended pinned
version. An untested version is not evidence of a known problem. I51 therefore
remains open: the next implementation needs a maintained advisory source and the
owner's recommended-version policy, retaining manifest signature verification,
proven installer ownership, manual instructions for unknown owners and active-run
exclusion. This batch changes none of those trust or installer boundaries.

Both decisions remain tracked by #140. The PR for this supported slice must link
to that issue without closing it.
