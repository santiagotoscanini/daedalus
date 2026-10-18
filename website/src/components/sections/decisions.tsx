import type { ComponentType } from "react";

import { Databases, Models, Reach, SignIn } from "~/components/demo/fragments";
import { SectionHeader } from "~/components/ui/section-header";

/** The tree, already cut, as a ledger: four choices every app would otherwise make for itself, the
 * usual alternatives struck through, and the answer the platform gives once, with the piece of the
 * app it becomes beside it (demo/fragments.tsx).
 *
 * Each answer is what the engine does today (ARCHITECTURE.md, the apps registry): Pocket ID's
 * passkeys as one sign-in for the house; a database per app on the shared Postgres, inside the
 * snapshotted state; one LiteLLM key per app in front of the house's model server and the frontier;
 * the three exposure rungs with the wildcard certificate and DNS. How the box builds and how a
 * change is undone are How's to show. The struck alternatives are generic categories and name no
 * vendor.
 *
 * A real table. From 1024px it keeps table layout, so its semantics are never in doubt: four equal
 * columns whose padding (COL) puts each column's content on a three-column span of the page grid at
 * any width. Below 1024px the rows stack and the head row is left to screen readers. */

interface Decision {
  q: string;
  usual: string[];
  title: string;
  text: string;
  Piece: ComponentType<{ className?: string }>;
}

const DECISIONS: Decision[] = [
  {
    q: "How do people sign in?",
    usual: ["A users table in every app", "A hosted sign-in service", "Magic links by email"],
    title: "One sign-in for the house",
    text: "Passkeys, through the house’s own identity provider. Every app gets it without writing a login.",
    Piece: SignIn,
  },
  {
    q: "Where does the data live?",
    usual: ["A managed database in the cloud", "SQLite in a volume", "Files on disk"],
    title: "Postgres, on the box",
    text: "A database for each app on one cluster, snapshotted every hour with the rest of the house.",
    Piece: Databases,
  },
  {
    q: "How does it reach a model?",
    usual: ["A provider key in every app", "One provider, hard-coded", "A model baked into the image"],
    title: "One key for every model",
    text: "A gateway in front of the models on your own GPU and the frontier ones, so an app never chooses a provider.",
    Piece: Models,
  },
  {
    q: "Who can reach it?",
    usual: ["Port forwarding on the router", "A VPN for every guest", "A second host for the public part"],
    title: "A switch",
    text: "Off, the house, or the internet. The address, the certificate and the DNS follow the switch.",
    Piece: Reach,
  },
];

const HEAD = ["Question", "Every app would otherwise choose from", "Decided once", "In the app"];

/** Each column is a quarter of the width W, and a three-column span of the page grid is W/4 − 18px
 * wide with 24px gutters. Padding of 18 / 6+12 / 12+6 / 18 lands every content box on its span. */
const COL = ["lg:pr-4.5", "lg:pl-1.5 lg:pr-3", "lg:pl-3 lg:pr-1.5", "lg:pl-4.5"];
/** Row padding and alignment, on the table's own boxes from 1024px; below, the row carries it. */
const AT_LG = "lg:py-6 lg:align-top";
/** The fragment's top edge sits on the cap line of the row's first text line, 6px into its 24px
 * line box, so it does not ride high against the question and answer beside it. */
const AT_LG_PIECE = "lg:pb-6 lg:pt-[30px] lg:align-top";

export function Decisions() {
  return (
    <section id="platform" aria-labelledby="platform-title" className="pb-18 pt-10 sm:pb-24 sm:pt-12 lg:pb-28 lg:pt-16">
      <div className="wrap">
        <SectionHeader
          id="platform-title"
          title="Every decision, made before the first prompt."
          lead="Before writing anything that matters, an engineer walks a tree of choices. daedalus makes them once, for every app, so all that’s left to talk about is what you want."
        />

        <table aria-labelledby="platform-title" className="mt-10 w-full table-fixed text-left max-lg:block lg:mt-16">
          <thead className="max-lg:sr-only">
            <tr className="border-b border-edge-2">
              {HEAD.map((h, i) => (
                <th key={h} scope="col" className={`t-small h-10 text-left font-medium text-ink-4 ${COL[i]}`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="max-lg:block">
            {DECISIONS.map((d) => (
              <tr key={d.q} className="border-b border-edge-1 max-lg:block max-lg:py-6">
                {/* stacked, the question is the row's small label and the decided title its one
                    head; at body size the two competed. The type classes take no breakpoint
                    variants, so each size is its own span and the other is display:none */}
                <th scope="row" className={`text-left max-lg:block ${COL[0]} ${AT_LG}`}>
                  <span className="t-small block font-medium text-ink-4 lg:hidden">{d.q}</span>
                  <span className="t-body block font-medium text-ink-2 max-lg:hidden">{d.q}</span>
                </th>
                <td className={`max-lg:mt-3 max-lg:block ${COL[1]} ${AT_LG}`}>
                  <ul className="flex flex-wrap gap-x-5 gap-y-1 lg:block">
                    {d.usual.map((u) => (
                      <li key={u} className="t-body text-ink-4">
                        <s className="decoration-white/28 decoration-1">{u}</s>
                      </li>
                    ))}
                  </ul>
                </td>
                <td className={`max-lg:mt-4 max-lg:block ${COL[2]} ${AT_LG}`}>
                  <p className="t-body font-medium text-ink-1">{d.title}</p>
                  <p className="t-body mt-1">{d.text}</p>
                </td>
                {/* the product needs the room: from 640px only */}
                <td className={`max-sm:hidden sm:max-lg:mt-5 sm:max-lg:block ${COL[3]} ${AT_LG_PIECE}`}>
                  <d.Piece className="w-full max-w-[282px]" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
