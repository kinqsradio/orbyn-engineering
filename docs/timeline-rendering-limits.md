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

The same spec re-ran on macOS on 5 November 2026 against the already-built
`target/debug/orbynd` and passed in 18.9 seconds with the three decoded checkout
images, the 404, the 400 and no remote media request.

The pre-existing arbitrary HTML/SVG refusal is covered by `QuestionPanel.test.tsx`: a question
containing `<script>` or `<svg onload>` keeps that text and mounts no script, SVG,
image, video or iframe element. The live-provider question was attempted once and
refused, recorded below, and was not retried. The native desktop shell was not run
because no local desktop build exists.

## C40 live-provider question attempt

One real Codex 0.166.0 turn was run through the real service on 5 November 2026
from a fresh synthetic project, asking the agent to call `AskUserQuestion` once
with a fixed header, body and two options. The turn completed in about twelve
seconds and stored no question: `/api/questions` stayed empty and the run's only
agent message was "I can't use AskUserQuestion here because it's unavailable in
Default mode". The installed Codex app-server protocol does list
`item/tool/requestUserInput`, so the driver's handler is reachable, but this CLI
and sandbox mode would not make the model ask.

That is a refusal by the engine, not by Orbyn: no Orbyn policy or service error
took part. The live-provider question payload, and with it a real question into
this rendering path, stays unobserved. C40 keeps its project-folder image
evidence and stays partial.

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

## C37 real Codex grouping observation

The same single turn described above produced seven command calls in the web
timeline. Opening the completed turn showed a five-call group labelled
`Ran 5 commands` and a two-call group labelled `Ran 1 command; 1 tool call failed`.
The rendered child rows contained the six fixture reads and the missing-file read
in order. The final turn folded to the outcome-aware C4 summary.

This observes the group-of-five boundary with real Codex events. It does not
qualify the live thirty-activity bound, recovery of older live rows or the native
desktop shell. Those live-bound paths retain their existing protocol-double and
component evidence, and C37 remains partial. No second paid turn was run to
manufacture a longer trace.

The native desktop shell was not run. This checkout has no `desktop/node_modules`,
no `tauri` CLI on `PATH` and no built desktop app under `target/`, and installing a
desktop toolchain is outside this task. The live thirty-activity bound therefore
stays with its protocol-double and component evidence.

## C10 Claude task tools

Claude Code's older `TodoWrite` already reached the plan activity. Its modern
`TaskCreate`, `TaskUpdate` and `TaskList` tools report their state in the tool
result rather than the call, so the driver holds each call until that result
arrives and then replaces the plan activity's steps with the reported list. A
`TaskUpdate` that sets `status: "deleted"` removes the row, and a subagent's
text-only `Task #7 created successfully: …` still becomes a step.

The tools are opt-in on the engine side. Orbyn does not set
`CLAUDE_CODE_ENABLE_TODO_TOOLS`, because enabling a tool whose output was not
projected would put task state in the transcript without rendering it. A turn
that forces the tools was attempted on installed Claude Code 2.1.318 and was
refused with `Failed to authenticate: OAuth session expired and could not be
refreshed`, so the live frames remain unobserved. The driver tests use recorded
result shapes from the documented protocol, not a captured session. C10 stays
partial on that live observation; the projection itself is covered by tests.

The follow-up regression sends an explicit failed `TaskUpdate` result with no
content. It could complete or delete the task despite the failure. The
driver now consumes the matching pending call without changing the plan when
`is_error` is true; the normal tool failure event is retained. Successful
structured results and text-only create/update results retain their projection.
These are offline fixtures. The text-only creation fixture has a null parent ID;
it does not establish projection of actual nested subagent traffic.

## C31 surface menu qualification

A real-service browser fixture with a stand-in forge opens the thread's linked
pull through `New surface` → `Pull request`, selects it again without duplicating
the tab, and closes the tab while retaining the link. An unlinked thread keeps
the entry disabled; Escape closes the menu and returns focus to its trigger.
The Windows fixture uses a Node command shim and the native PATH separator, so
the stand-in runs instead of an installed `gh`. This is browser qualification with
synthetic forge data, not a live forge or native-desktop observation. Device and
mute exclusions remain unchanged, and native qualification remains open.

## C40 native Codex Plan mapping

Orbyn's Plan selection previously set only the read-only sandbox. Codex's native
collaboration mode is a separate `turn/start` setting. The driver now sends
`plan` for a Plan turn and explicitly sends `default` for an ordinary turn,
including resumed sessions. Mode settings retain the selected model and effort,
or use the effective thread response when no selection is supplied. Built-in
mode instructions are selected without replacing Orbyn's separate thread context;
the permission policy and service tier remain intact.

The payload is checked against the locally generated Codex CLI 0.160.0 schema
and the [official App Server documentation](https://learn.chatgpt.com/docs/app-server).
Offline real-service protocol tests cover entering and leaving native Plan mode,
the read-only sandbox, model, effort, context and service tier. They do not prove
that a real provider emits a question. The earlier Default-mode refusal remains
a failed observation; no retry with broader permissions was made. A live-provider
question and native desktop qualification remain open.

A later Windows observation attempt used the installed Codex CLI 0.160.0. A
no-turn `model/list` check confirmed `gpt-6.1-sol`, low effort and Standard tier,
but the probe's five-second HTTP admission deadline expired before a run was
created. A read-only audit of the stopped, isolated profile found zero run and
question records. No provider turn or question payload was observed, no retry was
made, and both owned service and browser-server processes were confirmed stopped.
This is a failed pre-admission observation, not evidence of a provider question
failure or successful live qualification. The live and native requirements remain
open.
