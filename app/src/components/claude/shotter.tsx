// The Shotter tab: the box's headless-browser lab — its runs, the newest
// run's slices, and the Playwright pin under it.

import { cn } from '../../lib/cn'
import type { ClaudeData } from '../../lib/dashboard/claude'
import type { ShotRun } from '../../lib/dashboard/shotter'
import { bytes, DASH, ms, num, since } from '../../lib/format'
import { LogBoard } from '../logs'
import { Changelog } from '../release-notes'
import { ServiceHead } from '../service-head'
import { EMPTY, FOOT, LIST, MONO, MONO_FACE, NOTE, ROW, ROW_MAIN, ROW_SIDE } from '../tokens'
import { Board, BoardGrid, Chip, Stat, StatStrip } from '../viz'
import { NARROW_HIDE } from './shared'
import { issueSummary, shotterVerdict } from './verdicts'

/* The strip holds one run's viewport slices — consecutive crops of a single
   long page — so they lay out as a film row: fixed height, natural width, side
   scroll. Each image is also the link to its full-size self. */
const SHOT_STRIP = 'mt-[0.6rem] mb-[0.2rem] flex gap-2 overflow-x-auto'
const SHOT_IMG = 'block h-[150px] w-auto rounded-[6px] border border-(--border) bg-(--panel-2)'
/* An excerpt, not the artifact: it scrolls rather than grows, and keeps the
   runner's own line breaks. */
const SHOT_LOG =
  'mt-2 max-h-36 overflow-auto rounded-[6px] border border-(--border-soft) bg-(--panel-2) px-[0.6rem] py-2 text-[0.72rem] leading-[1.5] whitespace-pre-wrap text-(--text-muted)'

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
  const sh = data.shotter
  const latest = sh.latest
  const verdict = shotterVerdict(data.shotterGap)

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
          value={sh.updatedAt === null ? 'never' : since((Date.now() - sh.updatedAt) / 1000)}
          // Deliberately never a warning tone: runs happen when an agent
          // needs eyes, and a quiet week is a true reading, not staleness.
          sub="quiet is a reading"
        />
      </StatStrip>

      <BoardGrid>
        <Board
          title="Latest run"
          icon="panels"
          span={4}
          aside={
            latest === null ? undefined : <span className={cn(NOTE, MONO_FACE)}>{latest.id}</span>
          }
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
            The newest run&rsquo;s viewport slices — consecutive crops of one long page, each
            linking to its full-size self — and the runner&rsquo;s own log under them. The full
            evidence (every slice, <span className={MONO}>events.json</span>,{' '}
            <span className={MONO}>log.txt</span>) is{' '}
            <span className={MONO}>shot show &lt;id&gt;</span> on the box.
          </p>
        </Board>

        <Board
          title="Runs"
          icon="logs"
          span={8}
          aside={
            <span className={NOTE}>
              {sh.runs.length === 0 ? 'none yet' : `last ${num(sh.runs.length)}, newest first`}
            </span>
          }
        >
          {sh.runs.length === 0 ? (
            <p className={EMPTY}>
              Nothing in the ledger. <span className={MONO}>shot quick &lt;url&gt;</span> writes the
              first line.
            </p>
          ) : (
            <ul className={LIST}>
              {sh.runs.map((r) => (
                <ShotRunRow key={r.id} run={r} />
              ))}
            </ul>
          )}
          <p className={FOOT}>
            The append-only ledger, one line per <span className={MONO}>shot</span> invocation. The
            verdict chip reads the run&rsquo;s event counters, not its screenshots — events outrank
            pixels, because a page can render beautifully over a broken deploy. <b>fail</b> is the
            runner itself dying; <b>issues</b> is a page that answered with console errors, failed
            requests or 4xx/5xx underneath.
          </p>
        </Board>

        <Changelog
          gap={data.shotterGap}
          span={12}
          aside={<span className={NOTE}>microsoft/playwright</span>}
          foot={
            <p className={FOOT}>
              The one dependency under <span className={MONO}>shot</span> — Chromium arrives inside
              Playwright&rsquo;s image, so this is the whole upgrade story. Moving is a paired edit
              in <span className={MONO}>stacks/shotter/shotter.nix</span>:{' '}
              <span className={MONO}>playwrightVersion</span> and{' '}
              <span className={MONO}>playwrightDigest</span> together (Playwright refuses browsers
              from a different revision), then a rebuild rebuilds the image. {verdict.note}
            </p>
          }
        />

        <LogBoard
          source={{ unit: 'shotter-image.service' }}
          title="Image build logs"
          foot={
            <p className={FOOT}>
              The rebuild-time image build — layer cache makes the no-change case near-silent, so
              lines here mean the Playwright pin moved or a fresh box paid the base pull. The runs
              themselves do NOT log here: each run&rsquo;s log lives in its own run directory,
              excerpted above.
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
      </BoardGrid>
    </>
  )
}

function ShotRunRow({ run }: { run: ShotRun }) {
  const bad = issueSummary(run.counts)
  return (
    <li className={ROW} title={run.id}>
      <Chip tone={!run.ok ? 'bad' : bad === null ? 'ok' : 'warn'}>
        {!run.ok ? 'fail' : bad === null ? 'clean' : 'issues'}
      </Chip>
      <span className={ROW_MAIN}>{run.label === '' ? run.id : run.label}</span>
      {bad !== null && <span className={ROW_SIDE}>{bad}</span>}
      <span className={ROW_SIDE}>
        {num(run.shots)} shot{run.shots === 1 ? '' : 's'}
      </span>
      <span className={cn(ROW_SIDE, NARROW_HIDE)}>
        {run.durationMs === null ? DASH : ms(run.durationMs)}
      </span>
      <span className={ROW_SIDE}>
        {run.at === null ? DASH : since((Date.now() - run.at) / 1000)}
      </span>
    </li>
  )
}
