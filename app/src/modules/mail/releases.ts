import type { ReleaseSource } from '../../lib/dashboard/image-repos'

// Where Proton Mail Bridge's release notes live: Proton's own repository,
// tagged `v<semver>`, which the box builds from at the pinned tag. The Email
// page reads its gap from this entry too, so the two cannot disagree.
export const releases = {
  'proton-bridge': { repo: 'ProtonMail/proton-bridge' },
} satisfies Record<string, ReleaseSource>
