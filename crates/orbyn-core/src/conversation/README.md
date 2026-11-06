# Conversation

Threads and the runs inside them, from a message being composed to a run settling.

| Module | Owns |
| --- | --- |
| `runs` | The run manager: admission, execution and cleanup |
| `threads` | Thread operations beyond the store: settling, titles, the lifecycle tick |
| `composer` | What a message needs before sending: attachments, mentions, slash commands |
| `questions` | Questions an engine puts to the person |
| `checkpoints` | Diffs over checkpoints, rewinding and forking a thread |
| `file_changes` | What a run changed, kept as bytes |
| `automations` | Scheduled tasks, webhooks and delegated threads |
| `renders` | Pages an agent publishes for a thread |
| `search` | Finding a message across threads |
| `scratch` | Threads with no project |

The crate's [group table](../../README.md#groups) lists every group.
