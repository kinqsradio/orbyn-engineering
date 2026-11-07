# Security policy

## Supported versions

There are no releases yet. Only the current `main` branch is maintained, and fixes
land there.

## Report a vulnerability privately

Email hello@orbyn.dev, or use
[GitHub private vulnerability reporting](https://github.com/orbyn-dev/orbyn-engineering/security/advisories/new).
Do not open a public issue for a vulnerability.

Include:

- the affected commit, and whether you used the desktop app or the browser;
- the operating system, macOS or Windows;
- a minimal reproduction with synthetic data;
- what an attacker can do, and what they need first;
- a suggested fix, if you have one.

Never attach real tokens, engine credentials, private project files or personal
data. No response time is promised.

## What is in scope

- **The local service, `orbynd`.** It binds to loopback, and every request needs
  the session token it prints at start. Binding all interfaces requires
  `--tls-terminated`. Report any way to reach the API without the token, read the
  token from another user or site, or bind wider than requested.
- **The approval gate and write scope.** An engine must not write outside the
  project or run a tool the user did not approve in the selected mode.
- **The per-run MCP server** and the tools it exposes to an engine.
- **Engine child processes.** Arguments, environment and working directory must
  not let project content run commands or leak credentials. Orbyn never reads or
  stores engine credentials.
- **Updates.** The app, engine and library update paths, including signature and
  revision checks.
- **The bundled skills library** snapshot and its provisioning.
- **The desktop shell** and its bridge to the UI.
- **CI and release workflows** in `.github/`.

## Out of scope

- Defects in Claude Code, Codex or another engine itself. Report those to their
  maintainers, unless our integration causes the problem.
- What an engine does with permission the user granted, such as Full access mode.
- Attacks that need an already compromised user account or machine.

## Repository protections

Dependabot alerts and security updates, secret scanning and push protection are on
for this repository. Dependabot also opens weekly version updates; see
[CONTRIBUTING.md](CONTRIBUTING.md#dependencies).
