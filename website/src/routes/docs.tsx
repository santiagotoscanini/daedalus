import { createFileRoute } from "@tanstack/react-router";
import { pageHead } from "~/site-head";

/** /docs — the boundary document. A daedalus-managed machine rebuilds from
 * its config repo; this page inventories what every install still needs
 * OUTSIDE it: provider accounts, a router, two keys, and the steps that stay
 * steps. Same register as the landing's ledger: hairline rows, sans labels,
 * no cards, on the landing's column. The operator's own ledger (this box's
 * ports, tokens, tunnels) lives in the private config repo, not here. */

export const Route = createFileRoute("/docs")({
  component: DocsPage,
  head: () =>
    pageHead({
      path: "/docs",
      title: "daedalus docs: what stays outside the repo",
      description:
        "What a daedalus install still needs outside its config repo: a Cloudflare zone and tunnel, a router, GitHub, a mail relay, and two keys you cannot lose.",
    }),
});

/* ---------------------------------------------------------------- *
 * Content
 * ---------------------------------------------------------------- */

type Tag = "re-issuable" | "keep safe" | "hand-made";

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
      "One zone, one API token, one tunnel. All public HTTP enters through the tunnel. DNS for the zone splits two ways: records the repo syncs, and records you manage by hand. Confusing them is the classic mistake.",
    rows: [
      {
        name: "the zone",
        body: "A domain on Cloudflare. Every published app is exactly one label under it, so one wildcard certificate covers the fleet and no per-app DNS work exists.",
        tag: "hand-made",
      },
      {
        name: "the tunnel",
        body: "Created once via the API. Cloudflare returns the tunnel secret only in the creation response, so the dashboard wizard can't be used. Ingress is locally managed from the rendered config; editing it in the dashboard does nothing. The credential rides sops-encrypted in the config repo, which is the whole backup.",
        tag: "re-issuable",
      },
      {
        name: "synced CNAMEs",
        body: "One proxied CNAME per published app, upserted and swept on every rebuild. Any record pointing at the tunnel that isn't declared gets deleted. The repo owns this class of record; the dashboard doesn't.",
      },
      {
        name: "hand-made records",
        body: "Anything you point elsewhere yourself: a dynamic A record for a raw game port, a CNAME for a static site. Keep them DNS-only (grey cloud) and on a hostname no app declares, or the sweep will overwrite them and the proxy will swallow the port.",
        tag: "hand-made",
      },
      {
        name: "the API token",
        body: "One token for everything Cloudflare on the box. Zone › Zone › Read and Zone › DNS › Edit cover the proxy's DNS-01, the route sync, the dynamic address and the control plane's domain picker; Account › Cloudflare One Connector: cloudflared › Read covers its tunnel panels. Include all zones and a domain added later shows up without touching the token. Stored once, so rotating it is one edit. Losing it is an outage, not data loss.",
        tag: "re-issuable",
      },
    ],
  },
  {
    id: "acme",
    provider: "Let's Encrypt",
    title: "One wildcard",
    blurb:
      "The ACME account is created implicitly on first run. One certificate covers the apex and the wildcard, issued over DNS-01 with the token above.",
    rows: [
      {
        name: "DNS-01, pinned upstream",
        body: "Challenges resolve against 1.1.1.1 directly. The LAN's own resolver can't see a fresh TXT record, and waiting on it would time every renewal out.",
      },
      {
        name: "the cert store",
        body: "Not in any backup tree. It reissues itself from nothing, but Let's Encrypt rate-limits duplicates, so copy it aside before risky disk work.",
        tag: "re-issuable",
      },
    ],
  },
  {
    id: "router",
    provider: "The router",
    title: "Forward nothing you didn't choose",
    blurb:
      "The only hardware configuration in the system. Public HTTP arrives through the tunnel, so 80 and 443 are never forwarded. The router can't be declared, so each forward you do make is written down in the repo beside the stack that needs it, where a reader would look.",
    rows: [
      {
        name: "what gets forwarded",
        body: "Only protocols that can't ride the tunnel: a WireGuard endpoint, a game server. No TLS means no SNI for a proxy to route on, and no tunnel client inside a game launcher.",
        tag: "hand-made",
      },
      {
        name: "DHCP: off",
        body: "The box's DNS server is also the LAN's DHCP server, so the router's must be off. The box itself boots on a static IP, since there'd be nobody to lease from that early.",
      },
      {
        name: "everything else: closed",
        body: "SSH, HTTP, DNS and the database are LAN-only. Port scans from the internet die at the router; public traffic exists only inside the tunnel.",
      },
    ],
  },
  {
    id: "github",
    provider: "GitHub",
    title: "Keys and builds",
    blurb:
      "The repos live here; the builds do not. A push wakes the box, which builds the image itself and lands it in its own registry. GitHub holds the source and the keys.",
    rows: [
      {
        name: "the config repo",
        body: "Private. It holds the machine: every stack, every sops-encrypted secret, and the ledger of what's outside it. A deploy SSH key, its public half registered by hand in account settings, authenticates the weekly autoupgrade push.",
        tag: "re-issuable",
      },
      {
        name: "one repo per app",
        body: "Each app is a repo. A push to main reaches the box as a webhook, which builds the image on its own hardware (Railpack, unless the repo has a Dockerfile and no railpack.json) and pushes it to the box's registry, then starts the app's deploy.",
      },
      {
        name: "the box's own GitHub App",
        body: "Created and installed from the control plane. Its private key is sealed into the config repo and stays host-side; the container only ever sees a one-hour installation token, scoped to reading contents and Actions runs and writing checks and deployments.",
        tag: "re-issuable",
      },
      {
        name: "Pages",
        body: "This site. Built by Actions, custom domain set once in the repo's Pages settings, paired with a hand-made grey-cloud CNAME in the zone.",
        via: ".github/workflows/website.yml",
        tag: "hand-made",
      },
    ],
  },
  {
    id: "mail",
    provider: "Mail",
    title: "The alert channel",
    blurb:
      "Every alert, disk failure and dead-man ping emails through one SMTP relay. One app password, one encrypted copy, shared by every consumer. None duplicates it.",
    rows: [
      {
        name: "one app password",
        body: "Two-factor on, app password issued once. Consumed by the system sendmail, the dashboards, the dead-man switch and anything else that needs to reach you.",
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
      "Everything above is re-issuable: lose it and you have an outage. The two keys here are not. Lose either and no rebuild, snapshot or provider dashboard brings it back.",
    rows: [
      {
        name: "the age recovery key",
        body: "Every secret in the config repo decrypts for exactly two identities: the box's SSH host key, and your personal age key, whose password-manager copy is the recovery of last resort. Lose both and the repo's secrets are ciphertext forever; every provider relationship above gets rebuilt by hand.",
        tag: "keep safe",
      },
      {
        name: "the identity provider's encryption key",
        body: "One environment variable encrypts the identity provider's signing keys at rest. Set it once and treat it as fixed. Rotating it means re-encrypting everything it protects; losing it means every session and every app registration starts over.",
        tag: "keep safe",
      },
      {
        name: "passkeys",
        body: "The identity provider's first boot is interactive: an admin account and a passkey, registered once. The passkeys on your devices are the credential; the last resort is a one-time token minted from a shell on the box.",
        tag: "keep safe",
      },
    ],
  },
  {
    id: "manual",
    provider: "Still manual",
    title: "The steps that stay steps",
    blurb: "Three moves no rebuild makes for you. Each is one command, if you know it exists.",
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
        body: "Images live only in the box's own registry, so every app needs one build before its first deploy on new hardware.",
      },
    ],
  },
];

/* ---------------------------------------------------------------- *
 * Page
 * ---------------------------------------------------------------- */

/** The custody tags carry no colour: colour on this site is for live state. "keep safe" is the one
 * that costs data when ignored, so it takes the body emphasis (weight 500, one ink brighter). */
function TagChip({ tag }: { tag: Tag }) {
  return (
    <span
      className={`t-small mt-2 inline-flex h-6 items-center rounded-chip border border-edge-2 px-2 ${
        tag === "keep safe" ? "font-medium text-ink-2" : ""
      }`}
    >
      {tag}
    </span>
  );
}

function DocsPage() {
  return (
    <main id="main" className="wrap pb-32 pt-28 lg:pt-40">
      <div className="max-w-[792px]">
        <p className="t-small text-ink-4">External setup</p>
        <h1 className="t-display mt-4">What stays outside the repo.</h1>
        <p className="t-lead mt-6 max-w-[690px]">
          A daedalus-managed machine rebuilds from its config repo, except for these: the accounts,
          dashboards, two keys and one router that live outside git. Each is configured once, by
          hand. This page is what every install still needs.
        </p>

        {/* Jump list */}
        <nav aria-label="Sections" className="mt-10 flex flex-wrap gap-x-5 gap-y-2">
          {SECTIONS.map((s) => (
            <a key={s.id} href={`#${s.id}`} className="t-small link">
              {s.provider}
            </a>
          ))}
        </nav>

        {/* The ledger */}
        <div className="mt-24 flex flex-col gap-24">
          {SECTIONS.map((s) => (
            <section key={s.id} id={s.id}>
              <div className="flex items-baseline gap-4">
                <h2 className="t-small text-ink-4">{s.provider}</h2>
                <span className="h-px flex-1 bg-edge-1" aria-hidden />
              </div>
              <h3 className="t-title-l mt-4">{s.title}</h3>
              <p className="t-body mt-3 max-w-[690px]">{s.blurb}</p>

              <div className="mt-8">
                {s.rows.map((row) => (
                  <div
                    key={row.name}
                    className="grid gap-2 border-t border-edge-1 py-5 sm:grid-cols-[13rem_1fr] sm:gap-8"
                  >
                    <div>
                      <p className="t-body font-medium text-ink-1">{row.name}</p>
                      {row.tag ? <TagChip tag={row.tag} /> : null}
                    </div>
                    <div>
                      <p className="t-body text-ink-2">{row.body}</p>
                      {row.via ? <p className="t-mono-s mt-2">{row.via}</p> : null}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>

        {/* Closing */}
        <div className="mt-24 border-t border-edge-3 pt-8">
          <p className="t-body max-w-[690px]">
            The pattern, if you're building your own: when something can't be declared, declare
            <em> that it exists</em> — beside the stack that needs it, in the place a reader would
            look. A port forward lives in a registry no rebuild consumes; your config repo should
            carry its own copy of this page, filled in.
          </p>
          <p className="t-small mt-6 text-ink-4">declared where possible, written down where not</p>
        </div>
      </div>
    </main>
  );
}
