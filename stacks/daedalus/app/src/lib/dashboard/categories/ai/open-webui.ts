import { getJson } from '../../../http'
import { key } from '../../../keys'
import { type VersionGap, versionGap } from '../../github'

/**
 * One thing the chat window can reach.
 *
 * Models, tool servers and knowledge bases are three different registries
 * inside Open WebUI and one question to the reader: is everything that was
 * declared actually there. They are listed together because each of them is
 * wired from nix and each of them has a way of quietly not arriving — an
 * env-backed setting the database overrode, an MCP server a virtual key is not
 * permitted to reach, an upload that indexed nothing.
 */
type Reach = {
  kind: 'model' | 'tool' | 'knowledge'
  name: string
  detail: string
  /** Present but empty — a knowledge base holding no files. */
  flag: boolean
}

export type OpenWebUiData = {
  version: string | null
  gap: VersionGap
  /** Its own update check. A second opinion on the release gap, not a repeat. */
  selfLatest: string | null
  /** Models mid-answer at this instant. */
  generating: number | null
  reach: Reach[]
  counts: { models: number; tools: number; knowledge: number }
  /** Set when the admin API refused — everything below it is then empty. */
  note: string | null
}

// ── Open WebUI ─────────────────────────────────────────────────────────────

/**
 * The chat window, as three registries and a door.
 *
 * What this page deliberately does NOT report is usage. Open WebUI knows how
 * many chats it holds and could be made to draw them, and on a household
 * instance with one account that number is vanity: it goes up when somebody
 * talks to a model, which is the thing the model server's own tab measures
 * properly, per model, with latency. Counting it a second time here would be a
 * chart of the same fact with less in it.
 *
 * What is worth reading off a running instance is everything a restart could
 * silently take away: the models the picker offers, the tool servers that
 * registered, the knowledge bases that hold anything.
 *
 * Nor does it report how sign-in is configured. That was four facts —
 * identity provider, login form off, sign-up closed — every one of them
 * declared in stacks/open-webui and none of them able to say anything the file
 * does not. `/api/config` and `/api/v1/users/` are not fetched at all now,
 * which is the point: a panel nobody reads still costs two requests on every
 * page load.
 */
export async function loadOpenWebUi(base: string): Promise<OpenWebUiData> {
  const auth = { headers: { Authorization: `Bearer ${key('OPENWEBUI_KEY')}` } }

  const [usage, ver, models, knowledge, tools] = await Promise.all([
    getJson<{ model_ids?: string[] }>(`${base}/api/usage`, auth),
    // The one service here that checks its own updates, which is why it is
    // kept alongside the release gap rather than replaced by it: two
    // independent answers to "is this current", and them disagreeing is
    // itself worth seeing.
    getJson<{ current?: string; latest?: string }>(`${base}/api/version/updates`, auth),
    getJson<{ data?: { id?: string; name?: string }[] }>(`${base}/api/models`, auth),
    getJson<{ items?: { name?: string; file_count?: number }[] }>(
      `${base}/api/v1/knowledge/`,
      auth,
    ),
    getJson<{ name?: string; meta?: { description?: string } }[]>(`${base}/api/v1/tools/`, auth),
  ])

  const version = ver?.current ?? null
  const modelList = models?.data ?? []
  const toolList = tools ?? []
  const kbList = knowledge?.items ?? []

  // Models first, then tools, then knowledge: the order a request uses them.
  const reach: Reach[] = [
    ...modelList.map((m) => ({
      kind: 'model' as const,
      name: m.name ?? m.id ?? '?',
      detail: m.id ?? '?',
      flag: false,
    })),
    ...toolList.map((t) => ({
      kind: 'tool' as const,
      name: t.name ?? '?',
      detail: t.meta?.description ?? '',
      flag: false,
    })),
    ...kbList.map((k) => {
      const files = k.file_count ?? 0
      return {
        kind: 'knowledge' as const,
        name: k.name ?? '?',
        detail: `${String(files)} file${files === 1 ? '' : 's'}`,
        // A collection with nothing in it answers no question it is asked, and
        // reports no error while doing so.
        flag: files === 0,
      }
    }),
  ]

  return {
    version,
    gap: await versionGap('open-webui/open-webui', version),
    selfLatest: ver?.latest ?? null,
    generating: usage?.model_ids?.length ?? null,
    reach,
    counts: { models: modelList.length, tools: toolList.length, knowledge: kbList.length },
    // The admin endpoints share one key, so one refusal is the key rather than
    // the endpoint. Tested on tools rather than models: /api/models answers
    // for any authenticated caller, so it cannot tell an admin key from a
    // useless one.
    note:
      tools === null
        ? 'Open WebUI refused the admin API. It needs a key from Account → API Keys, in ' +
          'stacks/daedalus/service-keys.sops as OPENWEBUI_KEY.'
        : null,
  }
}
