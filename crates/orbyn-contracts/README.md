# orbyn-contracts

The wire contract: serialized types shared by the service and the UI, with no
behaviour. Timestamps are RFC 3339 UTC strings and ids are opaque strings.

## Contract

Every public type in `src/lib.rs`. `npm run generate` in `web` (which runs
`cargo test -p orbyn-contracts`) writes their TypeScript into `web/src/generated`.

## Consumers

- `orbyn-core` and `orbynd`, as Rust types.
- `web`, only through `web/src/generated`.

## Known limitations

- `web/src/generated` is committed, not built. Commit it in the same commit as
  every contract change, or the UI and service disagree.
- One file holds every type, so any contract edit touches `src/lib.rs`.
