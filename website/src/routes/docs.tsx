import { createFileRoute } from "@tanstack/react-router";
import { pageHead } from "~/site-head";

/** /docs: the setup notes. The landing's Start section links its three steps here: how a house
 * sets up the box (#box), joins its other computers (#computers) and asks for an app (#ask), the
 * only place on the site that shows commands. Below them, the boundary document: a daedalus-managed machine
 * rebuilds from its config repo, and the rest of the page inventories what every install still
 * needs OUTSIDE it: provider accounts, a router, two keys, and the steps that stay steps.
 * Hairline rows, sans labels, no cards, no eyebrows or pills, on the landing's column. The
 * operator's own ledger (this box's ports, tokens, tunnels) lives in the private config repo. */

export const Route = createFileRoute("/docs")({
  component: DocsPage,
  head: () =>
    pageHead({
      path: "/docs",
      title: "daedalus docs: the setup notes",
      description:
        "How to set up a daedalus box and add a house’s other computers, and what an install still needs outside its config repo: a Cloudflare zone and tunnel, a router, GitHub, a mail relay, and two keys you cannot lose.",
    }),
});

/* ---------------------------------------------------------------- *
 * Content
 * ---------------------------------------------------------------- */

type Tag = "re-issuable" | "keep safe" | "hand-made";

interface Row {
  name: string;
  body: string;
  /** a command, one line per entry, shown as typed */
  code?: string[];
  via?: string;
  tag?: Tag;
}

interface DocSection {
  id: string;
  /** the jump list's name for it */
  short: string;
  title: string;
  blurb: string;
  rows: Row[];
}

const SECTIONS: DocSection[] = [
  {
    id: "box",
    short: "Set up the box",
    title: "Set up the box",
    blurb:
      "The box is one computer running NixOS, and everything it runs is written down in a git repository of your own, which takes daedalus as an input. Once it is set up, the box rebuilds itself from that repository.",
    rows: [
      {
        name: "Install NixOS",
        body: "Install NixOS from https://nixos.org/download, then turn on flakes in /etc/nixos/configuration.nix and switch once.",
        code: ['nix.settings.experimental-features = [ "nix-command" "flakes" ];'],
      },
      {
        name: "Start from the template",
        body: "On the computer that will be the box, make an empty folder for the repository and fill it from daedalus’s template.",
        code: ["nix flake init -t github:santiagotoscanini/daedalus#config"],
      },
      {
        name: "Replace the documentation values",
        body: "Every value in the template is a stand-in: example.org, a user called alice, documentation addresses, all-zero image pins and placeholder secrets. Replace each one with your own (the files say which), and swap in this machine’s own hardware-configuration.nix.",
      },
      {
        name: "Create the secrets",
        body: "Write .sops.yaml with two recipients: the box, from its SSH host key, so it can decrypt at activation, and your own age key, so a clone of the repository and that key are the whole recovery path. Then create each placeholder secret with sops. host/sops/README.md lists every file and its format. Keep the age key safe: it is the recovery path.",
        code: ["ssh-to-age < /etc/ssh/ssh_host_ed25519_key.pub"],
      },
      {
        name: "Switch",
        body: "Build the machine from the repository and make it the running system. The template’s host is called box.",
        code: ["sudo nixos-rebuild switch --flake .#box"],
      },
    ],
  },
  {
    id: "computers",
    short: "Add a computer",
    title: "Add a computer",
    blurb:
      "Every other computer in the house joins the box with the daedalus app: a small service, with a menu bar or tray app beside it. Install it as the person whose Claude Code should run on that machine.",
    rows: [
      {
        name: "A Mac",
        body: "macOS 13 or newer. Download the disk image (Download for Mac on the home page, or daedalus-agent-macos.dmg from the newest release), drag Daedalus Agent into Applications and open it. One administrator prompt says what it installs and for whom.",
      },
      {
        name: "Windows",
        body: "From an administrator PowerShell. It installs the service and the tray, and starts them. Nothing opens in the firewall.",
        code: ["Set-ExecutionPolicy -Scope Process Bypass -Force", "irm https://daedalus.toscanini.me/install.ps1 | iex"],
      },
      {
        name: "Linux",
        body: "systemd 240 or newer, on x86_64 or aarch64, from a terminal. It checks every file against the release’s signed manifest where the machine’s openssl can. A NixOS machine is configured through nix instead.",
        code: ["curl -fsSL https://daedalus.toscanini.me/install.sh | sudo sh"],
      },
      {
        name: "Approve it on the box",
        body: "A Mac logs in: Log in… in its menu bar opens the box’s page in your browser, where you sign in and confirm it. Windows and Linux pair with the key the box shows in Settings › Machines. The installer asks for it at its end, or Pair with the box… in the tray takes it later. The machine then waits until you approve it on that page, once you have compared the fingerprints both sides show.",
      },
    ],
  },
  {
    id: "ask",
    short: "Ask for an app",
    title: "Ask for an app",
    blurb:
      "Today you ask through Claude Code, which runs on the box. It comes with a Claude plan, from $17 a month (Pro, billed yearly). Talking to the house itself, without a coding agent, is next.",
    rows: [
      {
        name: "Sign Claude Code in",
        body: "On the box, sign Claude Code in once. Its remote session then starts by itself, and you pick the box from the Claude app on your phone.",
      },
      {
        name: "Apps for iPhone",
        body: "An iPhone app also needs Apple’s developer account, $99 a year. For now it is built on GitHub’s Macs and reaches the family through TestFlight. Building it on a Mac in your house is next.",
      },
    ],
  },
  {
    id: "cloudflare",
    short: "Cloudflare",
    title: "Cloudflare’s zone and tunnel",
    blurb:
      "One zone, one API token, one tunnel. All public HTTP enters through the tunnel. DNS for the zone splits two ways: records the repo syncs, and records you manage by hand. Confusing them is the classic mistake.",
    rows: [
      {
        name: "The zone",
        body: "A domain on Cloudflare. Every published app is exactly one label under it, so one wildcard certificate covers the fleet and no per-app DNS work exists.",
        tag: "hand-made",
      },
      {
        name: "The tunnel",
        body: "Created once via the API. Cloudflare returns the tunnel secret only in the creation response, so the dashboard wizard can’t be used. Ingress is locally managed from the rendered config; editing it in the dashboard does nothing. The credential rides sops-encrypted in the config repo, which is the whole backup.",
        tag: "re-issuable",
      },
      {
        name: "Synced CNAMEs",
        body: "One proxied CNAME per published app, upserted and swept on every rebuild. Any record pointing at the tunnel that isn’t declared gets deleted. The repo owns this class of record; the dashboard doesn’t.",
      },
      {
        name: "Hand-made records",
        body: "Anything you point elsewhere yourself: a dynamic A record for a raw game port, a CNAME for a static site. Keep them DNS-only (grey cloud) and on a hostname no app declares, or the sweep will overwrite them and the proxy will swallow the port.",
        tag: "hand-made",
      },
      {
        name: "The API token",
        body: "One token for everything Cloudflare on the box. Zone › Zone › Read and Zone › DNS › Edit cover the proxy’s DNS-01, the route sync, the dynamic address and the control plane’s domain picker; Account › Cloudflare One Connector: cloudflared › Read covers its tunnel panels. Include all zones and a domain added later shows up without touching the token. Stored once, so rotating it is one edit. Losing it is an outage, not data loss.",
        tag: "re-issuable",
      },
    ],
  },
  {
    id: "acme",
    short: "Let’s Encrypt",
    title: "One wildcard certificate",
    blurb:
      "The ACME account is created implicitly on first run. One certificate covers the apex and the wildcard, issued over DNS-01 with the token above.",
    rows: [
      {
        name: "DNS-01, pinned upstream",
        body: "Challenges resolve against 1.1.1.1 directly. The LAN’s own resolver can’t see a fresh TXT record, and waiting on it would time every renewal out.",
      },
      {
        name: "The cert store",
        body: "Not in any backup tree. It reissues itself from nothing, but Let’s Encrypt rate-limits duplicates, so copy it aside before risky disk work.",
        tag: "re-issuable",
      },
    ],
  },
  {
    id: "router",
    short: "The router",
    title: "Forward nothing you didn’t choose",
    blurb:
      "The only hardware configuration in the system. Public HTTP arrives through the tunnel, so 80 and 443 are never forwarded. The router can’t be declared, so each forward you do make is written down in the repo beside the stack that needs it, where a reader would look.",
    rows: [
      {
        name: "What gets forwarded",
        body: "Only protocols that can’t ride the tunnel: a WireGuard endpoint, a game server. No TLS means no SNI for a proxy to route on, and no tunnel client inside a game launcher.",
        tag: "hand-made",
      },
      {
        name: "DHCP: off",
        body: "The box’s DNS server is also the LAN’s DHCP server, so the router’s must be off. The box itself boots on a static IP, since there’d be nobody to lease from that early.",
      },
      {
        name: "Everything else: closed",
        body: "SSH, HTTP, DNS and the database are LAN-only. Port scans from the internet die at the router; public traffic exists only inside the tunnel.",
      },
    ],
  },
  {
    id: "github",
    short: "GitHub",
    title: "Keys and builds on GitHub",
    blurb:
      "The repos live here; the builds do not. A push wakes the box, which builds the image itself and lands it in its own registry. GitHub holds the source and the keys.",
    rows: [
      {
        name: "The config repo",
        body: "Private. It holds the machine: every stack, every sops-encrypted secret, and the ledger of what’s outside it. A deploy SSH key, its public half registered by hand in account settings, authenticates the weekly autoupgrade push.",
        tag: "re-issuable",
      },
      {
        name: "One repo per app",
        body: "Each app is a repo. A push to main reaches the box as a webhook, which builds the image on its own hardware (Railpack, unless the repo has a Dockerfile and no railpack.json) and pushes it to the box’s registry, then starts the app’s deploy.",
      },
      {
        name: "The box’s own GitHub App",
        body: "Created and installed from the control plane. Its private key is sealed into the config repo and stays host-side; the container only ever sees a one-hour installation token, scoped to reading contents and Actions runs and writing checks and deployments.",
        tag: "re-issuable",
      },
      {
        name: "Pages",
        body: "This site. Built by Actions, custom domain set once in the repo’s Pages settings, paired with a hand-made grey-cloud CNAME in the zone.",
        via: ".github/workflows/website.yml",
        tag: "hand-made",
      },
    ],
  },
  {
    id: "mail",
    short: "Mail",
    title: "The alert channel",
    blurb:
      "Every alert, disk failure and dead-man ping emails through one SMTP relay. One app password, one encrypted copy, shared by every consumer. None duplicates it.",
    rows: [
      {
        name: "One app password",
        body: "Two-factor on, app password issued once. Consumed by the system sendmail, the dashboards, the dead-man switch and anything else that needs to reach you.",
        tag: "re-issuable",
      },
      {
        name: "The honest footnote",
        body: "The box resolves DNS through itself, so an alert about the resolver being down cannot leave the box. Known and accepted.",
      },
    ],
  },
  {
    id: "custody",
    short: "Custody",
    title: "The two keys",
    blurb:
      "Everything above is re-issuable: lose it and you have an outage. The two keys here are not. Lose either and no rebuild, snapshot or provider dashboard brings it back.",
    rows: [
      {
        name: "The age recovery key",
        body: "Every secret in the config repo decrypts for exactly two identities: the box’s SSH host key, and your personal age key, whose password-manager copy is the recovery of last resort. Lose both and the repo’s secrets are ciphertext forever; every provider relationship above gets rebuilt by hand.",
        tag: "keep safe",
      },
      {
        name: "The identity provider’s encryption key",
        body: "One environment variable encrypts the identity provider’s signing keys at rest. Set it once and treat it as fixed. Rotating it means re-encrypting everything it protects; losing it means every session and every app registration starts over.",
        tag: "keep safe",
      },
      {
        name: "Passkeys",
        body: "The identity provider’s first boot is interactive: an admin account and a passkey, registered once. The passkeys on your devices are the credential; the last resort is a one-time token minted from a shell on the box.",
        tag: "keep safe",
      },
    ],
  },
  {
    id: "manual",
    short: "Still manual",
    title: "The steps that stay steps",
    blurb: "Three moves no rebuild makes for you. Each is one command, if you know it exists.",
    rows: [
      {
        name: "After rotating a secret",
        body: "A rebuild alone is the false success: rendered copies keep serving the old value. Restart the render unit and its consumer, by hand, every time.",
      },
      {
        name: "After importing a fresh pool",
        body: "Child datasets are not auto-created. Each one is a one-time create. The repo lists every child; the pool doesn’t.",
      },
      {
        name: "After losing the box",
        body: "Images live only in the box’s own registry, so every app needs one build before its first deploy on new hardware.",
      },
    ],
  },
];

/* ---------------------------------------------------------------- *
 * Page
 * ---------------------------------------------------------------- */

/** The custody tag, as plain small type under the row's name: no border, no colour (colour on this
 * site is for live state). "keep safe" is the one that costs data when ignored, so it takes the
 * body emphasis (weight 500, two inks brighter). */
function TagLine({ tag }: { tag: Tag }) {
  return (
    <p className={`mt-1 text-[12px] leading-[18px] ${tag === "keep safe" ? "font-medium text-ink-2" : "text-ink-4"}`}>
      {tag}
    </p>
  );
}

function DocsPage() {
  return (
    <main id="main" className="wrap pb-32 pt-28 lg:pt-40">
      <div className="max-w-[792px]">
        <h1 className="t-display">The setup notes.</h1>
        <p className="t-lead mt-6 max-w-[690px]">
          Setting it up takes someone comfortable with a terminal, once. These notes set up the box and its other
          computers, then say how to ask it for an app.
        </p>

        {/* Jump list */}
        <nav aria-label="Sections" className="mt-10 grid grid-cols-2 gap-x-5 sm:grid-cols-5 sm:gap-y-2">
          {SECTIONS.map((s) => (
            <a key={s.id} href={`#${s.id}`} className="t-small link inline-flex min-h-11 items-center justify-self-start sm:min-h-0">
              {s.short}
            </a>
          ))}
        </nav>
        <p className="t-small mt-5 max-w-[690px] text-ink-3">
          After those come the accounts, dashboards, two keys and one router that every install still needs outside
          its config repo. They live outside git, and each is configured once, by hand.
        </p>

        {/* The ledger */}
        <div className="mt-24 flex flex-col gap-24">
          {SECTIONS.map((s) => (
            <section key={s.id} id={s.id} aria-labelledby={`${s.id}-title`}>
              <h2 id={`${s.id}-title`} className="t-title-l">
                {s.title}
              </h2>
              <p className="t-body mt-3 max-w-[690px]">{s.blurb}</p>

              <div className="mt-8">
                {s.rows.map((row) => (
                  <div
                    key={row.name}
                    className="grid gap-2 border-t border-edge-1 py-5 sm:grid-cols-[200px_1fr] sm:gap-8"
                  >
                    <div>
                      <p className="t-body font-medium text-ink-1">{row.name}</p>
                      {row.tag ? <TagLine tag={row.tag} /> : null}
                    </div>
                    {/* min-w-0: a command scrolls inside its own box instead of widening the column */}
                    <div className="min-w-0">
                      <p className="t-body text-ink-2">{row.body}</p>
                      {row.code ? (
                        <pre className="t-mono mt-3 overflow-x-auto rounded-control bg-raise-1 px-4 py-3 shadow-[inset_0_0_0_1px_var(--color-edge-1)]">
                          <code>{row.code.join("\n")}</code>
                        </pre>
                      ) : null}
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
            The pattern, if you’re building your own: when something can’t be declared, declare
            <em> that it exists</em>, beside the stack that needs it, in the place a reader would look. A port
            forward lives in a registry no rebuild consumes; your config repo should carry its own copy of this
            page, filled in.
          </p>
          <p className="t-small mt-6 text-ink-4">declared where possible, written down where not</p>
        </div>
      </div>
    </main>
  );
}
