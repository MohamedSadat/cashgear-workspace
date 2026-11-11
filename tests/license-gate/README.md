# License-gate fixtures

`pnpm licenses:selftest` runs both license checks against these fixtures and passes only if each check **fails** on the GPL-3.0 package:

- `cargo/` is a Cargo workspace where a private crate depends on `gpl-dep` (GPL-3.0-only). It is checked with the repository's `deny.toml`.
- `npm/gpl.json` is a `pnpm licenses list --json` listing that includes `gpl-fixture` (GPL-3.0-only). It is checked with `license-policy.json`.
