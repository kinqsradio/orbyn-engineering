# Timeline rendering limits

Issue #128 includes C10 so its engine boundary is explicit, even though this
rendering batch does not enable modern Claude task tools.

The existing Claude driver recognizes `TodoWrite` and emits a replacing `plan`
activity. The web projection and checklist render that activity. It does not
recognize `TaskCreate`, `TaskUpdate`, `TaskGet` or `TaskList` as task-state updates.
These tools can still appear as ordinary tool traces.

The [official tools reference](https://code.claude.com/docs/en/tools-reference#task-tool-availability)
and [environment reference](https://code.claude.com/docs/en/env-vars) distinguish
opting into checklist tools from selecting legacy `TodoWrite`. Availability also
depends on the model. Enabling a flag without projecting returned task identities,
updates and deletion would not produce an honest Tasks row. This batch refuses
that change and leaves C10 partial. It does not change the user's environment.

Completing C10 needs a captured CLI protocol contract for successful task results,
failed calls, updates and deletion, followed by driver and real-service rendering
coverage. The T3 provider document named in parity was not found in the local
reference locations checked. No live Claude turn was run for this batch.

## C40 checkout-image qualification

The 5 November 2026 follow-up to #128 uses the existing Markdown media resolver
and authenticated thread raw-file route. It adds no renderer, local-file grant,
remote-fetch permission or arbitrary HTML/SVG surface. Question images from the
checkout already resolve; the missing work was question-specific qualification.

Component tests cover relative and encoded paths, in-root absolute paths on Unix
and Windows, missing images without losing a selected answer, inert outside-root
and `file:` destinations, and absence of thread-route context. The service/browser
fixture decodes three synthetic PNGs, observes a 404 for a missing file and a 400
for traversal to an existing outside file, and checks the exact raw-path set.
Remote images stay links with no direct or proxy media request; raw HTML/SVG tags
stay text. Answer submission still reaches the waiting run.

That browser run exposed a focus defect when closing an expanded image. The media
dialog now closes before its portal is removed and restores the actual activating
button only while it remains connected. Escape and Close regressions fail before
the fix, including click activation while another control retains focus. Image
and video gallery behavior retains the existing owner and keyboard boundaries.

Qualification ran on Windows using this branch's frontend, an immutable service
and protocol double built from the unchanged Rust source at `754a3b0`, and
Playwright's headless shell. Executable hashes were checked before reuse. The
question payload came from a protocol double: this is real-service/browser
evidence, not a live-provider question or an installed native desktop run. Those
two observations remain open, and C40 remains partial.

## C4 real Codex outcome observation

On 5 November 2026, one approved turn used the installed, unmodified Codex CLI
`0.160.0`, catalog-listed `gpt-6-luna`, and medium effort. The real service used a
fresh synthetic project and a supervised thread with plan mode enabled, which the
driver maps to native `readOnly` sandboxing. The CLI handled its existing login;
the observation did not read/export credentials, sign in, change provider/user
configuration, submit feedback or invoke Claude. Automatic title generation was
disabled only in the disposable service.

The prompt requested six separate `Get-Content -LiteralPath` calls for seeded
`probe-1.txt` through `probe-6.txt`, followed by one for absent `missing-probe.txt`.
Seven actual command starts and results were observed: six reported success with
exit code 0 and one reported failure with exit code 1. The turn completed normally
in about 35 seconds, below its 120-second deadline and eight-start cancellation
threshold. No stop threshold, unexpected action or retry was needed.

The browser's finished-turn label was `Ran 6 commands; 1 tool call failed`, followed
by the elapsed time. Thus the missing-file failure did not increase the successful
command count. All six fixture hashes remained unchanged and the missing file
remained absent. An empty `state` directory appeared after the initial snapshot,
which preceded thread creation; its creator was not established. This is not a
claim that the entire checkout or normal CLI runtime state remained unchanged.
Owned service and browser processes stopped without cleanup errors.

This qualifies this Codex success/failure path through the real service and web UI.
Other live providers, unknown-outcome variants and native desktop observation
remain unqualified. C4 stays partial; protocol items without an outcome stay unknown.
