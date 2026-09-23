import { describe, expect, it } from 'vitest'
import type { FleetProvider } from '../lib/providers/fleet'
import type { LitellmRoute, ProviderModel } from '../lib/providers/kinds'
import type { ProviderReading } from '../lib/providers/read'
import {
  type GatewayClient,
  type GatewayModel,
  gatewayModelsOf,
  planRoutes,
  reconcile,
} from './gateway-sync'

const pc: FleetProvider = {
  machine: 'pc',
  machineName: 'gaming-pc',
  os: 'windows',
  kind: 'lemonade',
  base: 'http://gaming-pc.lan:13305',
  offered: true,
}

const model = (id: string, over: Partial<ProviderModel> = {}): ProviderModel => ({
  id,
  labels: [],
  mode: 'chat',
  supportsTools: false,
  supportsVision: false,
  downloaded: true,
  sizeGb: null,
  recipe: null,
  ...over,
})

const reading = (
  models: ProviderModel[],
  reachable = true,
  loaded: ProviderReading['health']['loaded'] = [],
): ProviderReading => ({
  kind: 'lemonade',
  base: pc.base,
  reachable,
  health: { ok: reachable, version: '10.8.1', loaded },
  models,
  error: null,
  readAt: 0,
})

/** A gateway in memory: what /model/info would answer, and what was done to it. */
function fakeGateway(rows: GatewayModel[]): GatewayClient & { log: string[] } {
  const log: string[] = []
  let n = 0
  const fromRoute = (id: string, r: LitellmRoute): GatewayModel => ({
    id,
    dbModel: true,
    modelName: r.model_name,
    upstream: r.litellm_params.model,
    apiBase: r.litellm_params.api_base,
    timeout: r.litellm_params.timeout ?? null,
    modelInfo: { ...r.model_info, id, db_model: true },
    tag: r.model_info.daedalus,
  })
  return {
    log,
    info: async () => rows,
    add: async (r) => {
      rows.push(fromRoute(`db${String(++n)}`, r))
      log.push(`add ${r.model_name}`)
    },
    update: async (id, r) => {
      const i = rows.findIndex((x) => x.id === id)
      if (i >= 0) rows[i] = fromRoute(id, r)
      log.push(`update ${r.model_name}`)
    },
    remove: async (id) => {
      const i = rows.findIndex((x) => x.id === id)
      log.push(`remove ${rows[i]?.modelName ?? id}`)
      if (i >= 0) rows.splice(i, 1)
    },
  }
}

const configRoute = (name: string, upstream: string): GatewayModel => ({
  id: `cfg-${name}`,
  dbModel: false,
  modelName: name,
  upstream,
  apiBase: 'http://gaming-pc.lan:13305/api/v1',
  timeout: 600,
  modelInfo: { id: `cfg-${name}`, db_model: false, mode: 'chat' },
  tag: null,
})

describe('what /model/info says', () => {
  it('keeps the id, the tag and what the reconcile compares', () => {
    const m = gatewayModelsOf({
      data: [
        {
          model_name: 'gemma',
          litellm_params: {
            model: 'openai/G',
            api_base: 'http://x/api/v1',
            timeout: 600,
            api_key: '***',
          },
          model_info: {
            id: 'abc',
            db_model: true,
            mode: 'chat',
            daedalus: { node: 'pc', kind: 'lemonade', id: 'G' },
          },
        },
        { model_name: 'bad' },
      ],
    })
    expect(m).toHaveLength(1)
    expect(m[0]).toMatchObject({
      id: 'abc',
      dbModel: true,
      upstream: 'openai/G',
      timeout: 600,
      tag: { node: 'pc', kind: 'lemonade', id: 'G' },
    })
  })
})

describe('the plan', () => {
  it('offers every downloaded model under its alias, and refuses a clash', () => {
    const { desired, skipped } = planRoutes({
      readings: [
        {
          provider: pc,
          reading: reading([model('A-GGUF'), model('B', { downloaded: false }), model('C')]),
        },
      ],
      policies: () => ({ C: { alias: 'a' } }),
      existing: [],
    })
    // The plain name was chosen for C; A-GGUF, unnamed, falls back to its id.
    expect(desired.map((d) => d.route.model_name).sort()).toEqual(['a', 'a-gguf'])
    expect(skipped).toEqual([])
    // Two chosen aliases that coincide: the second is refused, never renamed.
    const clash = planRoutes({
      readings: [{ provider: pc, reading: reading([model('A'), model('B')]) }],
      policies: () => ({ A: { alias: 'x' }, B: { alias: 'x' } }),
      existing: [],
    })
    expect(clash.desired.map((d) => d.route.model_name)).toEqual(['x'])
    expect(clash.skipped).toEqual([{ alias: 'x', why: 'already A on gaming-pc' }])
  })

  it('lets a config route to the same upstream be migrated, and blocks a different one', () => {
    const { desired, skipped } = planRoutes({
      readings: [{ provider: pc, reading: reading([model('G'), model('Z')]) }],
      policies: () => ({ G: { alias: 'gemma' }, Z: { alias: 'gpt-image-2' } }),
      existing: [
        configRoute('gemma', 'openai/G'),
        configRoute('gpt-image-2', 'openai/gpt-image-2'),
      ],
    })
    expect(desired.map((d) => d.route.model_name)).toEqual(['gemma'])
    expect(skipped[0]?.why).toMatch(/config\.yaml route to openai\/gpt-image-2/)
  })

  it('takes the context from the loaded model, else from the route it already has', () => {
    const existing: GatewayModel = {
      id: 'db1',
      dbModel: true,
      modelName: 'g',
      upstream: 'openai/G',
      apiBase: 'http://gaming-pc.lan:13305/api/v1',
      timeout: 600,
      modelInfo: { max_input_tokens: 100_000, max_output_tokens: 16_384 },
      tag: { node: 'pc', kind: 'lemonade', id: 'G' },
    }
    const loaded = planRoutes({
      readings: [
        {
          provider: pc,
          reading: reading([model('G')], true, [
            { id: 'G', device: 'gpu', maxContext: 262144, pinned: false },
          ]),
        },
      ],
      policies: () => ({ G: { alias: 'g' } }),
      existing: [existing],
    })
    expect(loaded.desired[0]?.route.model_info.max_input_tokens).toBe(262144 - 16384)
    const unloaded = planRoutes({
      readings: [{ provider: pc, reading: reading([model('G')]) }],
      policies: () => ({ G: { alias: 'g' } }),
      existing: [existing],
    })
    expect(unloaded.desired[0]?.route.model_info.max_input_tokens).toBe(100_000)
  })
})

describe('the reconcile', () => {
  it('creates, keeps, updates and deletes only what it made', async () => {
    const gw = fakeGateway([configRoute('gemma', 'openai/G')])
    const first = await reconcile(
      gw,
      [
        {
          provider: pc,
          reading: reading([model('G'), model('K', { labels: ['tts'], mode: 'audio_speech' })]),
        },
      ],
      () => ({ G: { alias: 'gemma' } }),
      1,
    )
    expect(first.created.sort()).toEqual(['gemma', 'k'])
    expect(gw.log).toEqual(['add gemma', 'add k'])

    // Nothing changed: everything kept, nothing written.
    gw.log.length = 0
    const second = await reconcile(
      gw,
      [
        {
          provider: pc,
          reading: reading([model('G'), model('K', { labels: ['tts'], mode: 'audio_speech' })]),
        },
      ],
      () => ({ G: { alias: 'gemma' } }),
      2,
    )
    expect(second).toMatchObject({ created: [], updated: [], deleted: [] })
    expect(second.kept.sort()).toEqual(['gemma', 'k'])
    expect(gw.log).toEqual([])

    // A rename is an update; a model gone from a provider that answered is a delete.
    const third = await reconcile(
      gw,
      [{ provider: pc, reading: reading([model('G')]) }],
      () => ({ G: { alias: 'gemma-4' } }),
      3,
    )
    expect(third.updated).toEqual(['gemma-4'])
    expect(third.deleted).toEqual(['k'])
    // A rename is a remove and an add (LiteLLM's update keeps the name).
    expect(gw.log.filter((l) => l.startsWith('remove gemma') || l === 'add gemma-4')).toEqual([
      'remove gemma',
      'add gemma-4',
    ])
    // The config route was never touched.
    expect(gw.log.some((l) => l.includes('cfg'))).toBe(false)
  })

  it('keeps the routes of a provider that did not answer, and drops a switched-off one', async () => {
    const gw = fakeGateway([])
    await reconcile(gw, [{ provider: pc, reading: reading([model('G')]) }], () => undefined, 1)
    const asleep = await reconcile(
      gw,
      [{ provider: pc, reading: reading([], false) }],
      () => undefined,
      2,
    )
    expect(asleep.kept).toEqual(['g'])
    expect(asleep.deleted).toEqual([])
    const off = await reconcile(
      gw,
      [{ provider: { ...pc, offered: false }, reading: reading([model('G')]) }],
      () => undefined,
      3,
    )
    expect(off.deleted).toEqual(['g'])
  })

  it('drops routes of a machine the box no longer knows', async () => {
    const gw = fakeGateway([])
    await reconcile(gw, [{ provider: pc, reading: reading([model('G')]) }], () => undefined, 1)
    const gone = await reconcile(gw, [], () => undefined, 2)
    expect(gone.deleted).toEqual(['g'])
  })
})

describe('two models with one plain name', () => {
  it('gives the chosen one the name and the other its id', () => {
    const { desired, skipped } = planRoutes({
      readings: [
        {
          provider: pc,
          reading: reading([model('Gemma-4-12B-it-GGUF'), model('Gemma-4-12B-it-MTP-GGUF')]),
        },
      ],
      policies: () => ({ 'Gemma-4-12B-it-MTP-GGUF': { alias: 'gemma-4-12b' } }),
      existing: [],
    })
    expect(desired.map((d) => d.route.model_name).sort()).toEqual([
      'gemma-4-12b',
      'gemma-4-12b-it-gguf',
    ])
    expect(skipped).toEqual([])
  })
})
