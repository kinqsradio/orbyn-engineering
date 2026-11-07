# desktop

The thin Tauri 2 shell. It starts `orbynd`, loads the bundled UI and does only
what the operating system must do: windows, menus, tray, links, file dialogs and
app updates. Its rules are in
[docs/architecture.md](../docs/architecture.md#desktop-shell).

## Contract

- It runs `orbynd` with `--parent-stdin` and talks to it over that process's
  stdin and stdout. The product UI never calls the shell directly.
- The product UI comes from `build/ui`, which `npm run prepare-bundle` fills.
  `loader/index.html` is the embedded startup page, the only document allowed to
  call `restart_core`. The product UI restarts the service through the service's
  `restart_service` shell action instead. A service that crashes is started again
  once by itself (`src/restart_policy.rs`).

## Consumers

People, through the installed app. Nothing in this repository imports it.

## Known limitations

- `src-tauri` is outside the root Cargo workspace, so the root
  `cargo test --workspace` does not build it. CI's desktop jobs do, on macOS and
  Windows.
