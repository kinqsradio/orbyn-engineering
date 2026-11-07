# Operations

Keeping the service healthy and current: what it reports about itself, repairs and updates.

| Module | Owns |
| --- | --- |
| `diagnostics` | Processes the service started, their memory and recent warnings |
| `health` | Whether GitHub and each provider's service answer from here, on request |
| `local_trace` | Bounded, payload-free local operation timings |
| `telemetry_export` | Sending kept signals to a collector the person set up |
| `maintenance` | Database repair, the telemetry check, automatic pull and storage cleanup |
| `updates` | One view of what can be updated: library, app and engines |

The crate's [group table](../../README.md#groups) lists every group.
