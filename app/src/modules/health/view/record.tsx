import { LogBoard } from '../../../components/logs'
import { Changelog } from '../../../components/release-notes'
import { ServiceHead } from '../../../components/service-head'
import { FOOT, MONO } from '../../../components/tokens'
import { Button } from '../../../components/ui/button'
import { Board, BoardGrid, Chip, Facts } from '../../../components/viz'
import { DASH } from '../../../lib/format'
import type { Tone } from '../../../lib/tone'
import type { HealthData } from '../data'
import { gapTitle, VersionAside } from './shared'

// Health › Record: getbased — labs, genome, body and history in one record —
// and the relay that keeps its copies in step across devices.

type Record_ = Extract<HealthData, { tab: 'record' }>

function buildVerdict(d: Record_): { label: string; tone: Tone } {
  if (d.build.running === null || d.build.note !== null) return { label: 'unknown', tone: 'muted' }
  const n = d.build.behind.length
  return n === 0
    ? { label: 'current', tone: 'ok' }
    : { label: `${String(n)} commits behind`, tone: 'warn' }
}

export function RecordView({ data: d }: { data: Record_ }) {
  return (
    <>
      <ServiceHead
        logo="/icon-getbased.svg"
        name="getbased"
        version={d.build.running?.slice(0, 7) ?? null}
        versionNote="a commit on upstream main"
        verdict={buildVerdict(d)}
        lede={
          <>
            Lab reports, DNA, wearables and medical history in one record, with lab PDFs read by the
            local model and reviewed before they are saved. Static files on the server: the record
            itself lives in each browser that opens it.
          </>
        }
        actions={
          <Button asChild size="sm">
            <a href={d.url} target="_blank" rel="noreferrer">
              Open getbased ↗
            </a>
          </Button>
        }
      />

      <BoardGrid>
        <Board title="Where the record lives" icon="◱" span={8}>
          <Facts
            rows={[
              { k: 'App', v: <span className={MONO}>{d.url}</span> },
              { k: 'Sync relay', v: <span className={MONO}>{d.relayUrl}</span> },
              { k: 'On the server', v: 'static files, and the relay’s ciphertext' },
              { k: 'In each browser', v: 'the whole record' },
            ]}
          />
          <p className={FOOT}>
            Every profile is kept in the browser&rsquo;s own storage, so nothing on this page can
            count, size or back it up. A device joins by naming the relay above under Settings ›
            Data › Cross-device sync and pairing with the profile&rsquo;s sync phrase; the relay
            stores only what the devices encrypted, and without that phrase its copy cannot be read.
            Between syncs, a full backup exported from Settings is the only other copy.
          </p>
        </Board>

        <Board title="Sync relay" icon="◔" span={4}>
          <Facts
            rows={[
              { k: 'Version', v: d.relay.version ?? DASH },
              {
                k: 'Latest release',
                v:
                  d.relay.gap.latest === null ? (
                    DASH
                  ) : d.relay.gap.behind.length === 0 ? (
                    <Chip tone="ok">up to date</Chip>
                  ) : (
                    <Chip tone="warn">{d.relay.gap.latest} available</Chip>
                  ),
              },
            ]}
          />
          <p className={FOOT}>
            An Evolu CRDT relay: devices push encrypted changes, and it stores and forwards what it
            cannot read. Its owner-scoped storage endpoints share the hostname under /self.
          </p>
        </Board>

        <Changelog build={d.build} span={6} title={buildTitle(d)} />
        <Changelog
          gap={d.relay.gap}
          span={6}
          title={gapTitle('Relay', d.relay.gap)}
          aside={<VersionAside version={d.relay.version} />}
        />

        <LogBoard
          source={{ container: 'getbased' }}
          title="getbased logs"
          neighbours={[
            {
              source: { container: 'getbased-relay' },
              label: 'Sync relay',
              role: 'what keeps the devices in step',
              note: 'One line per device connecting and leaving, and a warning when a write is refused for going over a storage quota. A device that will not sync shows here as a connection that closes at once, or as no connection at all.',
            },
          ]}
        />
      </BoardGrid>
    </>
  )
}

function buildTitle(d: Record_): string {
  const n = d.build.behind.length
  return n === 0 ? 'getbased — current' : `getbased — ${String(n)} commits since this build`
}
