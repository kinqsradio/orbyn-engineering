# Command-line reference

`orbyn` is the command beside `orbynd` in a built desktop bundle. It can use a
running service or start the bundled one. It targets macOS and Windows. Run
`orbyn help`, `orbyn help <command>` or `<command> --help` for exact syntax.
From a source checkout, `cargo run -p orbynd --bin orbyn -- <arguments>` runs
the CLI; starting a service also needs the built sibling `orbynd` and UI assets.
This is a source/bundle workflow, not an npm distribution. There is currently no
documented `npx orbyn` try-without-install command.

## Shared options and service discovery

- `--data-dir DIR` selects the service's data folder. `ORBYN_DATA_DIR` is the
  fallback; otherwise the app-data location is used. Separate data folders isolate
  services. On macOS the default is `~/Library/Application Support/Orbyn`; on
  Windows it is `%LOCALAPPDATA%\Orbyn` (falling back to the home folder).
- `--json` requests structured output for API commands and service dry-run plans.
  It does not turn native triage terminal output into JSON.
- `--help` and `--version` display command information without starting a service.

API commands discover the URL and private launch token from `service.json` in the
data folder. Do not share that file. Ordinary failures return exit 1; no running
service returns 2; success returns 0. Clap syntax/help exits use Clap's normal
codes. Triage passes the native child's numeric exit through to the operating
system, including full Windows 32-bit statuses. An exit without a numeric code
becomes 1; Unix process status exposes its usual low eight exit bits.

## Starting and opening

| Command | Behavior |
| --- | --- |
| `orbyn [FOLDER]` | Start or reuse a responding service and open its browser UI; register the folder if needed. |
| `orbyn start [FOLDER] [--no-open]` | Same start behavior; optionally leave the browser alone. |
| `orbyn app [FOLDER]` | Open the desktop app through `orbyn://`; a folder uses its project route and requires service discovery. |
| `orbyn serve [OPTIONS...]` | Run sibling `orbynd serve` in this terminal, forwarding its options. |
| `orbyn status` | Report service URL/version, active runs, terminals and workspace configuration. |

New folder registrations start untrusted. Opening one does not authorize a run.
`ORBYN_OPENER=-` prints the target that would open; another value names the opener
program. Printed opener targets can contain the local session token: keep them
private. A detached service writes `service.log` in its data folder.

`orbynd serve --help` is the service-options reference. Common options include
`--port`, `--data-dir`, `--ui-dir`, `--library-bundle`, `--update-manifest` and
`--parent-stdin`; the last is the desktop's ownership channel, not an interactive
session. `ORBYN_LIBRARY_BUNDLE` selects a bundled library and
`ORBYN_UPDATE_MANIFEST` selects the read-only release manifest check.

## Updating

| Command | Behavior |
| --- | --- |
| `orbyn update --check` | Ask the running service to check, and report the current and latest release. Changes nothing. |
| `orbyn update` | Check, then ask the desktop app's installer to install the latest release. |
| `orbyn update --version VERSION` | The same, only when `VERSION` (with or without a leading `v`) is the latest release; the running version reports that it is installed. |
| `orbyn update --channel NAME` | Accepted only when `NAME` is the build's own channel (`/api/info` `channel`); switching is refused with exit 1. |
| `orbyn update --downgrade` | Refused with exit 1 before any service is contacted. |

The app updates only through the installer that owns it: the desktop shell's
signed updater, which offers the latest release of the channel the build was
compiled for. There is no version index, channel switch or downgrade path, so an
older or unlisted version or another channel is refused and the message says to
install that build manually. A service with no
desktop shell cannot replace itself: `orbyn update` reports its blocked reason
and an unconfigured manifest, and exits 1 when a newer release exists that it
cannot install. Install is refused while runs are active, as in the UI. Engines and
the skills library update from the UI's update center, not this command.

## Threads, projects and preferences

These commands use the same service APIs and rules as the UI.

| Command | Options / behavior |
| --- | --- |
| `orbyn thread list` | `--project ID`, `--archived`. |
| `orbyn thread start PROMPT` | `--project ID`, `--engine ID` (default `claude`), `--title TITLE`, `--wait`. No project starts a scratch thread. |
| `orbyn thread send THREAD PROMPT` | Queue a message; `--wait` waits for the run and fails unless it completes. |
| `orbyn thread show THREAD` | `--wait`, `--limit N` (default 200). |
| `orbyn project list` | List registered projects. |
| `orbyn project add PATH` | Register an existing folder, initially untrusted. |
| `orbyn project remove PROJECT` | Unregister and remove its threads; keep the folder. |
| `orbyn project rename PROJECT NAME` | Change the displayed name; keep the folder. |
| `orbyn theme show`, `set NAME`, `clear` | Read/change/reset the stored `default_theme` preference. Each viewer applies a newly set theme once, at start or when its window takes focus. |

## Local maintenance

| Command | Behavior |
| --- | --- |
| `orbyn doctor [--dry-run]` | Report database reclaimable space. |
| `orbyn doctor --fix` | Ask the service to reclaim space; active runs refuse repair. |
| `orbyn browser setup` | macOS/Windows: reports that no setup is required, without modifying the host. |
| `orbyn trace summary [--since 30m] [--limit 25]` | Read local bounded timing records, even while the service is stopped. Durations also accept hours; use command help for accepted units. |
| `orbyn service install [--dry-run]` | Install/start or repair the per-user background registration on supported service managers. |
| `orbyn service uninstall [--dry-run]` | Stop/remove that registration and keep threads/settings. This does not uninstall the app or launcher. |
| `orbyn service restart` | Ask the service manager to restart it. |
| `orbyn service status` | Show the manager's status. |

The background registration uses launchd on macOS. Windows background setup is
unsupported; desktop startup and direct `service run` remain available. No
administrator rights or PATH changes are requested. Dry runs print a plan without
running a manager or modifying its files. Linux/systemd support in shared service
planning is outside this product's macOS/Windows scope. There is no
OOM-protection command: the reference supports it only on Linux with systemd.

## Uninstalling

`orbyn uninstall [--dry-run]` removes what Orbyn registered with the operating
system: the background service, exactly as `orbyn service uninstall`. Orbyn puts
no launcher on PATH and keeps no side-by-side versions, so there is nothing else
for it to remove. It then says how to remove the app through the installer that
owns it (move the `.app` bundle to the Trash on macOS; Settings > Apps > Installed
apps on Windows, which has no background service) and names a service that is
still running. The data folder with threads and settings is kept and named; delete
it yourself to remove them. `--dry-run` prints the plan and changes nothing; with
`--json` it reports `service`, `running`, `launcher`, `versions`, `app` and `data`.

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

## Hidden helper inventory

`orbyn service run` is hidden from ordinary help because the service manager
starts it. It runs sibling `orbynd`, applies the literal `service.env` in the
selected data folder and waits for it. Optional `export`, quoting, multiline
values and comments are supported without shell expansion. Missing files are
ignored; malformed/unreadable files stop startup. Launcher PATH and selected
data-directory ownership are retained. Keep this private environment file out
of reports and version control.

There are no registered `orbyn` ACP MCP bridge/call or Claude-history CLI helpers.
Core's per-run HTTP MCP endpoint and usage-history readers are separate internal
facilities, not aliases for those commands. SSH helpers remain out of scope.
