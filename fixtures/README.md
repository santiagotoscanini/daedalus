# Schema fixtures

One sample document per schema version — `site/v<N>/` (a whole site
directory whose `site.json` is at version N), `apps/v<N>/apps.json`,
`nodes/v<N>/nodes.json` — that both halves of the contract must accept.
`nix flake check` reads them through the nix readers (`nix/tests/fixtures.nix`);
`pnpm test` reads them through the app's (`app/src/host/contract/fixtures.test.ts`).

Each `site/v<N>/` carries an `apps.json` and a `nodes.json` that must be
byte-for-byte copies of one of the `apps/` and `nodes/` fixtures (a link would
not survive nix's store copy), and `templates/config/site/site.json` must equal
`site/v1/site.json`; `nix flake check` refuses either drift.

A schema version bump adds a sibling `v<N+1>/` directory and leaves the old one
as it was written; both tests fail until the version the writer emits has one.
