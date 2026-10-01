// Wanted › Recyclarr: the quality profiles it syncs into the *arrs.

import { LogBoard } from '../../../../components/logs'
import { Changelog } from '../../../../components/release-notes'
import { compareOf, ServiceHead, SOURCE_NOTE, verdictOf } from '../../../../components/service-head'
import { Board, BoardGrid, Chip, Measures } from '../../../../components/viz'
import { cn } from '../../../../lib/cn'
import { DASH, num } from '../../../../lib/format'
import { CHECK_ROW, EMPTY, FOOT, LIST, MONO, NOTE, VERSION_SNAPSHOT } from '../shared'
import type { Wanted } from './shared'

export function RecyclarrPage({ d }: { d: Wanted['recyclarr'] }) {
  const recyclarr = d

  return (
    <>
      <ServiceHead
        logo="/icon-recyclarr.svg"
        name="Recyclarr"
        version={recyclarr.running.version}
        versionNote={SOURCE_NOTE[recyclarr.running.source]}
        verdict={verdictOf(recyclarr.gap)}
        compare={compareOf(
          recyclarr.gap,
          recyclarr.running.revision === null
            ? 'the image’s OCI label, since the pin is a bare major'
            : `the image’s OCI label, built from ${recyclarr.running.revision}`,
        )}
        lede={
          <>
            Syncs the TRaSH Guides into Sonarr and Radarr every night: custom formats, their scores,
            and the quality-definition sizes. When a profile changes back after you edited it by
            hand, this is what did it.
          </>
        }
        actions={
          recyclarr.lastRun === null ? (
            <Chip tone="muted">no run recorded</Chip>
          ) : (
            <Chip tone={recyclarr.lastRun.ok ? 'ok' : 'bad'}>
              {recyclarr.lastRun.ok ? 'last run ok' : 'last run failed'}
            </Chip>
          )
        }
      />

      <BoardGrid>
        <Board
          title="Last sync"
          icon="⟳"
          span={8}
          aside={<span className={NOTE}>{recyclarr.lastRun?.day ?? DASH}</span>}
        >
          {recyclarr.synced.length === 0 ? (
            <p className={EMPTY}>no sync recorded in the window</p>
          ) : (
            <ul className={`${LIST} gap-[0.3rem]`}>
              {recyclarr.synced.map((s) => (
                <li key={s.instance} className={CHECK_ROW}>
                  <span className="text-[0.72rem] uppercase tracking-[0.04em] text-muted-foreground">
                    {s.instance}
                  </span>
                  <span className="min-w-0 text-foreground">
                    {s.updated === 0 ? (
                      'nothing changed'
                    ) : (
                      <strong>
                        {num(s.updated)} custom format{s.updated === 1 ? '' : 's'} updated
                      </strong>
                    )}
                    {' · '}
                    {num(s.skipped)} already current
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className={FOOT}>
            The last run&rsquo;s numbers, not a total: a nightly job that changed two formats every
            night for a week did not change fourteen. Read out of its log, because Recyclarr has no
            API, no metrics and no interface.
          </p>
        </Board>

        <Board title="Health" icon="warn" span={4}>
          <Measures
            items={[
              {
                k: `Errors, last ${String(d.days)} days`,
                v: num(recyclarr.errors),
                tone: (recyclarr.errors ?? 0) > 0 ? 'warn' : undefined,
              },
            ]}
          />
          <p className={FOOT}>
            It runs once a day and exits. There is no process to probe between runs, so the only
            evidence it is working is the line its cron wrapper writes when it finishes.
          </p>
        </Board>

        <Changelog
          gap={recyclarr.gap}
          span={12}
          aside={
            recyclarr.running.revision === null ? (
              <span className={NOTE}>recyclarr/recyclarr</span>
            ) : (
              <span className={cn(NOTE, MONO)}>{recyclarr.running.revision}</span>
            )
          }
          foot={
            <p className={FOOT}>
              Recyclarr is pinned to a bare major (<span className={MONO}>:8</span>), which is a
              channel rather than a version. It prints no banner, exposes no API and logs nothing
              about itself. This page used to say its version could not be established. It can: the
              image records it, along with the commit it was built from.
            </p>
          }
        />

        <LogBoard
          source={{ container: 'recyclarr' }}
          title="Recyclarr logs"
          neighbours={[VERSION_SNAPSHOT]}
        />
      </BoardGrid>
    </>
  )
}
