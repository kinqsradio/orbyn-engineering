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
