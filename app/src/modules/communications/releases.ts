import type { ReleaseSource } from '../../lib/dashboard/image-repos'

// Where release notes live for what this page fronts. Each tab reads its gap
// from the same entry, so the tab and the Updates row cannot disagree.
//
//   proton-bridge     Proton's own repository, tagged `v<semver>`, which the
//                     box builds from at the pinned tag.
//   matrix-synapse    Element's repository; the image is theirs, by digest.
//   mautrix-whatsapp  the bridge's repository, tagged `v0.YYMM.patch`: the
//                     version the host exports is in that shape already.
export const releases = {
  'proton-bridge': { repo: 'ProtonMail/proton-bridge' },
  'matrix-synapse': { repo: 'element-hq/synapse' },
  'mautrix-whatsapp': { repo: 'mautrix/whatsapp' },
} satisfies Record<string, ReleaseSource>
