import { defineViews } from '../../../lib/modules/tabs'
import type { Tabs } from '../data'
import { manifest } from '../manifest'
import { OverviewView } from './overview'

// The Email page — one tab, two subjects. Why there is no ServiceHead and no
// `nix` on it: ../manifest.ts.

export const views = defineViews<typeof manifest, Tabs>(manifest, {
  overview: ({ data }) => <OverviewView data={data} />,
})
