// The Shotter tab: the box's headless-browser lab — its runs, the newest
// run's slices, and the Playwright pin under it.

import { cn } from '../../lib/cn'
import type { ClaudeData } from '../../lib/dashboard/claude'
import type { ShotRun } from '../../lib/dashboard/shotter'
import { bytes, DASH, ms, num } from '../../lib/format'
import { Ago } from '../ago'
import { LogBoard } from '../logs'
import { Changelog } from '../release-notes'
import { ServiceHead } from '../service-head'
import { CELL_NAME, CELL_QUIET, TABLE, TABLE_EMPTY, TABLE_HEAD, TABLE_ROW } from '../table'
import { TableSection } from '../table-section'
import { CAPTION, EMPTY, FOOT, MONO, MONO_FACE, NOTE } from '../tokens'
import { Board, BoardGrid, Chip, Stat, StatStrip } from '../viz'
import { issueSummary, shotterVerdict } from './verdicts'

/* The strip holds one run's viewport slices — consecutive crops of a single
   long page — so they lay out as a film row: fixed height, natural width, side
   scroll. Each image is also the link to its full-size self. */
const SHOT_STRIP = 'flex gap-2 overflow-x-auto pb-1'
const SHOT_IMG = 'block h-[150px] w-auto rounded-lg border border-hairline bg-foreground/[0.03]'
/* An excerpt, not the artifact: it scrolls rather than grows, and keeps the
   runner's own line breaks. */
const SHOT_LOG =
  'm-0 max-h-36 overflow-auto rounded-xl border border-hairline bg-foreground/[0.03] px-3 py-2 font-mono text-[0.72rem] leading-[1.5] whitespace-pre-wrap text-muted-foreground'

const shotUrl = (run: string, file: string) => `/api/shot-run/${run}/${file}`

/**
 * The Shotter tab — the sessions' eyes, one tab over from the sessions.
 *
 * `shot` is how an agent on this GUI-less box looks at a web page
 * (stacks/shotter — no daemon, a cold Chromium per run), and the archive it
 * leaves is everything this tab reads. The thumbnails are the newest run's
 * viewport slices, served through api.shot-run out of the same read-only
 * mount. The version story is Playwright's: the image tag embeds the pin and
 * the npm package inside must match it, so one number IS the running
 * version, with microsoft/playwright's releases behind the changelog.
 */
export function ShotterView({ data }: { data: ClaudeData }) {
  const f = shotterFacts({ data })
  const { sh, verdict } = f

  return (
    <>
      <ServiceHead
        logo="/icon-shotter.svg"
        name="Shotter"
        version={data.shotterGap.installed}
        versionNote="Playwright — the pin in stacks/shotter/shotter.nix"
        verdict={{ label: verdict.label, tone: verdict.tone }}
        compare={[
          {
            k: 'Running',
            v: data.shotterGap.installed,
            note: 'the image tag embeds it; the npm package inside must match',
          },
          {
            k: 'Latest release',
            v: data.shotterGap.latest,
            note: 'bump playwrightVersion + playwrightDigest together, then rebuild',
          },
          {
            k: 'Base image',
            v: 'playwright:noble',
            note: 'mcr.microsoft.com — Chromium ships inside, digest-pinned',
          },
        ]}
        lede={
          <>
            The box&rsquo;s standing headless-browser lab, and the standard way any agent session
            verifies a web UI from a machine with no screen. Not a daemon: each{' '}
            <span className={MONO}>shot</span> is a cold, throwaway Chromium, and what persists is
            the image, the CLI and this archive. <span className={MONO}>shot help</span> on the box
            is the manual.
          </>
        }
        actions={<Chip tone="muted">no daemon — runs on demand</Chip>}
      />

      {!sh.available && (
        <p className={EMPTY}>
          The <span className={MONO}>/shotter</span> mount is not answering — either the rebuild
          that binds it has not landed, or the stack is gone. Nothing below is a reading.
        </p>
      )}

      <StatStrip>
        <Stat
          label="Runs"
          value={sh.totalRuns}
          sub="all-time, from the ledger"
          title="Every shot invocation ever, counted by stats.json. Prune trims the archive, never this."
        />
        <Stat
          label="Failed"
          value={sh.failedRuns}
          // A failure here is the runner dying, which an agent sees and acts
          // on at the terminal — history, not an alarm.
          tone={
            sh.failedRuns > 0 && sh.totalRuns > 0 && sh.failedRuns * 4 > sh.totalRuns
              ? 'warn'
              : undefined
          }
          sub="runner died mid-run"
        />
        <Stat
          label="Archive"
          value={sh.archived}
          sub={`run dirs · ${bytes(sh.runsBytes)}`}
          title="What prune has kept: 30 days, at most 40 runs. The ledger remembers everything."
        />
        <Stat
          label="Last run"
          value={sh.updatedAt === null ? 'never' : <Ago at={sh.updatedAt} />}
          // Deliberately never a warning tone: runs happen when an agent
          // needs eyes, and a quiet week is a true reading, not staleness.
          sub="quiet is a reading"
        />
      </StatStrip>

      {/* The newest run beside the version story — two short boards of one
          height — then the ledger as a table, full width. */}
      <div className="flex flex-col gap-10">
        <BoardGrid>
          <LatestRunBoard f={f} />

          <Changelog
            gap={data.shotterGap}
            span={8}
            aside={<span className={NOTE}>microsoft/playwright</span>}
            foot={
              <>
                <p className={FOOT}>
                  The one dependency under <span className={MONO}>shot</span> — Chromium arrives
                  inside Playwright&rsquo;s image, so this is the whole upgrade story. Moving is a
                  paired edit in <span className={MONO}>stacks/shotter/shotter.nix</span>:{' '}
                  <span className={MONO}>playwrightVersion</span> and{' '}
                  <span className={MONO}>playwrightDigest</span> together (Playwright refuses
                  browsers from a different revision), then a rebuild rebuilds the image.
                </p>
                {verdict.note !== '' && <p className={CAPTION}>{verdict.note}</p>}
              </>
            }
          />
        </BoardGrid>

        <RunsBoard f={f} />

        <BoardGrid>
          <ImageBuildLogsBoard />
        </BoardGrid>
      </div>
    </>
  )
}

/** What the page's boards read. */
function shotterFacts({ data }: { data: ClaudeData }) {
  const sh = data.shotter
  const latest = sh.latest
  const verdict = shotterVerdict(data.shotterGap)
  return { data, sh, latest, verdict }
}

type ShotterFacts = NonNullable<ReturnType<typeof shotterFacts>>

function LatestRunBoard({ f }: { f: ShotterFacts }) {
  const { latest } = f
  return (
    <Board
      title="Latest run"
      icon="panels"
      span={4}
      aside={latest === null ? undefined : <span className={cn(NOTE, MONO_FACE)}>{latest.id}</span>}
    >
      {latest === null ? (
        <p className={EMPTY}>
          No run directories yet. <span className={MONO}>shot quick &lt;url&gt;</span> makes the
          first one.
        </p>
      ) : (
        <>
          {latest.shots.length > 0 && (
            <div className={SHOT_STRIP}>
              {latest.shots.map((f) => (
                <a key={f} href={shotUrl(latest.id, f)} target="_blank" rel="noreferrer">
                  <img
                    className={SHOT_IMG}
                    src={shotUrl(latest.id, f)}
                    alt={`${latest.id} — ${f}`}
                    loading="lazy"
                  />
                </a>
              ))}
            </div>
          )}
          {latest.log.length > 0 && <pre className={SHOT_LOG}>{latest.log.join('\n')}</pre>}
        </>
      )}
      <p className={FOOT}>
        The newest run&rsquo;s viewport slices — consecutive crops of one long page, each linking to
        its full-size self — and the runner&rsquo;s own log under them. The full evidence (every
        slice, <span className={MONO}>events.json</span>, <span className={MONO}>log.txt</span>) is{' '}
        <span className={MONO}>shot show &lt;id&gt;</span> on the box.
      </p>
    </Board>
  )
}

/* One column grid for the ledger: run · events · shots · took · when · verdict.
   A clean run is the norm and its verdict a quiet word; only a run that
   differs — issues underneath, or the runner dying — takes a chip. */
const RUN_GRID = cn(
  'grid items-center gap-x-6 px-5',
  'grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_4rem_4.5rem_6rem_4.5rem]',
  '@max-[48rem]/table:grid-cols-[minmax(0,1fr)_4rem_6rem_4.5rem]',
)
const RUN_WIDE = '@max-[48rem]/table:hidden'
const N = 'text-right tabular-nums'

function RunsBoard({ f }: { f: ShotterFacts }) {
  const { sh } = f
  return (
    <TableSection
      title="Runs"
      aside={sh.runs.length === 0 ? 'none yet' : `last ${num(sh.runs.length)}, newest first`}
    >
      <ul className={TABLE}>
        <li aria-hidden="true" className={cn(RUN_GRID, TABLE_HEAD)}>
          <span>Run</span>
          <span className={RUN_WIDE}>Underneath</span>
          <span className={N}>Shots</span>
          <span className={cn(N, RUN_WIDE)}>Took</span>
          <span className={N}>When</span>
          <span className="text-right">Verdict</span>
        </li>
        {sh.runs.length === 0 && (
          <li className={TABLE_EMPTY}>
            Nothing in the ledger. <span className={MONO}>shot quick &lt;url&gt;</span> writes the
            first line.
          </li>
        )}
        {sh.runs.map((r) => (
          <ShotRunRow key={r.id} run={r} />
        ))}
      </ul>
      <p className={FOOT}>
        The append-only ledger, one line per <span className={MONO}>shot</span> invocation. The
        verdict reads the run&rsquo;s event counters, not its screenshots — events outrank pixels,
        because a page can render beautifully over a broken deploy. <b>fail</b> is the runner itself
        dying; <b>issues</b> is a page that answered with console errors, failed requests or 4xx/5xx
        underneath.
      </p>
    </TableSection>
  )
}

function ImageBuildLogsBoard() {
  return (
    <LogBoard
      source={{ unit: 'shotter-image.service' }}
      title="Image build logs"
      foot={
        <p className={FOOT}>
          The rebuild-time image build — layer cache makes the no-change case near-silent, so lines
          here mean the Playwright pin moved or a fresh box paid the base pull. The runs themselves
          do NOT log here: each run&rsquo;s log lives in its own run directory, excerpted above.
        </p>
      }
      neighbours={[
        {
          source: { unit: 'shotter-prune.service' },
          label: 'shotter-prune',
          role: 'the weekly archive trim',
          note: 'Sunday 04:20, 30 days back, at most 40 runs kept. Monitored — a failure mails the operator.',
        },
      ]}
    />
  )
}

function ShotRunRow({ run }: { run: ShotRun }) {
  const bad = issueSummary(run.counts)
  return (
    <li className={cn(RUN_GRID, TABLE_ROW)} title={run.id}>
      <span className={CELL_NAME}>{run.label === '' ? run.id : run.label}</span>
      <span className={cn(CELL_QUIET, RUN_WIDE, 'truncate', bad !== null && 'text-subdued')}>
        {bad ?? DASH}
      </span>
      <span className={cn(CELL_QUIET, N)}>{num(run.shots)}</span>
      <span className={cn(CELL_QUIET, N, RUN_WIDE)}>
        {run.durationMs === null ? DASH : ms(run.durationMs)}
      </span>
      <span className={cn(CELL_QUIET, N)}>{run.at === null ? DASH : <Ago at={run.at} />}</span>
      <span className="flex justify-end">
        {!run.ok ? (
          <Chip tone="bad">fail</Chip>
        ) : bad === null ? (
          <span className={CELL_QUIET}>clean</span>
        ) : (
          <Chip tone="warn">issues</Chip>
        )}
      </span>
    </li>
  )
}
