import { createFileRoute } from "@tanstack/react-router";
import { Reveal } from "~/components/reveal";

/** /docs — the boundary document. The repo rebuilds the machine; this page
 * inventories everything that lives OUTSIDE it: provider dashboards, one
 * plastic router, two keys, and the app state no rebuild reproduces. Same
 * ledger register as the landing — hairline rows, mono labels, no cards. */

export const Route = createFileRoute("/docs")({
  component: DocsPage,
  head: () => ({
    meta: [
      { title: "Daedalus docs. What the repo can't declare." },
      {
        name: "description",
        content:
          "The external surfaces of a self-hosted cloud: Cloudflare, the router, VPN keys, GitHub, mail and key custody. Everything configured outside the repo, and what happens if it's lost.",
      },
    ],
  }),
});

const REPO = "https://github.com/santiagotoscanini/daedalus";

/* ---------------------------------------------------------------- *
 * Content
 * ---------------------------------------------------------------- */

type Tag = "re-issuable" | "keep safe" | "hand-made" | "app state";

const TAG_COLOR: Record<Tag, string> = {
  "re-issuable": "#4ea87a",
  "keep safe": "#e05252",
  "hand-made": "#d9a441",
  "app state": "#4493f8",
};

interface Row {
  name: string;
  body: string;
  via?: string;
  tag?: Tag;
}

interface DocSection {
  id: string;
  provider: string;
  title: string;
  blurb: string;
  rows: Row[];
}

const SECTIONS: DocSection[] = [
  {
    id: "cloudflare",
    provider: "Cloudflare",
    title: "The zone and the tunnel",
    blurb:
      "All public HTTP enters through one Cloudflare Tunnel. DNS for the zone splits three ways: synced, refreshed, and strictly hand-managed. Confusing them is the classic mistake.",
    rows: [
      {
        name: "the tunnel",
        body: "Created once via the API. Cloudflare returns the tunnel secret only in the creation response, so the wizard can't be used. Ingress is locally managed from the nix-rendered config; editing it in the dashboard does nothing. The credential rides sops-encrypted in the repo, which is the whole backup.",
        via: "stacks/cloudflared",
        tag: "re-issuable",
      },
      {
        name: "synced CNAMEs",
        body: "One proxied CNAME per published app, upserted and swept on every rebuild. Any record pointing at the tunnel that isn't declared gets deleted. The repo owns this class of record; the dashboard doesn't.",
        via: "cloudflared-route-sync",
      },
      {
        name: "the dynamic A record",
        body: "The WAN hostname is a hand-created A record refreshed every five minutes. It must stay DNS-only (grey cloud): proxying it would break the raw game ports and mask the split-horizon LAN answer.",
        via: "platform/ddclient",
        tag: "hand-made",
      },
      {
        name: "the Pages CNAME",
        body: "This very page: a grey-cloud CNAME to GitHub Pages, deliberately invisible to the sync. No fleet app may take the bare hostname, or the sweep would overwrite it.",
        tag: "hand-made",
      },
      {
        name: "two API tokens",
        body: "A zone-scoped DNS-edit token that lives in three sops files (the proxy's DNS-01, the route sync, the control plane) and rotates in one pass, plus an account-scoped token for tunnel telemetry. Losing either is an outage, not data loss.",
        via: "traefik · cloudflared · daedalus",
        tag: "re-issuable",
      },
    ],
  },
  {
    id: "acme",
    provider: "Let's Encrypt",
    title: "One wildcard",
    blurb:
      "The ACME account is created implicitly on first run. One certificate covers the apex and the wildcard. Every published host is exactly one label under the domain, so no per-app cert work exists.",
    rows: [
      {
        name: "DNS-01, pinned upstream",
        body: "Challenges resolve against 1.1.1.1 directly. The LAN's own resolver can't see a fresh TXT record, and waiting on it would time every renewal out.",
        via: "stacks/traefik",
      },
      {
        name: "acme.json",
        body: "The cert store is not in any backup tree. It reissues itself from nothing, but Let's Encrypt rate-limits duplicates, so copy it aside before risky disk work.",
        tag: "re-issuable",
      },
    ],
  },
  {
    id: "router",
    provider: "The router",
    title: "Three ports",
    blurb:
      "The only hardware configuration in the system. The router itself can't be declared, so each forward is written down in the repo beside the stack that needs it, where a reader would look.",
    rows: [
      {
        name: "51820/udp → WireGuard",
        body: "The VPN into the house. Not HTTP, so it can't ride the tunnel.",
        via: "stacks/wg-easy",
        tag: "hand-made",
      },
      {
        name: "34197/udp → Factorio",
        body: "The game protocol, straight through.",
        via: "stacks/factorio",
        tag: "hand-made",
      },
      {
        name: "25565/tcp → Minecraft",
        body: "A custom binary protocol with no TLS: no SNI for a proxy to route on, and no tunnel client inside a game launcher.",
        via: "stacks/minecraft",
        tag: "hand-made",
      },
      {
        name: "DHCP: off",
        body: "The DNS server is also the LAN's DHCP server, so the router's must be off. The box itself boots on a static IP, since there'd be nobody to lease from that early.",
        via: "stacks/pihole",
      },
      {
        name: "everything else: closed",
        body: "SSH, HTTP, DNS and the database are LAN-only. Port scans from the internet die at the router; public traffic exists only inside the tunnel.",
      },
    ],
  },
  {
    id: "vpn",
    provider: "ProtonVPN",
    title: "Two tunnels out",
    blurb:
      "Two separate WireGuard configs: one key cannot run two live sessions, and the traffic must not mix.",
    rows: [
      {
        name: "downloads egress",
        body: "Port forwarding enabled; the forwarded port is pushed into the torrent client automatically on every reconnect.",
        via: "stacks/downloads",
        tag: "re-issuable",
      },
      {
        name: "probe egress",
        body: "No port forwarding, fail-closed kill switch. If the tunnel drops, the probes stop rather than leak the house IP.",
        via: "stacks/argus-vpn",
        tag: "re-issuable",
      },
      {
        name: "the export moment",
        body: "The private key is shown once, at export, and never again. The sops-encrypted copy in the repo is the only backup. Expiry is handled declaratively: each tunnel mails a reminder 30 and 7 days out.",
      },
    ],
  },
  {
    id: "github",
    provider: "GitHub",
    title: "Keys and runners",
    blurb:
      "The repos live here; the CI does not. Builds run on the box's own runners and land in its own registry. GitHub holds the source, the keys and this page.",
    rows: [
      {
        name: "deploy SSH key",
        body: "The public half is registered by hand in account settings. It signs the weekly flake autoupgrade push and the workspace sync.",
        via: "platform/git",
        tag: "re-issuable",
      },
      {
        name: "runner token",
        body: "A fine-grained PAT scoped to Administration on the app repos only. The box mints one-hour registration tokens host-side; the PAT itself never enters a container. Each runner takes one job, then dies.",
        via: "stacks/gha-runner",
        tag: "re-issuable",
      },
      {
        name: "Pages",
        body: "The landing you're reading. Built by Actions, custom domain set once in the repo's Pages settings, paired with the hand-managed CNAME above.",
        via: ".github/workflows/website.yml",
        tag: "hand-made",
      },
      {
        name: "per-repo registry secret",
        body: "Each app repo carries one Actions secret for the box's registry, set from the box itself so the value never leaves it.",
        via: "daedalus › apps",
      },
    ],
  },
  {
    id: "mail",
    provider: "Gmail",
    title: "The alert channel",
    blurb:
      "Every alert, disk failure and dead-man ping emails through one SMTP app password. Five services share the single copy. None duplicates it.",
    rows: [
      {
        name: "one app password",
        body: "Two-factor on, app password issued once. Consumed by the system sendmail, the dashboards, the automation engine, the dead-man switch and the issue tracker.",
        via: "platform/mail",
        tag: "re-issuable",
      },
      {
        name: "the honest footnote",
        body: "The box resolves DNS through itself, so an alert about the resolver being down cannot leave the box. Known and accepted.",
      },
    ],
  },
  {
    id: "custody",
    provider: "Custody",
    title: "The two keys",
    blurb:
      "Everything above is re-issuable. Nothing in this section is.",
    rows: [
      {
        name: "the age key",
        body: "Every secret in the repo decrypts for exactly two identities: the box's SSH host key, and the operator's personal age key, whose password-manager copy is the recovery of last resort. Lose both and the repo's secrets are ciphertext forever; every provider relationship above gets rebuilt by hand.",
        via: ".sops.yaml",
        tag: "keep safe",
      },
      {
        name: "passkeys",
        body: "The identity provider's first boot is interactive: an admin account and a passkey, registered once. The passkeys on your devices are the credential; the last resort is a one-time token minted from a shell on the box.",
        via: "stacks/pocket-id",
        tag: "keep safe",
      },
      {
        name: "the encryption key",
        body: "One environment variable encrypts the identity provider's signing keys at rest. Set it once and treat it as fixed. Rotating it means re-encrypting everything it protects.",
        via: "stacks/pocket-id",
        tag: "keep safe",
      },
    ],
  },
  {
    id: "gpu",
    provider: "The GPU box",
    title: "A second machine",
    blurb:
      "Chat, embeddings, speech and image generation come from a model server on the gaming PC, a machine this repo does not manage.",
    rows: [
      {
        name: "the model server",
        body: "Started by hand, addressed by a static DNS entry, unauthenticated on the LAN. Every model the gateway advertises is a promise about what's been downloaded onto that box. Models are state there, not declarations here.",
        via: "stacks/litellm",
        tag: "hand-made",
      },
    ],
  },
  {
    id: "app-state",
    provider: "In the apps",
    title: "State the rebuild won't reproduce",
    blurb:
      "Some services are configured in their own UI, on purpose, because that's their discoverable surface. A fresh bootstrap replays none of it, so it's listed here rather than pretended away.",
    rows: [
      {
        name: "indexers & providers",
        body: "The indexer accounts and the usenet provider live only in their apps' settings screens.",
        via: "prowlarr · nzbget",
        tag: "app state",
      },
      {
        name: "upstream wiring",
        body: "The request app's three upstreams are entered in its UI, not declared.",
        via: "seerr",
        tag: "app state",
      },
      {
        name: "UI-minted tokens",
        body: "Dashboard service accounts and per-app API keys are created in each app and pasted into sops. Rotate them at the source.",
        via: "grafana · jellyfin · immich · nextcloud · grocy",
        tag: "app state",
      },
      {
        name: "the resolver's own list",
        body: "Blocklists and custom entries added in the DNS UI live in a database that is not in any backup tree. Anything meant to survive goes through the declared registry instead.",
        via: "pihole › gravity.db",
        tag: "app state",
      },
      {
        name: "dead-man periods",
        body: "Checks self-provision on first ping with wrong defaults, so each one's period and grace get set by hand, once.",
        via: "healthchecks",
        tag: "app state",
      },
    ],
  },
  {
    id: "manual",
    provider: "Still manual",
    title: "The steps that stay steps",
    blurb: "Four moves no rebuild makes for you. Each is one command or one click, if you know it exists.",
    rows: [
      {
        name: "after rotating a secret",
        body: "A rebuild alone is the false success: rendered copies keep serving the old value. Restart the render unit and its consumer, by hand, every time.",
      },
      {
        name: "after importing a fresh pool",
        body: "Child datasets are not auto-created. Each one is a one-time create. The repo lists every child; the pool doesn't.",
      },
      {
        name: "after losing the box",
        body: "Images live only in the box's own registry, so every app needs one CI run before its first deploy on new hardware.",
      },
      {
        name: "after a major version bump",
        body: "Some upgrades want their own chores. The file-sync app's occ commands are the standing example. The stack's header comment is the runbook.",
      },
    ],
  },
];

const RUNBOOKS = [
  { name: "operations.md", desc: "the daily loop, upgrades" },
  { name: "secrets.md", desc: "the two secret classes, rotation" },
  { name: "adding-a-stack.md", desc: "a new service, end to end" },
  { name: "recovery.md", desc: "clone + one key → the machine" },
];

/* ---------------------------------------------------------------- *
 * Page
 * ---------------------------------------------------------------- */

function DocsPage() {
  return (
    <main id="main" className="mx-auto max-w-4xl px-6 pb-32 pt-40">
      <Reveal>
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-2">
          External setup
        </p>
        <h1 className="mt-4 text-balance text-4xl font-semibold tracking-[-0.02em] sm:text-[3.25rem] sm:leading-[1.05]">
          What the repo <span className="text-gradient-ember">can't declare.</span>
        </h1>
        <p className="mt-6 max-w-2xl text-pretty text-[16px] leading-relaxed text-muted">
          Any checkout rebuilds the machine, except for these: the accounts, dashboards, two keys
          and one plastic router that live outside git. Each is configured once, by hand. This page
          is where the repo remembers them.
        </p>
      </Reveal>

      {/* The repo runbooks — the operational docs live in-tree */}
      <Reveal delay={0.06}>
        <div className="mt-10 flex flex-wrap gap-x-6 gap-y-2 border-y border-hairline py-4">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-dim">
            In-repo runbooks
          </span>
          {RUNBOOKS.map((r) => (
            <a
              key={r.name}
              href={`${REPO}/blob/main/docs/${r.name}`}
              className="group font-mono text-[12px] text-muted transition-colors hover:text-fg"
            >
              {r.name}
              <span className="ml-2 hidden text-dim sm:inline">{r.desc}</span>
            </a>
          ))}
        </div>
      </Reveal>

      {/* Jump list */}
      <Reveal delay={0.1}>
        <nav aria-label="Sections" className="mt-6 flex flex-wrap gap-x-5 gap-y-1.5">
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className="font-mono text-[11px] uppercase tracking-[0.14em] text-dim transition-colors hover:text-accent"
            >
              {s.provider}
            </a>
          ))}
        </nav>
      </Reveal>

      {/* The ledger */}
      <div className="mt-20 flex flex-col gap-20">
        {SECTIONS.map((s) => (
          <section key={s.id} id={s.id} className="scroll-mt-28">
            <Reveal>
              <div className="flex items-baseline gap-4">
                <h2 className="font-mono text-[13px] uppercase tracking-[0.16em] text-accent">
                  {s.provider}
                </h2>
                <span className="h-px flex-1 bg-hairline" aria-hidden />
              </div>
              <h3 className="mt-4 text-balance text-[1.6rem] font-semibold tracking-[-0.02em]">
                {s.title}
              </h3>
              <p className="mt-3 max-w-2xl text-pretty text-[14.5px] leading-relaxed text-muted">
                {s.blurb}
              </p>
            </Reveal>

            <div className="mt-8">
              {s.rows.map((row) => (
                <Reveal key={row.name}>
                  <div className="grid gap-2 border-t border-hairline py-5 sm:grid-cols-[13rem_1fr] sm:gap-8">
                    <div>
                      <p className="font-mono text-[13px] text-fg">{row.name}</p>
                      {row.tag ? (
                        <span
                          className="mt-2 inline-flex rounded-full border px-2 py-px font-mono text-[9.5px] uppercase tracking-[0.1em]"
                          style={{
                            color: TAG_COLOR[row.tag],
                            borderColor: `${TAG_COLOR[row.tag]}59`,
                          }}
                        >
                          {row.tag}
                        </span>
                      ) : null}
                    </div>
                    <div>
                      <p className="text-pretty text-[14px] leading-relaxed text-fg/85">
                        {row.body}
                      </p>
                      {row.via ? (
                        <p className="mt-2 font-mono text-[11px] text-dim">↳ {row.via}</p>
                      ) : null}
                    </div>
                  </div>
                </Reveal>
              ))}
            </div>
          </section>
        ))}
      </div>

      {/* Closing */}
      <Reveal>
        <div className="mt-24 border-t border-line-2 pt-8">
          <p className="max-w-2xl text-pretty text-[14.5px] leading-relaxed text-muted">
            The pattern, if you're building your own: when something can't be declared, declare
            <em> that it exists</em> — beside the stack that needs it, in the place a reader would
            look. The three port forwards live in a registry no rebuild consumes; this page exists
            for the same reason.
          </p>
          <p className="mt-6 font-mono text-[11px] tracking-wide text-dim">
            declared where possible, written down where not
          </p>
        </div>
      </Reveal>
    </main>
  );
}
