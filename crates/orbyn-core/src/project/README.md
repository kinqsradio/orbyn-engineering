# Project

Projects and the files inside them, and the one managed workspace that holds them.

| Module | Owns |
| --- | --- |
| `projects` | Registering, cloning and creating projects |
| `workspace` | The managed library checkout and its `repo/` targets |
| `project_file` | The team's read-only `orbyn.json` project file |
| `project_setup` | First-turn admission for a worktree's setup action |
| `project_scopes` | Settings targets derived from registered projects |
| `project_icons` | Passive image reads for registered projects |
| `project_icon_override` | Project display metadata validation |
| `project_image_import` | A project image chosen outside the project |
| `project_image_picker` | Searching a project for candidate images |
| `files` | Reading and editing a thread's checkout inside its write scope |
| `file_bytes` | Raw bytes of a checkout file for media and binary views |
| `outside_files` | Read-only files outside a thread's checkout |

`workspace` owns the managed library and project boundary, including the lock
that coordinates library replacement with run admission. `conversation::runs`,
`agents::console`, and `operations::updates` use that boundary; their use does
not make them owners of the library lifecycle.

The crate's [group table](../../README.md#groups) lists every group.
