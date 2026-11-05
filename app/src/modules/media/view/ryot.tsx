import { LogBoard } from '../../../components/logs'
import { Changelog, VersionAside } from '../../../components/release-notes'
import { compareOf, Open, ServiceHead, verdictOf } from '../../../components/service-head'
import { BoardGrid } from '../../../components/viz'
import type { MediaData } from '../data'
import { FOOT, MONO } from './shared'

// Media › Ryot: the record of what was watched and played, wherever it was
// watched. Its API is behind the Pocket ID gate, so the tab is the pin's
// version, its changelog and the log.

type Ryot = Extract<MediaData, { tab: 'ryot' }>

export function RyotView({ d }: { d: Ryot }) {
  return (
    <>
      <ServiceHead
        logo="/icon-ryot.png"
        name="Ryot"
        version={d.version}
        versionNote="pinned in the stack"
        verdict={verdictOf(d.gap)}
        compare={compareOf(d.gap, 'from the image tag')}
        lede={
          <>
            What was watched, played and read, rated and reviewed, whether it played on Jellyfin, at
            a cinema or somewhere else. Seerr gets a title into the house; Ryot keeps what was
            thought of it.
          </>
        }
        actions={<Open name="Ryot" host="ryot" />}
      />

      <BoardGrid>
        <Changelog
          gap={d.gap}
          span={12}
          title="Ryot"
          aside={<VersionAside version={d.version} behind={d.gap.behind.length} />}
          foot={
            <p className={FOOT}>
              Ryot tags its patch releases without publishing notes for them, so a version newer
              than the newest release here is a patch, usually a security fix. The pin is in{' '}
              <span className={MONO}>stacks/ryot</span>.
            </p>
          }
        />
        <LogBoard source={{ container: 'ryot' }} title="Ryot logs" />
      </BoardGrid>
    </>
  )
}
