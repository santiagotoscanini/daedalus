import type { ReleaseSource } from '../../lib/dashboard/image-repos'
import { CALENDAR_TAG } from '../../lib/release-tags'

// Where the AI containers' release notes live. lemonade-logs is deliberately
// absent: a stdlib-only bridge.py bind-mounted into an unmodified
// `python:3.13-alpine`. The code in it is ours and is not in the image; what
// ages is CPython and the Alpine packages under it. Do not point it at
// `python/cpython`: that repo publishes no GitHub Releases (only tags —
// CPython's notes live on python.org), so the panel renders an empty board, a
// worse answer than none. The version delta is carried on the row itself
// instead — see `remoteVersion` in lib/dashboard/images.ts.
export const releases: Record<string, ReleaseSource> = {
  litellm: { repo: 'BerriAI/litellm' },
  'open-webui': { repo: 'open-webui/open-webui' },
  n8n: { repo: 'n8n-io/n8n', opts: { tag: /^n8n@(\d+\.\d+\.\d+)$/, sameMajor: true } },
  // Tagged `vYYYY.M.D` (the image tag is the same string), titled "Hermes Agent
  // v0.21.N (vYYYY.M.D)"; since v0.21.6 the tag is `v0.21.N` and the name has no
  // calendar part. The image tag is the calendar one, so releases are ordered by
  // the engine number in the NAME and `tag` only locates the running release.
  'hermes-agent': {
    repo: 'NousResearch/hermes-agent',
    opts: { tag: CALENDAR_TAG, byName: /^Hermes Agent v(\d+\.\d+\.\d+)/ },
  },
}
