import type { ManifestApp } from './nix-manifest'

// Renders stacks/apps/apps.json — the exact bytes that land in the flake.
//
// This lives in TypeScript, not in the host script, on purpose. The host agent
// should know as little as possible: it copies a file, commits it, and
// rebuilds. Every decision about *shape* — key order, the preamble, what
// counts as omitted — is application logic, and application logic is far
// easier to get right (and to test) here than in bash with jq.
//
// The consequence to keep in mind: this function's output is a git-committed
// file that Nix parses. Its formatting is therefore load-bearing for diff
// readability, and its content is load-bearing for the system. Two spaces,
// trailing newline, keys in a stable order — so an apply that changes one
// field produces a one-line diff.

const PREAMBLE = {
  _generated:
    'GENERATED FILE — do not edit by hand. This is the Nix-facing contract of the daedalus app registry (stacks/daedalus). The authoritative copy lives in daedalus’s `apps` table; this file is exported from it by the Apply flow, committed, and read by declarations.nix. Editing it here will be overwritten on the next Apply, and daedalus will show the app as drifted until then.',
  _why: 'Nix eval is pure and a flake only sees git-tracked files, so nixos-rebuild cannot query Postgres. Exporting to a committed file is what keeps `the repo IS the system` true: a fresh checkout rebuilds this exact box with no database in the loop.',
}

export type RegistryExport = { schemaVersion: number; apps: Record<string, ManifestApp> }

export function renderRegistryFile(exported: RegistryExport): string {
  return `${JSON.stringify({ ...PREAMBLE, ...exported }, null, 2)}\n`
}
