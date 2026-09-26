# A host run by daedalus

A complete config repo for one box running daedalus — the generic twin of a real
host's `/etc/nixos`: the engine as a flake input, plus every definition a host brings.

**Copied here by `nix flake init -t github:santiagotoscanini/daedalus#config`?**
This is now your repo. Every value is a documentation value (example.org, alice,
RFC 5737 addresses, all-zero pins, placeholder `*.sops`): replace each one — the
files say which — create the secrets (`host/sops/README.md`), swap in your own
`hardware-configuration.nix`, and switch.

In the engine repo it is the test host, never read by a running box: `nix flake
check` (locally, and in CI on every push) evaluates it as `checks.example-host`,
and with every catalog module on as `checks.all-modules`. Its `site/` is also the
one sample of each `site/` file that both the app's test
(`app/src/host/contract/site-files.test.ts`) and `nix flake check` read — the
app↔nix file-format contract. When a format's `schemaVersion` changes and old
files must stay readable, add a folder holding the OLD version's sample then —
not before.
