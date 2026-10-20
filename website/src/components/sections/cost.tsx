/** Cost (#cost): five years of photos, rented against owned. One paired-bar chart on a shared
 * $0–$3,600 scale, each iCloud+ bar cut into its five yearly payments and each box bar into the
 * purchase and five small years of running it, so the reader sees rent recur and the box flatten
 * out. At 2 TB the box bar is the longer one and is drawn the same way: the chart says plainly
 * where renting wins, and the prose under it says what the box is for there and where Google's
 * dearer-but-bigger plan beats it. The one thing that is next (one-click photo backup) sits under
 * the intro, before the chart, so a reader knows what the bars are an offer of before reading
 * them. Below the prose, "How we counted", a native <details> whose every line cites where its
 * number came from, including what the chart leaves out. Below 792px of column the rows stack
 * (label over two full-width bars) in the prose's 620 column. */

import { type CSSProperties, type ReactNode, useRef } from "react";
import { ChevronRight } from "~/components/icons";
import { Coming } from "~/components/landing/coming";
import { useFigure } from "~/components/landing/motion";
import { Header, Section } from "~/components/landing/section";

/** One bar on a gap-free scale where $3,600 is 608px. Every year of it is the same piece, so the
 * five years are drawn equal: cost.css rounds one year to a whole device pixel and lays the years
 * 1px apart from the bar's rounded end, and the box's purchase takes whatever is left before them.
 * The bar's total then stays within half a pixel of its value at every scale. */
interface Bar {
  /** where the bar ends, gap-free */
  end: number;
  /** one year's piece: a year of rent, or a year of running the box */
  year: number;
  value: string;
}

/* Committed literals, from the arithmetic in "How we counted":
 *   iCloud+: 60 months at $9.99 / $29.99 / $59.99 = $599.40 / $1,799.40 / $3,599.40, five equal
 *     years of 19.44 / 59.98 / 120.8, so 101.2 / 303.9 / 608.0px with the 4 gaps.
 *   box: the purchase, $891 / $1,024.99 / $1,144.99 = 150.5 / 173.1 / 193.4, then five years of
 *     running it at $86.44 a year = 14.6px each, a 1px gap and 13.6 of bar, so the bars end at
 *     223.5 / 246.1 / 266.4px with the 5 gaps: $1,323 / $1,457 / $1,577. */
const ROWS: readonly { size: string; rent: Bar; box: Bar }[] = [
  { size: "2 TB", rent: { end: 97.2, year: 19.44, value: "$599" }, box: { end: 218.5, year: 13.6, value: "$1,323" } },
  { size: "6 TB", rent: { end: 299.9, year: 59.98, value: "$1,799" }, box: { end: 241.1, year: 13.6, value: "$1,457" } },
  { size: "12 TB", rent: { end: 604, year: 120.8, value: "$3,599" }, box: { end: 261.4, year: 13.6, value: "$1,577" } },
];

const SUMMARY =
  "Five years of each, at today’s prices. 2 TB: iCloud+ $599, your box $1,323, so renting is cheaper. " +
  "6 TB: iCloud+ $1,799, your box $1,457, so the box is cheaper. " +
  "12 TB: iCloud+ $3,599, your box $1,577, so the box is cheaper.";

/* The timeline (ms), per row r, shifted by 120r. iCloud+ year k grows from 100k over 160; the
 * box's purchase grows over 0–480, then running year k from 480 + 100k over 120. A value fades in
 * (200) as its bar completes: iCloud+ at 400 + 160, the box at 480 + 400 + 120. */
const ROW_STAGGER = 120;
const RENT_DONE = 560;
const BOX_DONE = 1000;
const YEARS = [0, 1, 2, 3, 4];

function timing(at: number, dur: number): CSSProperties {
  return { "--at": `${at}ms`, "--for": `${dur}ms` } as CSSProperties;
}

function Bars({ bar, kind, row }: { bar: Bar; kind: "rent" | "box"; row: number }) {
  const t0 = row * ROW_STAGGER;
  return (
    <div className={`cost-bar is-${kind}`} style={{ "--end": bar.end, "--year": bar.year } as CSSProperties}>
      {kind === "box" && <span className="cost-seg m-grow-x is-buy" style={timing(t0, 480)} />}
      {YEARS.map((i) => (
        <span
          key={i}
          className={`cost-seg m-grow-x ${kind === "rent" ? "is-rent" : "is-run"}`}
          style={
            {
              "--i": i,
              ...(kind === "rent" ? timing(t0 + 100 * i, 160) : timing(t0 + 480 + 100 * i, 120)),
            } as CSSProperties
          }
        />
      ))}
      <span className="cost-val m-fade" style={timing(t0 + (kind === "rent" ? RENT_DONE : BOX_DONE), 200)}>
        {bar.value}
      </span>
    </div>
  );
}

function Chart() {
  const ref = useRef<HTMLDivElement>(null);
  useFigure(ref, { threshold: 0.5 });
  return (
    <div className="cost-figure">
      <div ref={ref} className="cost-chart" role="img" aria-label={SUMMARY}>
        {/* three keys because the box bar has two tones: what it costs once, then each year of
            running it */}
        <div className="cost-legend">
          <span>
            <i className="is-rent" />
            iCloud+, five years
          </span>
          <span>
            <i className="is-box" />
            The box, bought once
          </span>
          <span>
            <i className="is-run" />A year of running it
          </span>
        </div>
        <div className="cost-rows">
          {ROWS.map((r, i) => (
            <div key={r.size} className="cost-row">
              {/* "of photos" is the label's second line beside the bars, and its own words above them */}
              <span className="cost-label">
                {r.size} <span className="cost-unit">of photos</span>
              </span>
              <div className="cost-pair">
                <Bars bar={r.rent} kind="rent" row={i} />
                <Bars bar={r.box} kind="box" row={i} />
              </div>
            </div>
          ))}
        </div>
        <div className="cost-base" />
      </div>
      <table className="sr-only">
        <caption>Five years of each, at today’s prices</caption>
        <thead>
          <tr>
            <th scope="col">Library</th>
            <th scope="col">iCloud+</th>
            <th scope="col">Your box</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((r) => (
            <tr key={r.size}>
              <th scope="row">{r.size}</th>
              <td>{r.rent.value}</td>
              <td>{r.box.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const SRC = {
  claude: ["claude.com", "https://claude.com/pricing"],
  appleDev: ["developer.apple.com", "https://developer.apple.com/programs/"],
  icloud: ["support.apple.com", "https://support.apple.com/en-us/108047"],
  beelink: ["bee-link.com", "https://www.bee-link.com/products/beelink-eq14-n150"],
  used: ["budgethomelab.com", "https://budgethomelab.com/articles/used-mini-pc-homelab-under-200/"],
  ssd: ["dropreference.com", "https://dropreference.com/en/blog/news/ssd-price-increase-2026-nand-flash-crisis"],
  hdd: ["storagediskprices.com", "https://storagediskprices.com/hdd-prices/"],
  bay: ["terra-master.com", "https://www.terra-master.com/products/d2-320"],
  eia: ["eia.gov", "https://www.eia.gov/electricity/monthly/epm_table_grapher.php?t=epmt_5_6_a"],
  watts: ["servethehome.com", "https://www.servethehome.com/lenovo-thinkcentre-m920-and-m920q-tiny-guide-and-review/3/"],
  domain: ["domainoffer.net", "https://domainoffer.net/tld/com/cloudflare"],
  googleA: ["office-watch.com", "https://office-watch.com/2026/google-ai-pro-5tb-storage-upgrade-free/"],
  googleB: ["9to5google.com", "https://9to5google.com/2026/06/08/google-ai-plus-price-drop/"],
  prices: ["starryhope.com", "https://www.starryhope.com/minipcs/dram-price-spike-mini-pc-raspberry-pi-2026/"],
} as const;

type SourceId = keyof typeof SRC;

/** A line of "How we counted", with where its number came from (the story's Sources) on a quiet
 * line of its own under it, so the sentence wraps to the full column and every item ends alike. */
function Item({ src, children, sub }: { src?: SourceId[]; children: ReactNode; sub?: ReactNode }) {
  return (
    <li>
      {children}
      {src && (
        <span className="cost-srcs">
          {src.map((id) => (
            <a key={id} href={SRC[id][1]}>
              {SRC[id][0]}
            </a>
          ))}
        </span>
      )}
      {sub}
    </li>
  );
}

/* The second line is the direction's, less "Neither are your iPhones' own backups": the chart
 * does count them, as the iCloud+ 200 GB on the box's side (the seventh line), so saying it does
 * not would contradict the arithmetic three lines further down. The founder approved this wording
 * after round 1. The first line is the direction's less its Google sentence, which now stands in the
 * visible paragraph: the one rival that beats the box was a click deep. */
function HowWeCounted() {
  return (
    <details className="cost-how">
      <summary>
        How we counted
        <ChevronRight />
      </summary>
      <div className="cost-how-body">
        <ul>
          <Item>
            Both copies of every photo stay in your house, while iCloud keeps its copies in more than one place.
          </Item>
          <Item src={["claude", "appleDev"]}>
            Asking for apps goes through Claude Code, which comes with a Claude plan from $17 a&nbsp;month. It isn’t
            counted here, and neither is Apple’s developer account for iPhone apps, $99 a&nbsp;year. A gaming PC you
            already own can run the house’s own models. Without one, an app’s AI features use a provider’s API,
            billed by use, which isn’t counted either.
          </Item>
          <Item src={["icloud"]}>
            iCloud+ prices are Apple’s US prices, published September&nbsp;16, 2026. Every tier can be shared with
            up to five family members.
          </Item>
          <Item src={["beelink", "used"]}>
            The box is a Beelink EQ14 (Intel N150, 16&nbsp;GB), $385 at its maker’s store in October 2026 (list
            price $469). A used small PC costs $150 to $250, and one you already own costs nothing.
          </Item>
          <Item
            sub={
              <ul>
                <Item src={["ssd"]}>2&nbsp;TB: two 2&nbsp;TB SSDs in the EQ14’s two drive slots, $253 each.</Item>
                <Item src={["hdd"]}>
                  6&nbsp;TB: two 8&nbsp;TB hard drives at $252 to $258 each, which gives 8&nbsp;TB usable.
                </Item>
                <Item src={["hdd"]}>12&nbsp;TB: two 12&nbsp;TB hard drives at $310 to $320 each.</Item>
                <Item src={["bay"]}>
                  The hard drives sit in a two-bay USB enclosure, $129.99. Midpoints are used.
                </Item>
              </ul>
            }
          >
            Every photo is kept twice, on two matching drives:
          </Item>
          <Item src={["eia", "watts"]}>
            Electricity is counted at 25&nbsp;watts around the clock, the top of what small PCs draw at rest, at the
            US average of 18.31¢ per kWh (EIA, July 2026): $40.10 a&nbsp;year.
          </Item>
          <Item src={["icloud", "domain"]}>
            The box’s side also keeps iCloud+ 200&nbsp;GB ($2.99 a&nbsp;month) for the iPhones’ own backups, and a
            domain name for the apps’ addresses (a .com is about $10.46 a&nbsp;year).
          </Item>
          <Item src={["googleA", "googleB"]}>Google’s prices are from press reports.</Item>
          <Item src={["prices", "ssd"]}>Storage and memory prices have roughly doubled since 2025.</Item>
        </ul>
      </div>
    </details>
  );
}

export function Cost() {
  return (
    <Section id="cost">
      <Header
        titleLines={["Rent grows with every photo.", "The box doesn’t."]}
        intro={
          <>
            Your photos can live on the box instead. iCloud+ charges $9.99&nbsp;a&nbsp;month for 2&nbsp;TB, $29.99 for
            6&nbsp;TB and $59.99 for 12&nbsp;TB, for as long as you keep them. A&nbsp;box costs nearly the same at any
            size.
          </>
        }
      />
      {/* what the bars are an offer of, said before them rather than under them */}
      <div className="wrap">
        <p className="t-caption cost-note">
          <Coming />
          Photo backup runs on the box in the home where daedalus was built.{" "}
          <span>One click for every house is next.</span>
        </p>
      </div>
      <div className="wrap after-header">
        <Chart />
        {/* what the chart means, and where the one rival it does not draw comes out ahead */}
        <div className="t-prose cost-prose">
          <p>
            At 2&nbsp;TB renting is cheaper, so there the box is for the apps and for keeping your family’s things at
            home. Past that it pays for itself, in under four years at 6&nbsp;TB and under two at 12&nbsp;TB. Google’s
            5&nbsp;TB plan, $199.99 a&nbsp;year with its AI included, costs less than a&nbsp;6&nbsp;TB box over five
            years.
          </p>
        </div>
        <HowWeCounted />
      </div>
    </Section>
  );
}
