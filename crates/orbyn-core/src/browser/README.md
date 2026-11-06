# Browser

The pages a person watches beside a thread, and everything that crosses into or out of them.

| Module | Owns |
| --- | --- |
| `preview` | Preview tabs, each a headless Chrome on its own profile, and the servers a thread started |
| `preview_bridge` | Copy, file choice and downloads between a page and its viewer |
| `preview_recording` | Bounded JPEG recordings |
| `preview_trace` | Ephemeral, content-free input cues |
| `remote_images` | Bounded remote raster images with pinned DNS |

`remote_images` owns the shared fetch policy for browser-facing remote raster
media. The HTTP adapter exposes it to both thread media and browser history icons;
neither presentation caller owns the fetch policy.

The crate's [group table](../../README.md#groups) lists every group.
