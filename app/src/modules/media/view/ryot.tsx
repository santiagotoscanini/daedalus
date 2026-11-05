import { LogBoard } from '../../../components/logs'
import { Changelog, VersionAside } from '../../../components/release-notes'
import { compareOf, Open, ServiceHead, verdictOf } from '../../../components/service-head'
import { BoardGrid } from '../../../components/viz'
import type { MediaData } from '../data'
import { FOOT, MONO } from './shared'

// Media › Ryot: the record of what was watched and played, wherever it was
// watched. Its API is behind the Pocket ID gate, so the tab is the pin's
// version, its changelog, its MCP server and the logs.

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
        <Changelog
          gap={d.mcp.gap}
          span={12}
          title="Ryot MCP"
          aside={<VersionAside version={d.mcp.version} behind={d.mcp.gap.behind.length} />}
          foot={
            <p className={FOOT}>
              The tracker as tools on the LLM gateway: search, look a title up with its history, log
              a watch, rate and review, keep the Watchlist. Our own repository, built on the box
              from its clone until it is published, so a new version is a commit there and{' '}
              <span className={MONO}>nix flake update ryot-mcp</span>. It signs in once, with{' '}
              <span className={MONO}>ryot-mcp-login</span>, and renews its own session after that.
            </p>
          }
        />
        <LogBoard
          source={{ container: 'ryot' }}
          title="Ryot logs"
          neighbours={[
            {
              source: { container: 'mcp-ryot' },
              label: 'Ryot MCP',
              role: 'the tool server in front of it',
              note: 'It reaches Ryot on a private bridge, never through the gate. One line per tool call, with its outcome; auth_failed means it holds no session Ryot accepts, and ryot-mcp-login on the box fixes that.',
            },
          ]}
        />
      </BoardGrid>
    </>
  )
}
