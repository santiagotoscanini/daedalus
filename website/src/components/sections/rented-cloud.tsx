import { Reveal } from "~/components/reveal";
import { SectionHeading } from "~/components/ui/section-heading";

/** The thesis section: the rented cloud, itemized like a receipt — each
 * line a service you'd otherwise pay for, and what the box runs instead.
 * Typography only: mono ledger rows on hairlines, no cards, no icons. */

interface LedgerRow {
  vendor: string;
  sells: string;
  ours: string;
}

const LEDGER: LedgerRow[] = [
  {
    vendor: "Vercel",
    sells: "push-to-deploy, build minutes",
    ours: "Push to main. The box builds it, registers it, ships it — live in about two minutes.",
  },
  {
    vendor: "AWS RDS",
    sells: "managed Postgres",
    ours: "One shared cluster. Every app is born with a database, a role and a DATABASE_URL.",
  },
  {
    vendor: "Auth0",
    sells: "single sign-on",
    ours: "Pocket ID fronts every app with OIDC — one account, every door.",
  },
  {
    vendor: "Route 53 + ACM",
    sells: "DNS, certificates",
    ours: "Records and wildcard TLS generated from the same declaration as the app itself.",
  },
  {
    vendor: "Datadog",
    sells: "metrics, logs, alerts",
    ours: "Prometheus, Grafana and Loki on the box — dashboards that admit what they don't know.",
  },
  {
    vendor: "S3",
    sells: "backups",
    ours: "ZFS snapshots every fifteen minutes, replicated to a second mirror.",
  },
];

export function RentedCloud() {
  return (
    <section id="cloud" className="scroll-mt-28 py-32">
      <div className="mx-auto max-w-4xl px-6">
        <SectionHeading
          kicker="The idea"
          title="You already run a cloud. You just rent it."
          sub="Every line below is an invoice that stops arriving — and an outage that stops being someone else's."
        />

        <Reveal delay={0.06}>
          <div className="mt-16">
            {/* Receipt header */}
            <div className="flex items-baseline justify-between border-b border-line-2 pb-3 font-mono text-[10px] uppercase tracking-[0.18em] text-dim">
              <span>Rented</span>
              <span>Runs on the box</span>
            </div>

            {LEDGER.map((row) => (
              <div
                key={row.vendor}
                className="group grid gap-2 border-b border-hairline py-5 sm:grid-cols-[15rem_1fr] sm:gap-10"
              >
                <div className="flex items-baseline gap-3 sm:block">
                  <span className="font-mono text-[14px] text-muted transition-colors group-hover:text-fg">
                    {row.vendor}
                  </span>
                  <span className="block font-mono text-[11px] text-dim sm:mt-1.5">
                    {row.sells}
                  </span>
                </div>
                <p className="text-pretty text-[15px] leading-relaxed text-fg/90">{row.ours}</p>
              </div>
            ))}

            {/* Receipt footing */}
            <div className="flex items-baseline justify-between pt-4 font-mono text-[11px] tracking-wide">
              <span className="uppercase tracking-[0.18em] text-dim">Total</span>
              <span className="text-accent">one box · one repo · yours</span>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
