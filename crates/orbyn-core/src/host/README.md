# Host

The operating system side: processes, their environment, terminals and the desktop shell.

| Module | Owns |
| --- | --- |
| `process` | Child processes as owned resources that die with their owner |
| `child_env` | What a spawned program inherits |
| `terminal` | PTY sessions with bounded scrollback; ConPTY on Windows |
| `shell` | The desktop shell's side of the service |

The crate's [group table](../../README.md#groups) lists every group.
