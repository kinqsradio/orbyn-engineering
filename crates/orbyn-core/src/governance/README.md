# Governance

What may happen and who is told: every engine action passes here before it has an effect.

| Module | Owns |
| --- | --- |
| `policy` | Pure policy evaluation: deny beats ask beats allow |
| `approvals` | The single gate every engine action passes: policy, then a person |
| `computer` | The computer gateway: resolve, evaluate, audit, then act |
| `network` | Every request Orbyn makes unasked, listed for a person to read |

The crate's [group table](../../README.md#groups) lists every group.
