import { LogBoard } from '../../../components/logs'
import { Changelog, VersionAside } from '../../../components/release-notes'
import { compareOf, ServiceHead, verdictOf } from '../../../components/service-head'
import { BoardGrid } from '../../../components/viz'
import type { MediaData } from '../data'
import { FOOT, MONO } from './shared'

// Media › Hardcover: the reading log. Hardcover is a service on the internet,
// so what the box runs is its MCP server, and the tab is that server's two
// versions and its log (the shape of Health › Nutrition).

type Hardcover = Extract<MediaData, { tab: 'hardcover' }>

export function HardcoverView({ d }: { d: Hardcover }) {
  return (
    <>
      <ServiceHead
        logo="/icon-hardcover.png"
        name="Hardcover MCP"
        version={d.version}
        versionNote="pinned in the stack"
        verdict={verdictOf(d.gap)}
        compare={compareOf(d.gap, 'from the build')}
        lede={
          <>
            What has been read, is being read and is wanted, with ratings and reviews, as tools a
            model calls through the gateway. Shelfmark reads the same account&rsquo;s Want to Read
            shelf and downloads what is on it.
          </>
        }
      />

      <BoardGrid>
        {/* Two projects in one image, each on its own release cycle: two
            changelogs and the one log. */}
        <Changelog
          gap={d.gap}
          span={12}
          title="hardcover-mcp"
          aside={<VersionAside version={d.version} behind={d.gap.behind.length} />}
          foot={
            <p className={FOOT}>
              Both versions are set in <span className={MONO}>stacks/hardcover-mcp</span>, and a
              bump rebuilds the image on the box. The python and node images it is built on are rows
              on System › Updates, with their own Update buttons.
            </p>
          }
        />
        <Changelog
          gap={d.supergateway.gap}
          span={12}
          title="supergateway"
          aside={
            <VersionAside
              version={d.supergateway.version}
              behind={d.supergateway.gap.behind.length}
            />
          }
        />
        <LogBoard source={{ container: 'mcp-hardcover' }} title="Hardcover MCP logs" />
      </BoardGrid>
    </>
  )
}
