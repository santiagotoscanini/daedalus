# Site formats

One sample of each `site/` file per format version — `site/v<N>/` (a whole site
directory whose `site.json` is at version N), `apps/v<N>/apps.json`,
`nodes/v<N>/nodes.json`: the contract between the app, which writes them on every
Apply, and nix, which reads them on every rebuild.

Read by `checks.site-formats` (`nix/tests/site-formats.nix`, the nix readers) and
`app/src/host/contract/site-formats.test.ts` (vitest, the app's readers), in
`nix flake check` and `pnpm test`, locally and in CI on every push — never on a box.

Byte copies, refused if they drift: each `site/v<N>/{apps,nodes}.json` copies one
`apps/` / `nodes/` sample (a link would not survive nix's store copy), and
`example-host/site/site.json` equals `site/v1/site.json`. A new version adds a
sibling `v<N+1>/`, leaving the old one as written; tests fail until it exists.
