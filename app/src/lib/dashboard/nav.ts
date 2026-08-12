// The category rail.
//
// Kept out of server/category.ts deliberately: the sidebar renders this on
// every page, and importing it from the server module would drag that module
// (and the shape of everything it imports) into the browser bundle for the
// sake of five labels.
//
// No icon on the spec: the rail draws one per `id` (components/nav-icon.tsx),
// and naming it here as well was the same fact written twice.

/**
 * The categories, and the only list of them.
 *
 * It lived in the tile catalogue until that catalogue emptied: every service
 * on this box now has a TAB, so a directory of cards restating three of its
 * numbers one scroll below its own page had nothing left to hold. The last
 * five were Grafana, Loki, Prometheus, Gatus and Healthchecks — which is the
 * Monitoring tab row exactly.
 */
export type CategoryName = 'ai' | 'media' | 'home' | 'gaming' | 'network' | 'system' | 'monitoring'

export type CategorySpec = {
  id: CategoryName
  label: string
  lede: string
  /**
   * Empty when the category has no sub-tabs.
   *
   * `probe` is a gatus endpoint name — the tab wears its subject's status as
   * a dot, so a category of several servers answers "which of these is up"
   * from the tab row, without visiting each one. It is on the TAB rather than
   * inside the page for exactly that reason: a status you have to navigate to
   * is a status you check one at a time.
   *
   * Omitted means there is nothing probing that tab's subject, which is not
   * the same claim as "down" and is drawn grey. Dots appear only in a
   * category where at least one tab declares one — Media's TV/Books split is
   * a view of one library, not two services, and would sprout two permanently
   * grey dots for nothing.
   */
  tabs: {
    id: string
    label: string
    probe?: string
    /**
     * Several probes that must ALL be green, for a tab whose subject is more
     * than one service.
     *
     * The Gateway tab is the case: traefik routes and Pocket ID authorises,
     * and either one down means requests are not getting where they were
     * going. Picking one of the two to represent the pair would draw a green
     * dot over a broken half. Unknown on any of them makes the whole thing
     * unknown — a partial answer to "is this working" is not an answer.
     */
    probes?: string[]
    /**
     * This tab's own opening shape, when it differs from the category's.
     *
     * The category-level `boardSpans` are the DEFAULT tab's, so a sibling that
     * opens differently reflows on arrival. `statBand: false` is the sharper
     * case: a placeholder for four stat cards that never come is not a
     * mis-sized skeleton, it is a promise the page then breaks.
     */
    boardSpans?: number[]
    statBand?: boolean
    /**
     * Draw a rule before this tab.
     *
     * For a category whose tabs answer two different KINDS of question. Media
     * is the case: Jellyfin and Calibre are where a pipeline ends — the
     * libraries a person opens — and everything after the rule is machinery
     * that fills them. Without it the two read as the first two stages of the
     * chain rather than as its destination.
     */
    dividerBefore?: boolean
    /**
     * Whether this tab opens with a `ServiceHead`. Default true.
     *
     * Almost every tab on this dashboard does: its subject is a service, so it
     * gets artwork, the name, the version running, the verdict on whether that
     * version is current, and the link you came to click. The exceptions are
     * the tabs whose subject is not a service at all — the System layers, and
     * Network's General, which is the wire.
     *
     * Declared here rather than left implicit in the view, because the
     * SKELETON has to know it before the data exists. A page that streams a
     * header in above a grid that was already drawn pushes the whole grid down
     * at the moment you have started reading it.
     */
    head?: boolean
    /**
     * A COMPUTED status, for a tab gatus cannot probe.
     *
     * `probe` covers anything that answers HTTP. A VPN egress tunnel answers
     * nothing — it is a network namespace — so its health has to be assembled
     * from what prometheus knows about it, and from the registry that says how
     * many tunnels there should be. A symbol rather than a query string
     * because that assembly needs the registry, which lives on the server;
     * this file is imported into the browser bundle for five labels and must
     * stay data.
     */
    health?: 'vpn-egress' | 'uplink' | 'log-pipeline'
  }[]
  /**
   * Column spans of this page's boards, for the skeleton that stands in while
   * they load.
   *
   * Duplicated from the view component on purpose, and the duplication is the
   * cheap half of the trade: the placeholder has to know the shape before the
   * data exists, and a uniform grid of six would visibly reflow into an 8+4 on
   * every page here. Only the first few matter — the fold is around four
   * boards — so this is not a mirror of the whole layout, just its opening.
   */
  boardSpans: number[]
}

export const CATEGORIES: CategorySpec[] = [
  {
    id: 'ai',
    label: 'AI',
    lede: 'The local model server, the gateway in front of it, and what is driving traffic through it.',
    // Shaped to Lemonade, the tab that opens by default: the model list and
    // the release notes side by side, then the logs across the bottom.
    boardSpans: [6, 6, 12],
    // No tile directory. It held one tile per service, and each of those is
    // now a tab on this page — the same name, dot, description and link, one
    // scroll further down.
    // A tab per service, in the order a prompt travels: the thing that holds
    // the weights, the gateway in front of it, then the two callers. Lemonade
    // leads because it is the one that is off this box and the one whose state
    // (what is resident, is the card full) actually changes hour to hour.
    tabs: [
      { id: 'lemonade', label: 'Lemonade', probe: 'lemonade' },
      // The one tab here with no headline band: its numbers live inside the
      // panel whose chart they describe.
      // Traffic + the tool list, then who is calling + the changelog. Paired
      // by height rather than by subject — see the note on that board.
      {
        id: 'litellm',
        label: 'LiteLLM',
        probe: 'litellm',
        boardSpans: [8, 4, 4, 8],
        statBand: false,
      },
      // What it can reach + who gets in, then the changelog across.
      {
        id: 'open-webui',
        label: 'Open WebUI',
        probe: 'open-webui',
        boardSpans: [6, 6, 12],
        statBand: false,
      },
      // Runs + the workflows behind them, same 8/4 pairing as the gateway.
      { id: 'n8n', label: 'n8n', probe: 'n8n', boardSpans: [8, 4, 12], statBand: false },
    ],
  },
  {
    id: 'media',
    label: 'Media',
    lede: 'Two libraries, and the chain that fills them — with what each service says about itself.',
    // Shaped to Jellyfin, the tab that opens by default.
    boardSpans: [8, 4, 4, 8],
    // No tile directory. It held eleven tiles, each three numbers and a link,
    // and every one of those services is now a tab with a page — the same name,
    // dot and link, plus the version verdict, the health checks and the log a
    // tile had no room for.
    // Split by what a thing IS, and the rule is the split: the two tabs to its
    // left are where a pipeline ENDS — the libraries a person actually opens —
    // and everything to its right is machinery that fills them.
    //
    // Four of these hold more than one service, picked by a switch inside the
    // page — the same shape Network uses for its three ways in. The grouping
    // follows the job rather than the software: Recyclarr sits with the two
    // *arrs whose configuration it writes, Bazarr with the other fetchers, and
    // Shelfmark with the other downloaders rather than beside the shelf it
    // fills, so "why has this not arrived" is answered in one place whether or
    // not the thing is a book.
    //
    // `probes` on those tabs rather than `probe`: every service behind the
    // switch has to be green, because picking one to represent the group would
    // draw a green dot over a broken half. Unknown on any makes the whole thing
    // unknown, which is the honest answer to a partial reading.
    tabs: [
      {
        id: 'jellyfin',
        label: 'Jellyfin',
        probe: 'jellyfin',
        boardSpans: [8, 4, 4, 8],
        statBand: false,
      },
      {
        id: 'calibre',
        label: 'Calibre',
        probe: 'calibre-web',
        boardSpans: [8, 4, 12],
        statBand: false,
      },
      // Past the rule: everything that fills the two libraries above.
      {
        id: 'wanted',
        label: 'Wanted',
        probes: ['seerr', 'sonarr', 'radarr', 'bazarr'],
        boardSpans: [8, 4, 4, 8],
        statBand: false,
        dividerBefore: true,
      },
      {
        id: 'indexer',
        label: 'Indexer',
        probe: 'prowlarr',
        boardSpans: [12, 12, 12],
        statBand: false,
      },
      {
        id: 'downloaders',
        label: 'Downloaders',
        probes: ['qbittorrent', 'nzbget', 'metube', 'shelfmark'],
        boardSpans: [8, 4, 4, 8],
        statBand: false,
      },
      // Only Cleanuparr answers HTTP; Janitorr is a timer with nothing to
      // probe, and carries its health inside on the switch instead.
      {
        id: 'cleanup',
        label: 'Cleanup',
        probe: 'cleanuparr',
        boardSpans: [8, 4, 12],
        statBand: false,
      },
    ],
  },
  {
    id: 'home',
    label: 'Home',
    lede: 'The household’s own things — what the house shares, and what one person keeps here.',
    // Shaped to the House tab, which opens by default.
    boardSpans: [8, 4, 4, 8],
    // No tile directory. It held eight tiles, and the two biggest data stores
    // on this box got four numbers and a link each — no version, no verdict on
    // whether that version is current, and no log. Every one of them is a tab
    // now, carrying the same name, dot and link.
    // The rule divides WHOSE data it is. To its left, what the whole house
    // shares: the automation, the photo library, the file sync, the pantry,
    // and the directory of who can open any of them. To its right, what one
    // person keeps here. It is the only axis on which Wealthfolio and
    // Nextcloud differ — every other reading of "home" puts them together.
    //
    // Sign-in sits last on the shared side rather than first: it is the
    // household's list of people, but it is the answer to a question you ask
    // about the others, not one you open the category to see.
    tabs: [
      {
        id: 'house',
        label: 'House',
        probe: 'home-assistant',
        boardSpans: [8, 4, 4, 8],
        statBand: false,
      },
      { id: 'photos', label: 'Photos', probe: 'immich', boardSpans: [8, 4, 4, 8], statBand: false },
      {
        id: 'files',
        label: 'Files',
        probe: 'nextcloud',
        boardSpans: [8, 4, 4, 4],
        statBand: false,
      },
      { id: 'pantry', label: 'Pantry', probe: 'grocy', boardSpans: [8, 4, 12], statBand: false },
      // Pocket ID, which had a category of its own until now — see the note in
      // components/category/idp.tsx for why it stopped deserving one.
      {
        id: 'signin',
        label: 'Sign-in',
        probe: 'pocket-id',
        boardSpans: [6, 6, 3, 9],
        statBand: false,
      },
      // Past the rule: one person's, not the household's.
      {
        id: 'projects',
        label: 'Projects',
        probe: 'plane',
        boardSpans: [6, 6, 12],
        statBand: false,
        dividerBefore: true,
      },
      {
        id: 'finance',
        label: 'Finance',
        probe: 'wealthfolio',
        boardSpans: [12, 12, 12],
        statBand: false,
      },
      {
        id: 'tools',
        label: 'Tools',
        probe: 'stirling-pdf',
        boardSpans: [12, 12, 12],
        statBand: false,
      },
    ],
  },
  {
    id: 'gaming',
    label: 'Gaming',
    lede: 'The game servers: which build each one runs, and whether the people on the sofa can still join.',
    boardSpans: [6, 6, 12],
    tabs: [
      // ofsm answering is the closest thing to a PROBE this server has: the
      // game itself speaks UDP straight to a forwarded port and nothing on
      // this box can ask it a question. Whether the game process is actually
      // up is answered on the page instead, from its own log — the manager's
      // UI keeps answering this dot while the game inside it is shut down.
      { id: 'factorio', label: 'Factorio', probe: 'factorio-admin' },
      // Still no probe, but for the opposite reason to Factorio's: a probe is
      // a webApp answering HTTP, and Minecraft publishes no HTTP at all. It
      // answers the question better than a dot could anyway — the page reads
      // the game's own status ping, which is the game replying rather than a
      // container existing.
      { id: 'minecraft', label: 'Minecraft' },
    ],
  },
  {
    id: 'network',
    label: 'Network',
    lede: 'Everything between a packet and this box — the link, the ways in, the proxy, the resolver.',
    boardSpans: [12, 12, 8, 4],
    // No tiles on any tab here. The nine that used to sit under General were
    // each a service already given a whole tab, restating three of its numbers
    // one screen below the panel that explains them, plus four bare links —
    // and every one of those links now lives on the tab whose subject it is.
    // Split by DIRECTION, because that is the only axis on which these two
    // are alike: both are WireGuard, both are tunnels, and everything else
    // about them is opposite. One lets a phone reach the house from a hotel;
    // the other stops the house being recognised from outside. Keeping them
    // as two boards on one page meant the words "VPN", "WireGuard" and
    // "tunnel" each meant two things a scroll apart.
    tabs: [
      // The wire itself, and everyone using it: what crosses the cable, what
      // the line behind it can carry, and which container moved which bytes.
      //
      // No gatus probe, because there is no one service here to check — but
      // the tab is not therefore unknowable. The two things that would make
      // this page meaningless are the router being unreachable and the
      // internet being down, and both are measured every minute, so the dot
      // is computed from them instead of left permanently grey.
      // The one tab in this category with no service head: its subject is the
      // cable, which has no version and nothing to open.
      {
        id: 'general',
        label: 'General',
        boardSpans: [8, 4, 4, 8],
        statBand: false,
        head: false,
        health: 'uplink',
      },
      // Three ways in — WireGuard, the Cloudflare tunnel, and the address
      // itself — chosen by a switch inside the page. The probe is wg-easy's
      // because it is the only one of the three gatus can check.
      {
        id: 'wireguard',
        label: 'Coming in',
        probe: 'wg-easy',
        boardSpans: [8, 4, 12],
        statBand: false,
      },
      // What happens to a request once it has arrived. Pocket ID shared this
      // tab and is its own category now: the routing table still borrows the
      // IdP's client list to say which routes are gated, but that is one
      // column, and a column is not a reason for a second service's header
      // and release notes to sit behind a switch on a page about routing.
      {
        id: 'proxy',
        label: 'Proxy',
        probe: 'traefik-dashboard',
        boardSpans: [12, 8, 4],
        statBand: false,
      },
      // How a name becomes an address, on both sides of the front door: the
      // resolver every device in the house asks, and the zone the internet
      // asks. One tab because the interesting facts are the ones where the
      // two disagree — and because the registration underneath them is the
      // single expiry date every hostname, certificate and redirect URI on
      // this box hangs off. The probe is pi-hole's; nothing gatus can reach
      // says anything about a zone at Cloudflare.
      {
        id: 'dns',
        label: 'DNS',
        probe: 'pihole',
        boardSpans: [8, 4, 8, 4],
        statBand: false,
      },
      // The other server inside the same process, and a separate tab because
      // sharing FTL is a fact about the software rather than about the
      // subject: one page answers what a name points at, this one answers
      // which device holds which address. Same probe — there is one process
      // to be up — and the same reason it can answer at all, which is that
      // everything in the house resolves through this box.
      {
        id: 'dhcp',
        label: 'DHCP',
        probe: 'pihole',
        boardSpans: [6, 6, 12],
        statBand: false,
      },
      // No gatus probe: it checks HTTP endpoints, and a VPN egress tunnel
      // answers nothing — it is a network namespace. Its dot is computed from
      // every declared tunnel's state and its containers instead.
      {
        id: 'outbound',
        label: 'Going out',
        health: 'vpn-egress',
        boardSpans: [8, 4, 12],
        statBand: false,
      },
    ],
  },
  // No Security category. It held exactly one tab — Pocket ID — and the
  // argument that gave it one was an argument against living on Network: an
  // IdP is not infrastructure with a release cycle, it is the account every
  // person in the house signs in with. True, and it does not make it a
  // subject of its own. Beside the automation, the photos and the files it is
  // plainly one of the household's things, so it is Home › Sign-in now.
  {
    id: 'system',
    label: 'System',
    lede: 'The machine itself: what it is running on, what it is storing, and what survives it.',
    // Shaped to Host, the tab that opens by default.
    boardSpans: [8, 4, 4, 4],
    // No dots anywhere on this row. Every other category's tabs are services,
    // and gatus probes services; these are layers of one machine, and the page
    // you are reading is running on it. A row of permanently grey circles
    // would be eight claims that nothing is being checked, which is false —
    // the checking is on the page.
    //
    // The rule separates the state of the machine NOW from what outlives it.
    // Everything left of it is gone the moment the box is; Backups is the only
    // tab here answering a question about tomorrow.
    //
    // `head: false` on all but one, and it is the same argument as the dots:
    // these are layers of a machine, and a header saying "version 6.12.93,
    // current, Open ↗" is a claim about a service that is not there. Database
    // is the exception and a real one — a tab whose subject is postgres, which
    // has a version, a release cycle and security fixes in its minors like any
    // other service here.
    tabs: [
      { id: 'host', label: 'Host', boardSpans: [8, 4, 4, 4], statBand: false, head: false },
      { id: 'memory', label: 'Memory', boardSpans: [8, 4, 4, 8], statBand: false, head: false },
      // Physical, then logical. SMART and throughput belong to a device;
      // capacity and snapshots belong to a pool, and one page holding both
      // was the same paragraph answering two questions.
      // Three thirds and a footer: one board per drive in this box, which is
      // the count the skeleton has to guess at because the disks are data.
      { id: 'disks', label: 'Disks', boardSpans: [4, 4, 4, 12], statBand: false, head: false },
      { id: 'pools', label: 'Pools', boardSpans: [6, 6, 12], statBand: false, head: false },
      // The parts, as opposed to the layers. Every other tab in this row
      // answers "how is it behaving"; this one answers "what is it", which is
      // the question you cannot look up when you are in front of the open
      // case with a screwdriver. Four thirds and a wide row — the components
      // are peers, so none of them gets to be the big panel.
      { id: 'build', label: 'Build', boardSpans: [4, 4, 4, 12], statBand: false, head: false },
      { id: 'database', label: 'Database', boardSpans: [8, 4, 12], statBand: false },
      {
        id: 'backups',
        label: 'Backups',
        boardSpans: [8, 4, 8, 4],
        statBand: false,
        head: false,
        dividerBefore: true,
      },
    ],
  },
  {
    id: 'monitoring',
    label: 'Monitoring',
    lede: 'The watchers — and whether each of them would still tell you.',
    // Shaped to Alerts, the tab that opens by default.
    boardSpans: [8, 4, 4, 8],
    // No tile directory. Its five tiles were Grafana, Loki, Prometheus, Gatus
    // and Healthchecks — which is this tab row exactly, one scroll further
    // down and with three numbers each instead of a page.
    // A tab per watcher, because they fail SEPARATELY. Grafana evaluates rules
    // and knows nothing about whether prometheus is scraping; prometheus
    // scrapes and knows nothing about whether Loki is ingesting; gatus probes
    // from outside and knows nothing about either. What they share is that
    // when one stops, the rest keep looking fine.
    //
    // Probed like any other service — these are containers with hostnames, so
    // unlike System the dots here are real. Alerts wears Grafana's.
    //
    // And read like any other service, which they were not: these five are
    // five pinned images with five release cycles, and the pages carried a log
    // and nothing else — no artwork, no version, no verdict, no notes. The
    // monitoring stack was the one part of this box whose own upgrades were
    // invisible from the dashboard that watches everything else's.
    tabs: [
      {
        id: 'alerts',
        label: 'Alerts',
        probe: 'grafana',
        boardSpans: [8, 4, 4, 8],
        statBand: false,
      },
      { id: 'probes', label: 'Probes', probe: 'gatus', boardSpans: [8, 4, 4, 12], statBand: false },
      {
        id: 'metrics',
        label: 'Metrics',
        probe: 'prometheus',
        boardSpans: [8, 4, 8, 4],
        statBand: false,
      },
      // Loki publishes no gatus endpoint — it is reached over the monitoring
      // bridge and has no published hostname to probe from outside. That left
      // this the one tab in the row wearing a permanent grey dot, which read
      // as "nothing is checking the logs" beside four green ones; the truth
      // was that the check exists and the dot could not see it. Prometheus
      // scrapes both halves of the pipeline over that same bridge, so the
      // status is assembled from `up` instead of published for the sake of
      // being probed — a hostname for Loki would be new ingress bought to
      // colour a circle.
      {
        id: 'logs',
        label: 'Logs',
        health: 'log-pipeline',
        boardSpans: [8, 4, 4, 8],
        statBand: false,
      },
      { id: 'jobs', label: 'Jobs', probe: 'healthchecks', boardSpans: [8, 4, 12], statBand: false },
    ],
  },
]

/**
 * Resolve a requested sub-tab against what a category actually declares:
 * the tab if it exists, the category's first tab otherwise. Lives beside
 * CATEGORIES because both the route loader and the server functions need
 * the SAME answer — two copies of this rule is how a URL renders one tab
 * while the server loads another.
 */
export function resolveTab(category: string, tab: string | undefined): string {
  const spec = CATEGORIES.find((c) => c.id === category)
  if (spec === undefined) return ''
  return tab !== undefined && spec.tabs.some((t) => t.id === tab) ? tab : (spec.tabs[0]?.id ?? '')
}
