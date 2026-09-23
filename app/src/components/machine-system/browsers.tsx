import type { NodeBrowser } from '../../lib/agent/status'

import type { NodeSystemData } from '../../lib/dashboard/node-system'
import { DASH, num } from '../../lib/format'
import type { Tone } from '../../lib/tone'
import { Board, BoardGrid, Chip, Facts } from '../viz'
import {
  ago,
  DetailNote,
  EMPTY,
  FOOT,
  MONO,
  NOTE,
  PART,
  PART_DETAIL,
  PART_ID,
  PART_NAME,
} from './shared'

/* ── Chromium ─────────────────────────────────────────────────────────── */

/**
 * The browsers on a node, as Shotter is the browser on the box.
 *
 * Shotter is more than a browser — a lab, with runs and an archive — because
 * the box has no screen and had to be given eyes. A laptop has a screen and
 * a browser already; what the page can add is what a person at the keyboard
 * rarely checks: which Chromium each one is, whether it is the version the
 * vendor is shipping this week, whether it is open, and which one links
 * open in. One board per browser, the vendor's feed beside it, and a foot
 * that says where the "current" came from.
 */
export function NodeBrowsersView({ d }: { d: NodeSystemData }) {
  const t = d.telemetry
  if (t === null) return null
  const latest = new Map((d.browserLatest ?? []).map((l) => [l.kind, l]))

  return (
    <BoardGrid>
      {t.browsers.length === 0 ? (
        <Board title="No Chromium" icon="◐" span={12}>
          <p className={EMPTY}>
            {d.full
              ? 'The agent found no Chromium-based browser: none of Chrome, Edge, Brave, Arc, Vivaldi, Opera or a bare Chromium is installed where the OS registers applications.'
              : 'The browser inventory arrives with agent 0.9.0.'}
          </p>
          <DetailNote d={d} />
        </Board>
      ) : (
        t.browsers.map((b) => (
          <BrowserBoard
            key={`${b.kind}-${b.channel ?? ''}`}
            b={b}
            latest={latest.get(b.kind) ?? null}
            asked={d.browserLatest === null}
            os={d.node.os}
          />
        ))
      )}

      <Board title="Where “current” comes from" icon="✓" span={12}>
        <Facts
          rows={[
            {
              k: 'Chrome',
              v: 'Google’s VersionHistory API, the stable channel for this OS and chip',
            },
            { k: 'Edge', v: 'Microsoft’s Edge update service, the Stable product for this OS' },
            { k: 'Brave', v: 'Brave’s GitHub releases, the latest that is not a pre-release' },
            {
              k: 'Arc, Vivaldi, Opera',
              v: 'no feed this box can read; the installed version stands alone',
            },
          ]}
        />
        <p className={FOOT}>
          Read when this tab opens and kept six hours. A browser a step behind is usually one
          restart behind: every one of these updates itself and applies it on its next launch, which
          on a machine that is never closed can be a while. Nothing here asks the machine to restart
          one. The inventory itself comes from the agent every ten minutes, from where the OS
          registers applications; a portable install in a folder is not seen.
        </p>
      </Board>
    </BoardGrid>
  )
}

function BrowserBoard({
  b,
  latest,
  asked,
  os,
}: {
  b: NodeBrowser
  latest: { latest: string | null; publishedAt: string | null; error: string | null } | null
  asked: boolean
  os: string
}) {
  // An MSIX install (Arc on Windows) has no version resource, but its
  // package directory is named for the version: read it from the path.
  const version = b.version ?? b.path?.match(/_(\d+\.\d+\.\d+\.\d+)_/)?.[1] ?? null
  const behind = browserBehind(version, latest?.latest ?? null)
  const verdict: { tone: Tone; label: string } =
    latest === null
      ? { tone: 'muted', label: asked ? 'not checked' : 'no feed' }
      : latest.latest === null
        ? { tone: 'muted', label: 'feed silent' }
        : behind === null
          ? { tone: 'muted', label: 'unreadable' }
          : behind
            ? { tone: 'warn', label: 'behind' }
            : { tone: 'ok', label: 'current' }
  const stepsBehind =
    behind === true && version !== null && latest?.latest != null
      ? majorGap(version, latest.latest)
      : null

  return (
    <Board
      title={b.name}
      icon="◐"
      span={6}
      aside={
        <span className="flex items-center gap-2">
          {b.defaultBrowser && <Chip tone="info">default</Chip>}
          <Chip tone={b.running ? 'ok' : 'muted'}>{b.running ? 'open' : 'closed'}</Chip>
        </span>
      }
    >
      <div className={PART}>
        <div className={PART_ID}>
          <strong className={PART_NAME}>
            <span className={MONO}>{version ?? DASH}</span>
          </strong>
          <span className={PART_DETAIL}>
            {b.channel ?? 'stable'} channel
            {b.kind === 'brave' && ' · Brave’s own number, not Chromium’s'}
          </span>
        </div>
        <Chip tone={verdict.tone}>{verdict.label}</Chip>
      </div>
      <Facts
        rows={[
          {
            k: 'Installed',
            v: (
              <span className={MONO}>
                {version ?? DASH}
                {b.version === null && version !== null && (
                  <span className={NOTE}> from the package name</span>
                )}
              </span>
            ),
          },
          {
            k: 'Vendor ships',
            v:
              latest?.latest == null ? (
                <span className={NOTE}>{latest?.error ?? DASH}</span>
              ) : (
                <span className={MONO}>{latest.latest}</span>
              ),
          },
          {
            k: 'Published',
            v: latest?.publishedAt == null ? DASH : ago(latest.publishedAt),
          },
          {
            k: 'Installed at',
            v:
              b.path === null ? (
                <span className={NOTE}>on the full document</span>
              ) : (
                <span className={MONO}>{b.path}</span>
              ),
          },
        ]}
      />
      <p className={FOOT}>
        {behind === true && stepsBehind !== null && stepsBehind > 0 && (
          <>
            {num(stepsBehind)} major {stepsBehind === 1 ? 'release' : 'releases'} behind the
            vendor&rsquo;s current — Chromium ships a major every four weeks, so that is about{' '}
            {num(stepsBehind * 4)} weeks of fixes waiting for a relaunch.{' '}
          </>
        )}
        {behind === true && stepsBehind === 0 && (
          <>
            A minor step behind: the update is likely already downloaded and waiting for a relaunch.{' '}
          </>
        )}
        {behind === false && <>The version the vendor is shipping today. </>}
        {b.running
          ? os === 'macos'
            ? 'Open right now, so an update it has fetched waits until it is quit.'
            : 'Open right now, so an update it has fetched waits until it is closed.'
          : 'Not running.'}
        {b.defaultBrowser && ' Links from other apps open here.'}
      </p>
    </Board>
  )
}

/** How many Chromium majors separate two versions ("152.0.…" → "154.0.…" is 2). */
function majorGap(installed: string, latest: string): number {
  const a = Number(installed.split('.')[0])
  const b = Number(latest.split('.')[0])
  return Number.isNaN(a) || Number.isNaN(b) ? 0 : Math.max(0, b - a)
}

/**
 * Whether the installed version is the vendor's current one. Chromium
 * versions compare as four numbers; Brave's own numbering compares the
 * same way. Null when either side is missing.
 */
function browserBehind(installed: string | null, latest: string | null): boolean | null {
  if (installed === null || latest === null) return null
  const a = installed.split('.').map(Number)
  const b = latest.split('.').map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (Number.isNaN(x) || Number.isNaN(y)) return null
    if (x !== y) return x < y
  }
  return false
}
