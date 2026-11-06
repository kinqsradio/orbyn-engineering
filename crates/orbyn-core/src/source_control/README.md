# Source control

Source control on a thread's checkout, always through the person's own installed tools and login.

| Module | Owns |
| --- | --- |
| `scm` | Source control actions on a thread's checkout |
| `git` | Git through the installed CLI, worktrees in the sibling `<repo>-wt` root |
| `jj` | Non-colocated Jujutsu checkouts, read through the installed `jj` |
| `forge` | GitHub and GitLab through their own CLIs |
| `scm_writing` | Diff-derived text for a confirmed Git action |
| `pull_guides` | An agent's reading order for one pull request |

The crate's [group table](../../README.md#groups) lists every group.
