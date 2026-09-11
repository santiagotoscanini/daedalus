import { createFileRoute } from "@tanstack/react-router";
import { Reveal } from "~/components/reveal";

/** /docs — the boundary document. A daedalus-managed machine rebuilds from
 * its config repo; this page inventories what every install still needs
 * OUTSIDE it: provider accounts, a router, two keys, and the steps that stay
 * steps. Same ledger register as the landing — hairline rows, mono labels,
 * no cards. The operator's own ledger (this box's ports, tokens, tunnels)
 * lives in the private config repo, not here. */

export const Route = createFileRoute("/docs")({
  component: DocsPage,
  head: () => ({
    meta: [
      { title: "Daedalus docs. What stays outside the repo." },
      {
        name: "description",
        content:
          "What a daedalus install still needs outside its config repo: a Cloudflare zone and tunnel, Let's Encrypt, a router that forwards only what you choose, GitHub, a mail relay, and two keys you cannot lose.",
      },
    ],
  }),
});

/* ---------------------------------------------------------------- *
 * Content
 * ---------------------------------------------------------------- */

type Tag = "re-issuable" | "keep safe" | "hand-made";

const TAG_COLOR: Record<Tag, string> = {
  "re-issuable": "#4ea87a",
  "keep safe": "#e05252",
  "hand-made": "#d9a441",
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
    title: "Keys and runners",
    blurb:
      "The repos live here; the CI does not. Builds run on the box's own runners and land in its own registry. GitHub holds the source and the keys.",
    rows: [
      {
        name: "the config repo",
        body: "Private. It holds the machine: every stack, every sops-encrypted secret, and the ledger of what's outside it. A deploy SSH key, its public half registered by hand in account settings, signs the weekly autoupgrade push.",
        tag: "re-issuable",
      },
      {
        name: "one repo per app",
        body: "Each app is a repo with a Dockerfile. A push to main builds an image on the box's runner and pushes it to the box's registry; the deploy timer picks up the digest change.",
      },
      {
        name: "runner token",
        body: "A fine-grained PAT scoped to Administration on the app repos only. The box mints one-hour registration tokens host-side; the PAT itself never enters a container. Each runner takes one job, then dies.",
        tag: "re-issuable",
      },
      {
        name: "per-repo registry secret",
        body: "Each app repo carries one Actions secret for the box's registry, set from the box itself so the value never leaves it.",
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
        body: "Images live only in the box's own registry, so every app needs one CI run before its first deploy on new hardware.",
      },
    ],
  },
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
          What stays <span className="text-gradient-ember">outside the repo.</span>
        </h1>
        <p className="mt-6 max-w-2xl text-pretty text-[16px] leading-relaxed text-muted">
          A daedalus-managed machine rebuilds from its config repo, except for these: the accounts,
          dashboards, two keys and one router that live outside git. Each is configured once, by
          hand. This page is what every install still needs.
        </p>
      </Reveal>

      {/* Jump list */}
      <Reveal delay={0.1}>
        <nav aria-label="Sections" className="mt-10 flex flex-wrap gap-x-5 gap-y-1.5">
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
            look. A port forward lives in a registry no rebuild consumes; your config repo should
            carry its own copy of this page, filled in.
          </p>
          <p className="mt-6 font-mono text-[11px] tracking-wide text-dim">
            declared where possible, written down where not
          </p>
        </div>
      </Reveal>
    </main>
  );
}
