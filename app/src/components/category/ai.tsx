import { useState } from 'react'
import { useRouter } from '@tanstack/react-router'

import { BarList, BigStat, Board, BoardGrid, Chip, Columns, Facts, Pulse, StatBand } from '../viz'
import { GrafanaLogs } from '../logs'
import { ReleaseNotes, UpgradeChain } from '../release-notes'
import { LinkRow, ServiceHead, type CompareRow } from '../service-head'
import { loadLemonadeModel, unloadLemonadeModel } from '../../server/lemonade'
import { DASH, num, pct } from '../../lib/dashboard/format'
import type { VersionGap } from '../../lib/dashboard/github'
import type { AiData } from '../../server/category'
import type { Tone } from '../viz'

// The AI pages — one per service, chosen by the sub-tab.
//
// Every one of them opens the same way, and that is deliberate: artwork, name,
// the version running, the verdict on whether that version is current, one
// sentence saying where this service sits in the chain, and the link you came
// to click. Four services whose UIs look nothing alike become four pages that
// are read the same way.
//
// Underneath, each is its own thing. Lemonade's page is about VRAM and what is
// resident; LiteLLM's is about traffic and routing; the two caller pages are
// mostly "is it configured the way I think it is". Forcing those into a shared
// layout is what the previous single-page version did, and it is why every
// service got a quarter of a row it could not say anything useful in.

export function AiView({ data }: { data: AiData }) {
  switch (data.tab) {
    case 'lemonade':
      return <LemonadeView data={data} />
    case 'litellm':
      return <LitellmView data={data} />
    case 'open-webui':
      return <OpenWebUiView data={data} />
    case 'n8n':
      return <N8nView data={data} />
  }
}

/**
 * The version verdict, from the release gap.
 *
 * One function rather than four copies because the phrasing is the argument:
 * "3 behind" is a fact you can act on, "update available" is a nag, and
 * "unknown" is what to say when GitHub would not answer rather than quietly
 * claiming to be current.
 */
function verdictOf(gap: VersionGap): { label: string; tone: Tone } {
  if (gap.installed === null || gap.latest === null) return { label: 'unknown', tone: 'muted' }
  if (gap.behind.length === 0) return { label: 'current', tone: 'ok' }
  return { label: `${String(gap.behind.length)} behind`, tone: 'warn' }
}

function compareOf(gap: VersionGap, note: string): CompareRow[] {
  return [
    {
      k: 'Latest',
      v: gap.latest,
      note:
        gap.latest === null ? 'GitHub did not answer'
        : gap.behind.length === 0 ? 'this is what is running'
        : `${String(gap.behind.length)} release${gap.behind.length === 1 ? '' : 's'} between them`,
    },
    { k: 'Pinned by', v: null, note },
  ]
}

/** The release-notes board, identical on all four tabs. */
function ReleaseBoard({ gap, span = 12 }: { gap: VersionGap; span?: 6 | 12 }) {
  const current = gap.behind.length === 0

  return (
    <Board
      title={current ? 'Release notes' : `${String(gap.behind.length)} to apply`}
      icon="≡"
      span={span}
      aside={<span className="board-note">github releases</span>}
    >
      <UpgradeChain behind={gap.behind} />
      <ReleaseNotes
        releases={gap.releases}
        running={gap.installed}
        empty={gap.note ?? 'no published notes for this version'}
      />
      <p className="board-foot">
        {current ?
          'What the running version shipped. '
        : 'Everything between the running version and the newest release, oldest at the top. '}
        Parsed from the project’s own GitHub releases and shortened — open one for the detail, and
        the link inside goes to the full text.
      </p>
    </Board>
  )
}

// ── Lemonade ───────────────────────────────────────────────────────────────

function LemonadeView({ data }: { data: Extract<AiData, { tab: 'lemonade' }> }) {
  const { gap, host, live, last, slots } = data
  const full = slots.filter((s) => s.used >= s.max).length

  return (
    <>
      <ServiceHead
        logo="/icon-lemonade.png"
        name="Lemonade"
        version={data.version}
        versionNote="running on the gaming PC"
        verdict={verdictOf(gap)}
        compare={compareOf(gap, 'nothing here — it is installed on Windows, not in the flake')}
        lede={
          <>
            The only thing in this stack that holds weights, and the only one not on this box. Every
            caller reaches it through LiteLLM; it never sees them directly.
          </>
        }
        actions={
          <a className="btn btn-primary" href={data.baseUrl} target="_blank" rel="noreferrer">
            Open Lemonade ↗
          </a>
        }
      />
      <LinkRow
        links={[
          { label: 'API docs', href: 'https://lemonade-server.ai/docs/api/lemonade/' },
          { label: 'Model library', href: 'https://lemonade-server.ai/docs/server/server_models/' },
          { label: 'GitHub', href: 'https://github.com/lemonade-sdk/lemonade' },
        ]}
      />

      <StatBand>
        <BigStat
          label="Resident"
          value={String(data.models.length)}
          tone="ok"
          sub={`${String(full)} of ${String(slots.length)} slots full`}
        />
        <BigStat
          label="Throughput"
          value={last.tps === null ? DASH : last.tps.toFixed(1)}
          unit="tok/s"
          sub="last generation"
        />
        <BigStat
          label="First token"
          value={last.ttftMs === null ? DASH : num(last.ttftMs)}
          unit="ms"
          tone="info"
          sub="last generation"
        />
        <BigStat
          label="Requests served"
          value={num(last.requests)}
          tone="muted"
          sub={`${num(last.outputTokens)} tokens out`}
        />
      </StatBand>

      <BoardGrid>
        <Board
          title="Model rack"
          icon="▤"
          span={12}
          aside={<span className="board-note">most recently used first</span>}
        >
          {data.models.length === 0 ?
            <p className="viz-empty">Lemonade did not answer</p>
          : <div className="rack">
              {data.models.map((m) => (
                <ModelRow key={m.name} model={m} />
              ))}
            </div>
          }
          {/* The cap is per TYPE, which is the thing that surprises people:
              one chat model resident out of a limit of one means the rack is
              full even though five other models are also loaded. */}
          <div className="slots">
            {slots.map((s) => (
              <span key={s.type} className={s.used >= s.max ? 'slot slot-full' : 'slot'}>
                {s.type} <b>{s.used}</b>/{s.max}
              </span>
            ))}
          </div>
          <p className="board-foot">
            Lemonade loads on demand and evicts the least recently used model when the card fills,
            so this changes on its own. <b>Warm</b> pins a model so it survives that eviction and
            the next request skips a cold load; <b>Evict</b> hands the VRAM and the file handle
            back. Ordering is Lemonade’s own — it reports a sequence, not timestamps, so there is
            no “used 4 minutes ago” to show.
          </p>
        </Board>

        <Board title="The gaming PC" icon="▣" span={6} fill>
          <Facts
            rows={[
              { k: 'GPU', v: host.gpu ?? DASH },
              { k: 'Driver', v: host.driver ?? DASH },
              { k: 'CPU', v: host.cpu ?? DASH },
              { k: 'Memory', v: host.ramGb === null ? DASH : `${num(host.ramGb)} GB` },
              { k: 'OS', v: host.os ?? DASH },
              {
                k: 'CPU now',
                v: live.cpuPct === null ? DASH : pct(live.cpuPct, 1),
              },
              {
                k: 'Memory now',
                v: live.memGb === null ? DASH : `${num(live.memGb, 1)} GB`,
              },
              {
                k: 'Models on disk',
                v: `${String(data.catalog.downloaded)} of ${String(data.catalog.total)} · ${num(data.catalog.sizeGb, 1)} GB`,
              },
            ]}
          />
          {data.downloads.length > 0 && (
            <>
              <h4 className="board-sub">Downloading</h4>
              <Facts
                rows={data.downloads.map((d) => ({
                  k: d.model,
                  v: `${d.status}${d.percent === null ? '' : ` · ${num(d.percent)}%`}`,
                }))}
              />
            </>
          )}
          {/* Stated rather than left as two suspicious em dashes — and stated
              accurately, which took reading the vendor's source. */}
          <p className="board-foot">
            CPU and memory are the whole of what Lemonade will report about this machine. GPU
            utilisation and VRAM are not missing because of the card: its Windows metrics backend
            returns “not implemented” for both, where its macOS and Linux ones do not. Zero would
            be a claim that the card is idle, so nothing is drawn. Until something else measures
            it, how hard the GPU is working is the throughput number above.
          </p>
        </Board>

        <Board
          title="Inference runtimes"
          icon="⚙"
          span={6}
          fill
          aside={<span className="board-note">installed backends</span>}
        >
          {data.backends.length === 0 ?
            <p className="viz-empty">could not read the backend matrix</p>
          : <ul className="runtimes">
              {data.backends.map((b) => (
                <li key={`${b.recipe}-${b.backend}`}>
                  <span className="rt-name">
                    {b.recipe}
                    <Chip tone={b.backend === 'rocm' ? 'ok' : 'muted'}>{b.backend}</Chip>
                  </span>
                  {b.url === null ?
                    <span className="rt-ver mono">{b.version}</span>
                  : <a className="rt-ver mono" href={b.url} target="_blank" rel="noreferrer">
                      {b.version}
                    </a>
                  }
                </li>
              ))}
            </ul>
          }
          <p className="board-foot">
            These move independently of the Lemonade version above — a llama.cpp build number
            bumps far more often than a release does, and it is the thing that changes how fast a
            model runs. ROCm is the AMD path; the one known hole is StableDiffusion.cpp on ROCm,
            which is missing a Tensile library for this card and needs the Vulkan backend instead.
          </p>
        </Board>

        <ReleaseBoard gap={gap} />

        <Board title="Logs" icon="≡" span={12}>
          {/* Selected by STACK, not container. These lines were not produced on
              this box at all — the bridge in stacks/lemonade-logs reads
              Lemonade's WebSocket on the gaming PC and pushes them to Loki
              directly, so there is no podman container to name. */}
          <GrafanaLogs
            source={{ stack: 'lemonade' }}
            title="Lemonade server logs"
            foot={
              <p className="board-foot">
                Lemonade’s own log, streamed off the gaming PC over its <code>/logs/stream</code>{' '}
                WebSocket — the only log egress it has — and pushed to Loki by the bridge below.
                Timestamps are the ones Lemonade recorded, not the ones Loki received.
              </p>
            }
          />

          {/* The bridge is diagnostics for the panel above, not a service
              anybody watches. Collapsed, so it is one click away on the day the
              logs above stop arriving and invisible on every other day. */}
          <details className="sublog">
            <summary>Bridge logs — the process shipping the above</summary>
            <GrafanaLogs
              source={{ container: 'lemonade-logs' }}
              title="Lemonade log bridge"
              foot={
                <p className="board-foot">
                  Deliberately a separate stream: this is the bridge’s own reconnects and gap
                  warnings, and mixing them into Lemonade’s log would make the model server look
                  like it was reporting network trouble it knows nothing about. Look here when the
                  panel above goes quiet.
                </p>
              }
            />
          </details>
        </Board>
      </BoardGrid>
    </>
  )
}

/**
 * One resident model, with the two things you can do to it.
 *
 * Both actions are optimistic about nothing: the button goes busy, the server
 * function answers, and the router is invalidated so the rack re-reads from
 * Lemonade rather than from what we assumed happened. A load can take tens of
 * seconds on a cold 12B model, which is exactly why the state is visible.
 */
function ModelRow({ model }: { model: Extract<AiData, { tab: 'lemonade' }>['models'][number] }) {
  const router = useRouter()
  const [busy, setBusy] = useState<null | 'warm' | 'evict'>(null)
  const [error, setError] = useState<string | null>(null)

  const run = (what: 'warm' | 'evict', fn: () => Promise<{ ok: boolean; message: string }>) => {
    setBusy(what)
    setError(null)
    void fn()
      .then((r) => {
        if (!r.ok) setError(r.message)
        return router.invalidate()
      })
      .finally(() => {
        setBusy(null)
      })
  }

  return (
    <div className={model.hot ? 'rack-row rack-hot' : 'rack-row'}>
      <span className="rack-name" title={model.checkpoint}>
        {model.hot && <Pulse on tone="accent" />}
        {model.name}
      </span>
      <span className="rack-tags">
        <Chip tone={model.device === 'gpu' ? 'ok' : 'muted'}>{model.device}</Chip>
        <Chip tone="info">{model.type}</Chip>
        <Chip>{model.recipe}</Chip>
        {model.backend !== null && <Chip>{model.backend}</Chip>}
        {model.context !== null && <Chip>{num(model.context / 1024)}k ctx</Chip>}
        {model.pinned && <Chip tone="accent">pinned</Chip>}
      </span>
      <span className="rack-actions">
        {error !== null && (
          <span className="bad-text" title={error}>
            failed
          </span>
        )}
        {!model.pinned && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy !== null}
            onClick={() => {
              run('warm', () => loadLemonadeModel({ data: { model: model.name, pinned: true } }))
            }}
          >
            {busy === 'warm' ? '· warming…' : 'Warm'}
          </button>
        )}
        <button
          type="button"
          className="btn btn-ghost"
          disabled={busy !== null}
          onClick={() => {
            run('evict', () => unloadLemonadeModel({ data: { model: model.name } }))
          }}
        >
          {busy === 'evict' ? '· evicting…' : 'Evict'}
        </button>
      </span>
    </div>
  )
}

// ── LiteLLM ────────────────────────────────────────────────────────────────

function LitellmView({ data }: { data: Extract<AiData, { tab: 'litellm' }> }) {
  const { gap, headline } = data
  const busy = headline.inFlight !== null && headline.inFlight > 0
  const total = data.daily.reduce((a, d) => a + d.requests, 0)

  return (
    <>
      <ServiceHead
        logo="/icon-litellm.png"
        name="LiteLLM"
        version={data.version}
        versionNote="one OpenAI API for everything"
        verdict={verdictOf(gap)}
        compare={compareOf(gap, 'a digest in the flake, against a moving main-stable tag')}
        lede={
          <>
            The only thing that knows who asked for what. Nothing here holds a model — swapping
            Lemonade out is a config change here and no caller notices.
          </>
        }
        actions={
          <a
            className="btn btn-primary"
            href="https://litellm.toscanini.me/ui"
            target="_blank"
            rel="noreferrer"
          >
            Open the admin UI ↗
          </a>
        }
      />
      <LinkRow
        links={[
          { label: 'Docs', href: 'https://docs.litellm.ai/docs/simple_proxy' },
          { label: 'Model hub', href: 'https://litellm.toscanini.me/ui/model_hub_table' },
          { label: 'GitHub', href: 'https://github.com/BerriAI/litellm' },
        ]}
      />

      <StatBand>
        <BigStat
          label="Requests today"
          value={num(headline.requestsToday)}
          spark={headline.requestsSpark}
          sub={`${num(total)} in ${String(data.daily.length)}d`}
        />
        <BigStat
          label="Tokens today"
          value={num(headline.tokensToday)}
          tone="info"
          sub={`${num(data.daily.reduce((a, d) => a + d.tokens, 0))} in ${String(data.daily.length)}d`}
        />
        <BigStat
          label="In flight"
          value={num(headline.inFlight)}
          tone={busy ? 'accent' : 'muted'}
          sub={
            <>
              <Pulse on={busy} tone="accent" />
              right now
            </>
          }
        />
        <BigStat
          label="Failed today"
          value={num(headline.failedToday)}
          tone={headline.failedToday !== null && headline.failedToday > 0 ? 'bad' : 'muted'}
          sub={`${num(data.daily.reduce((a, d) => a + d.failed, 0))} in ${String(data.daily.length)}d`}
        />
      </StatBand>

      <BoardGrid>
        <Board
          title="Gateway traffic"
          icon="◇"
          span={8}
          aside={<span className="board-note">requests per day, {data.daily.length} days</span>}
        >
          <Columns
            points={data.daily.map((d) => ({
              // Month-day only: the year is the same for every column and the
              // axis is narrow.
              label: d.date.slice(5),
              value: d.requests,
              display: `${num(d.requests)} requests · ${num(d.tokens)} tokens`,
            }))}
          />
          <p className="board-foot">
            From the gateway’s own ledger rather than its Prometheus counters, which reset on every
            restart — a “top day” read off a counter would quietly mean “since the last deploy”.
          </p>
        </Board>

        <Board
          title="Latency by model"
          icon="⚡"
          span={4}
          fill
          aside={<span className="board-note">mean, 24h</span>}
        >
          <BarList
            items={data.latency.map((l) => ({
              label: l.label,
              value: l.value,
              display: `${num(l.value)}ms`,
            }))}
            tone="info"
            empty="no requests in the last day"
          />
          <p className="board-foot">
            End to end, so it includes the cold-load penalty when Lemonade had evicted the model —
            which is what makes the Warm button on the Lemonade tab worth having.
          </p>
        </Board>

        <Board title="Where the tokens went" icon="◑" span={6} fill>
          <BarList
            items={data.byModel.map((m) => ({ label: m.label, value: m.value, display: num(m.value) }))}
            empty="no traffic in the window"
          />
          <h4 className="board-sub">By client</h4>
          <BarList
            items={data.byClient.map((c) => ({ label: c.label, value: c.value, display: num(c.value) }))}
            tone="info"
            empty="no keyed traffic in the window"
          />
          <p className="board-foot">
            Clients are named by their virtual key’s alias, so an unaliased key shows as a hash
            prefix. A caller missing from this list is idle, not absent.
          </p>
        </Board>

        <Board
          title="What resolves where"
          icon="⇄"
          span={6}
          fill
          aside={<span className="board-note">{data.routes.length} published</span>}
        >
          {data.routes.length === 0 ?
            <p className="viz-empty">the gateway did not answer</p>
          : <ul className="routes">
              {data.routes.map((r) => (
                <li key={r.name}>
                  <span className="route-name mono">{r.name}</span>
                  <span className="route-arrow" aria-hidden="true">
                    →
                  </span>
                  <span className="route-target mono" title={r.target}>
                    {r.target}
                  </span>
                  <Chip tone="muted">{r.mode}</Chip>
                </li>
              ))}
            </ul>
          }
          <p className="board-foot">
            The left column is what a caller asks for; the right is the model Lemonade actually
            serves. They are deliberately different — renaming a model on the gaming PC should not
            break Home Assistant’s config.
          </p>
        </Board>

        <ReleaseBoard gap={gap} />

        <Board title="Logs" icon="≡" span={12}>
          <GrafanaLogs source={{ container: 'litellm' }} title="LiteLLM logs" />
        </Board>
      </BoardGrid>
    </>
  )
}

// ── Open WebUI ─────────────────────────────────────────────────────────────

function OpenWebUiView({ data }: { data: Extract<AiData, { tab: 'open-webui' }> }) {
  const { gap, auth } = data

  return (
    <>
      <ServiceHead
        logo="/icon-open-webui.svg"
        name="Open WebUI"
        version={data.version}
        versionNote="the chat window"
        verdict={verdictOf(gap)}
        compare={compareOf(gap, 'a digest in the flake, against a moving main tag')}
        lede={
          <>
            The one service here a person types into. It talks to LiteLLM like any other OpenAI
            client, so it sees whatever the gateway publishes and nothing more.
          </>
        }
        actions={
          <a
            className="btn btn-primary"
            href="https://chat.toscanini.me"
            target="_blank"
            rel="noreferrer"
          >
            Open the chat ↗
          </a>
        }
      />
      <LinkRow
        links={[
          { label: 'Docs', href: 'https://docs.openwebui.com/' },
          { label: 'GitHub', href: 'https://github.com/open-webui/open-webui' },
        ]}
      />

      <StatBand>
        <BigStat
          label="Active users"
          value={num(data.users)}
          tone="ok"
          sub="seen in the last 3 minutes"
        />
        <BigStat
          label="Generating"
          value={num(data.generating)}
          tone={data.generating !== null && data.generating > 0 ? 'accent' : 'muted'}
          sub={
            <>
              <Pulse on={data.generating !== null && data.generating > 0} tone="accent" />
              models mid-answer
            </>
          }
        />
        <BigStat label="Models offered" value={String(data.models.length)} tone="info" sub="in the picker" />
        <BigStat
          label="Self-reported"
          value={data.latest === null || data.latest === data.version ? 'up to date' : data.latest}
          tone="muted"
          sub="its own update check"
        />
      </StatBand>

      <BoardGrid>
        <Board title="How you get in" icon="⚿" span={6} fill>
          <Facts
            rows={[
              { k: 'Identity provider', v: auth.oidc ?? 'none configured' },
              { k: 'Password form', v: auth.loginForm ? 'shown' : 'hidden' },
              { k: 'Straight to the IdP', v: auth.autoRedirect ? 'yes' : 'no' },
              { k: 'Self sign-up', v: auth.signup ? 'open' : 'closed' },
            ]}
          />
          <p className="board-foot">
            The login form is off, so the page redirects to Pocket ID rather than offering a
            password box that would be a second way in. The break-glass form is still reachable at{' '}
            <code>/auth?form=true</code> if the IdP is ever the thing that is down.
          </p>
        </Board>

        <Board
          title="Models in the picker"
          icon="▤"
          span={6}
          fill
          aside={<span className="board-note">as the chat sees them</span>}
        >
          {data.models.length === 0 ?
            <p className="viz-empty">could not read the model list</p>
          : <ul className="modellist">
              {data.models.map((m) => (
                <li key={m.id}>
                  <span className="model-name">{m.name}</span>
                  <span className="model-id mono">{m.id}</span>
                </li>
              ))}
            </ul>
          }
          <p className="board-foot">
            These are the gateway’s models plus whatever presets have been saved on top — a name
            here that is not on LiteLLM’s routing table is a preset, not a model.
          </p>
        </Board>

        <ReleaseBoard gap={gap} />

        <Board title="Logs" icon="≡" span={12}>
          <GrafanaLogs source={{ container: 'open-webui' }} title="Open WebUI logs" />
        </Board>
      </BoardGrid>
    </>
  )
}

// ── n8n ────────────────────────────────────────────────────────────────────

function N8nView({ data }: { data: Extract<AiData, { tab: 'n8n' }> }) {
  const { gap, counts } = data

  return (
    <>
      <ServiceHead
        logo="/icon-n8n.png"
        name="n8n"
        version={data.version}
        versionNote="pinned in the flake"
        verdict={verdictOf(gap)}
        compare={compareOf(gap, 'an exact tag in stacks/n8n — bump it there')}
        lede={
          <>
            Scheduled workflows, several of which call the gateway. Nothing here runs on a person
            being awake, which is why a failed run is worth seeing on a dashboard.
          </>
        }
        actions={
          <a
            className="btn btn-primary"
            href="https://n8n.toscanini.me"
            target="_blank"
            rel="noreferrer"
          >
            Open n8n ↗
          </a>
        }
      />
      <LinkRow
        links={[
          { label: 'Docs', href: 'https://docs.n8n.io/' },
          { label: 'Releases', href: 'https://github.com/n8n-io/n8n/releases' },
        ]}
      />

      <StatBand>
        <BigStat label="Active workflows" value={num(counts.active)} tone="ok" sub="on a schedule or trigger" />
        <BigStat label="Total workflows" value={num(counts.total)} tone="info" sub="including drafts" />
        <BigStat
          label="Failed"
          value={num(counts.failed)}
          tone={counts.failed !== null && counts.failed > 0 ? 'bad' : 'muted'}
          sub="of the recent runs below"
        />
        <BigStat
          label="Latest release"
          value={gap.latest ?? DASH}
          tone="muted"
          sub={gap.behind.length === 0 ? 'running it' : `${String(gap.behind.length)} behind`}
        />
      </StatBand>

      <BoardGrid>
        <Board title="Recent runs" icon="⟳" span={6} fill>
          {data.runs.length === 0 ?
            <p className="viz-empty">{data.note ?? 'no recent executions'}</p>
          : <ul className="runs">
              {data.runs.map((r, i) => (
                <li key={`${r.name}-${String(i)}`} className={`runs-row runs-${statusTone(r.status)}`}>
                  <span className="runs-name">{r.name}</span>
                  <span className="runs-status">{r.status}</span>
                  <span className="runs-when">{r.ago}</span>
                </li>
              ))}
            </ul>
          }
          <p className="board-foot">
            The newest eight, whatever their outcome. n8n keeps the full history and the stack
            traces behind the Executions tab — this is only enough to notice.
          </p>
        </Board>

        <Board
          title="Workflows"
          icon="◫"
          span={6}
          fill
          aside={<span className="board-note">active first</span>}
        >
          {data.workflows.length === 0 ?
            <p className="viz-empty">{data.note ?? 'no workflows'}</p>
          : <ul className="modellist">
              {data.workflows.map((w) => (
                <li key={w.name}>
                  <span className="model-name">{w.name}</span>
                  <Chip tone={w.active ? 'ok' : 'muted'}>{w.active ? 'active' : 'inactive'}</Chip>
                </li>
              ))}
            </ul>
          }
          <p className="board-foot">
            {/* The draft/published split has bitten this box before: an edit
                lands on the draft and the schedule keeps running the published
                version, so "I changed it and nothing happened" is expected. */}
            Editing a workflow changes its draft. A scheduled run uses the last <b>published</b>{' '}
            version, so a change is not live until you publish it.
          </p>
        </Board>

        <ReleaseBoard gap={gap} />

        <Board title="Logs" icon="≡" span={12}>
          <GrafanaLogs source={{ container: 'n8n' }} title="n8n logs" />
        </Board>
      </BoardGrid>
    </>
  )
}

function statusTone(status: string): string {
  if (status === 'success') return 'ok'
  if (status === 'running' || status === 'waiting' || status === 'new') return 'live'
  return 'bad'
}
