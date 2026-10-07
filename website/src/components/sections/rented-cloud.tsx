import { Reveal } from "~/components/reveal";
import { SectionHeading } from "~/components/ui/section-heading";

/** The thesis section: the rented cloud itemized like a receipt, each line
 * a service you would otherwise pay for, struck through as it scrolls in,
 * and what the box runs instead. Typography only: mono ledger rows on
 * hairlines, no cards, no icons, no logos. The strike is CSS (.strike in
 * styles.css); the static page ships every line already struck. */

interface LedgerRow {
  vendor: string;
  sells: string;
  ours: string;
}

const LEDGER: LedgerRow[] = [
  {
    vendor: "Vercel",
    sells: "push-to-deploy, build minutes",
    // BUILDS.md: the box builds with Railpack (or a repo's Dockerfile), the
    // repo's checks run inside the image build, the image goes to the box's
    // own registry, and the outcome returns to GitHub as a check run.
    ours: "Push to main. The box builds the image with Railpack, runs the repo's own checks inside the build, pushes it to its own registry and deploys it.",
  },
  {
    vendor: "AWS RDS",
    sells: "managed Postgres",
    // `postgres.enable` defaults to false: an app that asks gets a database,
    // a stateless one gets none.
    ours: "One shared cluster. An app that asks for a database is handed its own role, its own database and a DATABASE_URL.",
  },
  {
    vendor: "Auth0",
    sells: "single sign-on",
    // `auth.mode` is none | proxy | native: some apps cannot speak OIDC at
    // all, which is why it is a choice per app.
    ours: "Pocket ID issues the identity. An app is gated at the proxy or speaks OIDC itself, and it is one account either way.",
  },
  {
    vendor: "Route 53 + ACM",
    sells: "DNS, certificates",
    ours: "Records, tunnel routes and a wildcard certificate, generated from the same declaration as the app.",
  },
  {
    vendor: "Datadog",
    sells: "metrics, logs, alerts",
    ours: "Prometheus, Grafana and Loki, and a probe on every published hostname. A probe that cannot answer reads as unknown, never as healthy.",
  },
  {
    vendor: "S3",
    sells: "backups",
    // The one row where the rented thing is genuinely better, and saying so
    // costs nothing. A reader who works it out alone stops believing the
    // other five.
    ours: "ZFS snapshots every fifteen minutes, replicated to a second pool. Both copies live in one place, so the off-site one is still yours to add.",
  },
];

export function RentedCloud() {
  return (
    <section id="cloud" className="scroll-mt-28 py-28 sm:py-36">
      <div className="mx-auto max-w-4xl px-6">
        <SectionHeading
          kicker="The idea"
          title="You already run a cloud. You just rent it."
          sub="Every line below is an invoice that stops arriving, and an outage that stops being someone else's."
        />

        <div className="mt-16">
          <div className="flex items-baseline justify-between border-b border-line-2 pb-3 font-mono text-[10px] uppercase tracking-[0.2em] text-dim">
            <span>Rented</span>
            <span>Runs on the box</span>
          </div>

          {LEDGER.map((row, i) => (
            <Reveal key={row.vendor} delay={i * 0.04} className="ledger-row">
              <div className="grid gap-2 border-b border-hairline py-5 sm:grid-cols-[14rem_1fr] sm:gap-10">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 sm:block">
                  <span className="strike font-mono text-[14px] text-muted">{row.vendor}</span>
                  <span className="block font-mono text-[11px] text-dim sm:mt-1.5">{row.sells}</span>
                </div>
                <p className="text-pretty text-[15px] leading-relaxed text-fg/90">{row.ours}</p>
              </div>
            </Reveal>
          ))}

          <div className="flex items-baseline justify-between pt-5 font-mono text-[11px] tracking-wide">
            <span className="uppercase tracking-[0.2em] text-dim">Total</span>
            <span className="text-[13px] text-accent">one machine you own</span>
          </div>
        </div>
      </div>
    </section>
  );
}
