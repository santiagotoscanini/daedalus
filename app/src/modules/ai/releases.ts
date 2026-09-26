import type { ReleaseSource } from '../../lib/dashboard/image-repos'

// Where the AI containers' release notes live. mcp-grocy sits here because
// the LiteLLM tab reads its gap with the same repo, and the Updates row must
// not disagree with it. lemonade-logs is deliberately absent: a stdlib-only
// bridge.py bind-mounted into an unmodified `python:3.13-alpine`. The code in
// it is ours and is not in the image; what ages is CPython and the Alpine
// packages under it. Do not point it at `python/cpython`: that repo publishes
// no GitHub Releases (only tags — CPython's notes live on python.org), so the
// panel renders an empty board, a worse answer than none. The version delta
// is carried on the row itself instead — see `remoteVersion` in
// lib/dashboard/images.ts.
export const releases: Record<string, ReleaseSource> = {
  litellm: { repo: 'BerriAI/litellm' },
  'open-webui': { repo: 'open-webui/open-webui' },
  n8n: { repo: 'n8n-io/n8n', opts: { tag: /^n8n@(\d+\.\d+\.\d+)$/, sameMajor: true } },
  'mcp-grocy': { repo: 'miguelangel-nubla/mcp-grocy' },
}
