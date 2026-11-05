# Command-line reference

Run `orbyn help` or `orbyn triage --help` for command syntax.

## Triage in a native terminal

```text
orbyn triage
orbyn triage --agent codex
orbyn --data-dir PATH triage --agent claude --model MODEL
```

Triage writes `prompt.md` and `context.md` in a new `triage/<id>` folder under
the selected data directory, then starts a fresh Claude or Codex terminal there.
No running Orbyn service is needed. It does not resume an existing thread. This
native session uses the provider's own login and permissions and is outside
Orbyn's governed runs and approval gate. The command can consume provider usage
when you start it; it does not sign you in or inspect credentials.

One available provider is automatic. When both are available, interactive input
and output show a picker; redirected input or output requires `--agent`. If no
provider is available, the files remain and the command prints manual-paste
instructions. An explicitly selected unavailable provider fails. Availability
uses executable discovery, never a version or sign-in probe.
`ORBYN_CLAUDE_BIN` and `ORBYN_CODEX_BIN` can select executables. Recognized Windows
shims resolve directly; unsupported wrappers fail without shell evaluation.
`--model` is passed as one literal value; there is no extra argument passthrough.

The context identifies the CLI build, platform and generation time, plus relative
diagnostic locations. It says server status was not checked. Preparation reads
no service handle, logs, database, provider history, environment dump or engine
configuration. The original support prompt asks for the symptom and affected
build, then requires approval before further investigation, repairs, network
retrieval or publication. These instructions do not enforce provider behavior.

Input/output stays in the current terminal. The parent waits for the native
child's exit; interrupts behave as the provider normally handles them. Ctrl-C
may cancel a turn while leaving the session open. There is no forced descendant
cleanup or parent-death guarantee. Session files remain for review; no automatic
upload, source clone, report posting or deletion runs.
