import { Link } from '@tanstack/react-router'
import { type ReactNode, useState } from 'react'

import type { NodeApp } from '../../lib/agent/status'
import type { NodeSystemData } from '../../lib/dashboard/node-system'
import { bytes, DASH, num } from '../../lib/format'
import { GHOST_BTN } from '../apps/shared'
import { Button } from '../ui/button'
import { Board, BoardGrid, Chip, Facts } from '../viz'
import {
  ago,
  DetailNote,
  EMPTY,
  FOOT,
  LIST,
  MONO,
  NOTE,
  ROW,
  ROW_MAIN,
  ROW_SIDE,
  WipBoard,
} from './shared'

/* ── Software / Apps ──────────────────────────────────────────────────── */

/**
 * What is installed, sorted the way the machine's owner thinks about it.
 *
 * The same inventory reads differently on the two machines. On the PC it
 * is games, the launchers that own them, the drivers and vendor tools
 * around the hardware, the runtimes games load, and then everything else
 * — the groups a person uninstalls by. On the Mac there are no drivers to
 * speak of and games are rare; what matters is WHERE an app came from,
 * because that is what updates it: the App Store, Homebrew, Setapp, or a
 * download that only updates itself.
 *
 * The full list is long on purpose. An inventory that hides entries is
 * not one; each group folds past its own limit (AppList's `fold`), and
 * unfolds.
 */
export function NodeSoftwareView({ d }: { d: NodeSystemData }) {
  const t = d.telemetry
  if (t === null) return null
  const mac = d.node.os === 'macos'
  const apps = t.apps.flatMap(tidy)
  const none = t.appCount === null

  if (none) {
    return (
      <BoardGrid>
        <Board title={mac ? 'Apps' : 'Software'} icon="⧉" span={12}>
          <p className={EMPTY}>
            {!d.full
              ? 'The inventory is on the full document.'
              : 'The software inventory arrives with agent 0.10.0; the agent installs it on its own within ten minutes of the release, or now from Host.'}
          </p>
          <DetailNote d={d} />
        </Board>
      </BoardGrid>
    )
  }

  return mac ? <MacApps d={d} apps={apps} /> : <WindowsSoftware d={d} apps={apps} />
}

function WindowsSoftware({ d, apps }: { d: NodeSystemData; apps: NodeApp[] }) {
  const t = d.telemetry
  const games = apps.filter((a) => a.kind === 'game')
  const launchers = apps.filter((a) => a.kind === 'launcher')
  const drivers = apps.filter((a) => a.kind === 'driver')
  const runtimes = apps.filter((a) => a.kind === 'runtime')
  const store = apps.filter((a) => a.kind === 'app' && a.source === 'store')
  const rest = apps.filter((a) => a.kind === 'app' && a.source !== 'store')
  const gameBytes = games.reduce((s, g) => s + (g.sizeBytes ?? 0), 0)

  return (
    <BoardGrid>
      <Board
        title={games.length === 0 ? 'Games' : `${num(games.length)} games`}
        icon="◆"
        span={4}
        aside={gameBytes > 0 ? <span className={NOTE}>{bytes(gameBytes)}</span> : undefined}
      >
        <AppList
          apps={[...games].sort(bySize)}
          empty="No game is registered with Windows. Steam and Epic register each install; a game from elsewhere may not."
          side={(a) => (a.sizeBytes === null ? sourceName(a.source) : bytes(a.sizeBytes))}
          fold={12}
        />
        <p className={FOOT}>
          Biggest first, as Steam and Epic register them. The size is what the installer wrote down,
          which is the install, not the downloads since.
        </p>
      </Board>

      <Board
        title={launchers.length === 0 ? 'Launchers' : `${num(launchers.length)} launchers`}
        icon="▷"
        span={4}
      >
        <AppList apps={launchers} empty="No game launcher is installed." side={version} />
        <p className={FOOT}>
          The stores that own the games above and update them; each keeps itself current.
        </p>
      </Board>

      <Board
        title={drivers.length === 0 ? 'Drivers & tools' : `${num(drivers.length)} drivers & tools`}
        icon="⚙"
        span={4}
      >
        <AppList apps={drivers} empty="No vendor driver package is registered." side={version} />
        <p className={FOOT}>
          The vendor packages around the hardware — the graphics driver&rsquo;s own software, audio,
          chipset, peripherals. The graphics driver by its vendor name is on{' '}
          <Link
            to="/c/$category"
            params={{ category: 'system' }}
            search={{ tab: 'graphics', machine: d.node.id }}
          >
            Graphics
          </Link>
          .
        </p>
      </Board>

      <Board
        title={runtimes.length === 0 ? 'Runtimes' : `${num(runtimes.length)} runtimes`}
        icon="⧉"
        span={6}
      >
        <AppList
          apps={[...runtimes].sort(byName)}
          empty="No redistributable runtime is registered."
          side={version}
        />
        <p className={FOOT}>
          Visual C++ and .NET redistributables, Vulkan, Java, WebView2: the libraries programs and
          games load rather than ship. Several versions side by side is how Windows works; nothing
          here is redundant just because it is old.
        </p>
      </Board>

      <Board
        title={store.length === 0 ? 'From the Store' : `${num(store.length)} from the Store`}
        icon="⊞"
        span={6}
      >
        <AppList
          apps={store}
          empty="Nothing from the Microsoft Store beyond Windows’ own."
          side={version}
        />
        <p className={FOOT}>
          Store packages, Windows&rsquo; own furniture left out — of Microsoft&rsquo;s only Xbox,
          Minecraft, PowerToys, Terminal, Teams and Office count as chosen. The Store updates these
          on its own, which is why Arc&rsquo;s version here moves without anyone installing
          anything.
        </p>
      </Board>

      <Board
        title={rest.length === 0 ? 'Programs' : `${num(rest.length)} programs`}
        icon="▣"
        span={12}
        aside={<span className={NOTE}>{num(t?.appCount ?? apps.length)} registered in all</span>}
      >
        <AppList
          apps={[...rest].sort(byName)}
          empty="Nothing else is registered."
          side={(a) =>
            [
              a.version === null ? null : a.version,
              a.publisher,
              a.installedAt === null ? null : ago(a.installedAt),
            ]
              .filter((x): x is string => x !== null)
              .join(' · ')
          }
          fold={16}
        />
        <DetailNote d={d} />
        <p className={FOOT}>
          Everything in Programs and Features that is not a game, a launcher, a driver or a runtime,
          from the registry&rsquo;s uninstall keys — the machine&rsquo;s and the signed-in
          user&rsquo;s. Read every ten minutes; a portable program in a folder registers nothing and
          is not seen.
        </p>
      </Board>
    </BoardGrid>
  )
}

function MacApps({ d, apps }: { d: NodeSystemData; apps: NodeApp[] }) {
  const t = d.telemetry
  const appStore = apps.filter((a) => a.source === 'app-store')
  const brew = apps.filter((a) => a.source === 'homebrew')
  const setapp = apps.filter((a) => a.source === 'setapp')
  const apple = apps.filter((a) => a.source === 'apple')
  const loose = apps.filter(
    (a) => !['app-store', 'homebrew', 'setapp', 'apple'].includes(a.source ?? ''),
  )

  return (
    <BoardGrid>
      <Board
        title={appStore.length === 0 ? 'App Store' : `${num(appStore.length)} from the App Store`}
        icon="◎"
        span={4}
      >
        <AppList
          apps={[...appStore].sort(byName)}
          empty="Nothing from the App Store."
          side={version}
        />
        <p className={FOOT}>
          Apps with a Store receipt. The App Store updates these on its own, or on the next visit.
        </p>
      </Board>

      <Board
        title={brew.length === 0 ? 'Homebrew' : `${num(brew.length)} from Homebrew`}
        icon="⌂"
        span={4}
      >
        <AppList apps={[...brew].sort(byName)} empty="No cask is installed." side={version} />
        <p className={FOOT}>
          Casks: apps Homebrew put in the Applications folder. Moved by{' '}
          <span className={MONO}>brew upgrade</span>, never on their own.
        </p>
      </Board>

      <Board
        title={
          loose.length + setapp.length === 0
            ? 'Downloaded'
            : `${num(loose.length + setapp.length)} downloaded`
        }
        icon="⇣"
        span={4}
      >
        <AppList
          apps={[...loose, ...setapp].sort(byName)}
          empty="Nothing dragged into the Applications folder."
          side={(a) =>
            a.source === 'setapp'
              ? `Setapp${a.version === null ? '' : ` · ${a.version}`}`
              : version(a)
          }
        />
        <p className={FOOT}>
          Dragged in from a download, or Setapp&rsquo;s. Each updates itself, or does not; Setapp
          keeps its own current.
        </p>
      </Board>

      {/* brew(1) refuses to run as root, and the daemon is root; the tray
          runs as the person and could ask it, and does not yet. */}
      <WipBoard
        title="Homebrew formulae"
        icon="⌂"
        span={12}
        waits="Homebrew refuses root and the agent’s daemon is root; the tray, which runs as the person, can ask it next — then this lists the formulae and which are outdated."
      >
        <Facts
          rows={[
            { k: 'Formulae', v: '84 installed · 6 outdated' },
            { k: 'Casks', v: `${num(Math.max(brew.length, 1))} installed · 1 outdated` },
            { k: 'brew', v: '5.0.3, updated 2 days ago' },
          ]}
        />
      </WipBoard>

      {apple.length > 0 && (
        <Board title={`${num(apple.length)} of Apple’s`} icon="⌘" span={12}>
          <AppList apps={[...apple].sort(byName)} empty="" side={version} fold={12} />
          <p className={FOOT}>
            Apple&rsquo;s own apps that live in the Applications folder rather than inside the
            system; they move with macOS or through the App Store.
          </p>
        </Board>
      )}
      <DetailNote d={d} />
      <p className={FOOT}>
        {num(t?.appCount ?? apps.length)} apps in all, from the Applications folder, one level of
        subfolders, and the signed-in user&rsquo;s own; read every ten minutes.
      </p>
    </BoardGrid>
  )
}

function AppList({
  apps,
  empty,
  side,
  fold = 40,
}: {
  apps: NodeApp[]
  empty: string
  side: (a: NodeApp) => ReactNode
  /** Past this many, the rest wait behind a button. */
  fold?: number
}) {
  const [open, setOpen] = useState(false)
  if (apps.length === 0) return <p className={EMPTY}>{empty}</p>
  const shown = open ? apps : apps.slice(0, fold)
  return (
    <>
      <ul className={LIST}>
        {shown.map((a) => (
          <li key={`${a.name}-${a.version ?? ''}-${a.source ?? ''}`} className={ROW}>
            <span className={ROW_MAIN}>{a.name}</span>
            <span className={ROW_SIDE}>{side(a)}</span>
          </li>
        ))}
      </ul>
      {apps.length > fold && (
        <div className="mt-[0.5rem] flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={GHOST_BTN}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Fewer' : `All ${num(apps.length)}`}
          </Button>
          {!open && <Chip tone="muted">{num(apps.length - fold)} more</Chip>}
        </div>
      )}
    </>
  )
}

// Store packages Windows registers beside the Xbox app — its overlays and
// sign-in helper — are parts of it, not things anyone launches.
const XBOX_PARTS =
  /^Xbox(\.TCUI|GameOverlay|GamingOverlay|IdentityProvider|SpeechToTextOverlay|GameCallableUI)$/i
const LAUNCHERS =
  /^(Battle\.net|Steam|Epic Games Launcher|GOG GALAXY|Ubisoft Connect|EA app|Riot Client|Xbox|GamingApp)$/i
// Of Microsoft's own Store packages, the ones a person chose to have.
// The rest — Cortana's package id, the Bing tiles, the codec extensions,
// Get Help — is Windows furniture, and a list of it says nothing.
const MICROSOFT_KEEP =
  /^(Xbox|GamingApp|Minecraft\w*|PowerToys|Windows ?Terminal|Teams|MicrosoftTeams|Office\w*|OneNote|Copilot)$/i

/**
 * The agent's classification, corrected where a name fooled it: Battle.net
 * is a launcher whatever ".net" suggests, the Store's "GamingApp" is the
 * Xbox app, the Xbox app's own helper packages are not apps at all, and
 * Microsoft's own Store packages are kept only where they are apps.
 */
function tidy(a: NodeApp): NodeApp[] {
  if (XBOX_PARTS.test(a.name)) return []
  if (
    a.source === 'store' &&
    /microsoft/i.test(a.publisher ?? '') &&
    !MICROSOFT_KEEP.test(a.name)
  ) {
    return []
  }
  const name = a.name === 'GamingApp' ? 'Xbox' : a.name
  const kind = LAUNCHERS.test(name) ? 'launcher' : a.kind
  return [name === a.name && kind === a.kind ? a : { ...a, name, kind }]
}

const version = (a: NodeApp): ReactNode =>
  a.version === null ? DASH : <span className={MONO}>{a.version}</span>

function sourceName(s: string | null): string {
  return s === 'steam' ? 'Steam' : s === 'epic' ? 'Epic' : s === 'store' ? 'Store' : DASH
}

function byName(a: NodeApp, b: NodeApp): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
}

function bySize(a: NodeApp, b: NodeApp): number {
  return (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1) || byName(a, b)
}
