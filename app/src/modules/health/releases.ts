import type { ReleaseSource } from '../../lib/dashboard/image-repos'

// Where the Health containers' release notes live — the same repo each tab
// passes to versionGap (lib/dashboard/image-repos.ts says why that matters).
// getbased and its relay are built on the box from pinned sources, so their
// Updates rows are the node base and these are not consulted for them;
// mcp-yazio is two projects in one image and is read from its env instead.
export const releases: Record<string, ReleaseSource> = {
  grocy: { repo: 'grocy/grocy' },
  'mcp-grocy': { repo: 'miguelangel-nubla/mcp-grocy' },
  'mcp-hevy': { repo: 'chrisdoc/hevy-mcp', opts: { tag: /^hevy-mcp@(\d+\.\d+\.\d+)$/ } },
}
