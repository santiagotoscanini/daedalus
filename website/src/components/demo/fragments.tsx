/** Pieces of the product drawn outside the hero: How's record of one request, and the answer
 * beside each question in Decisions. Product tokens and product sizes throughout (chrome.tsx), so
 * they read as daedalus and not as this site. Every root is a `.fragment` carrying `data-product`
 * and `role="img"` with a written description, so every word inside is paint (see chrome.tsx).
 *
 * The record is what the reference box does for one request: the registry entry is the real shape
 * of site/apps.json, the build rows follow the box's own build log (BUILDS.md), and the older history
 * lines are real commits on that box, in plain words.
 *
 * Static pictures never claim live state. The record is timestamped, so its "Live" dot is the one
 * green a still picture may carry; nothing in the Decisions fragments has a dot. */

import type { ReactNode } from "react";

import { CheckIcon, Lock } from "~/components/icons";

import { APP, AppTile, Btn, Chip, alpha } from "./chrome";

/* ---------------------------------------------------------------- *
 * How: one request, start to finish
 * ---------------------------------------------------------------- */

export type RecordStep = "written" | "built" | "shipped" | "back";

const ORDER: RecordStep[] = ["written", "built", "shipped", "back"];

const DIFF: Array<["+" | " ", string]> = [
  [" ", `  "lintel": { … },`],
  ["+", `  "almacen": {`],
  ["+", `    "stage": "live",`],
  ["+", `    "postgres": true,`],
  ["+", `    "auth": { "mode": "native", "healthPath": "/api/healthz" },`],
  ["+", `    "presentation": { "description": "The store's hours, for mom" }`],
  ["+", `  },`],
  [" ", `  "plutus": { … },`],
];

const BUILD: Array<[string, string, string]> = [
  ["0.0s", "webhook", "push to main · almacen · 9c1e07d"],
  ["0.4s", "plan", "node 24 · pnpm · railpack"],
  ["38.2s", "build", "image built on the box"],
  ["51.7s", "checks", "typecheck · tests · lint"],
  ["53.0s", "push", "registry.toscanini.me/almacen"],
  ["58.9s", "deploy", "almacen started, /api/healthz 200"],
];

const HISTORY: Array<{ when: string; what: string; tag?: "applied" | "reverted" }> = [
  { when: "now", what: "Revert: a page with the store’s hours", tag: "applied" },
  { when: "2m", what: "A page with the store’s hours, for mom", tag: "reverted" },
  { when: "Oct 16", what: "lintel’s database moves back home after the hackathon" },
  { when: "Oct 9", what: "hermes gets storage of its own" },
  { when: "Oct 2", what: "sankofa goes public. The first try failed and undid itself" },
];

const RECORD_LABEL =
  "The record of one request: the commit “A page with the store’s hours, for mom”, written by the agent, adding almacen to site/apps.json; the box building it, from the webhook to the deploy in 58.9 seconds; almacen live at almacen.toscanini.me with a certificate, a sign-in, a database and a health check; and the house’s history, where one step reverted it.";

const CARD_LABEL: Record<RecordStep, string> = {
  written:
    "The commit “A page with the store’s hours, for mom”, written by the agent from the request: one file changed, almacen added to site/apps.json, checks passed.",
  built:
    "The box building almacen: webhook, plan, build, checks, push to its own registry and deploy, in 58.9 seconds.",
  shipped:
    "almacen live at almacen.toscanini.me, with a certificate, a sign-in, a database and a health check, and the store’s page with its hours, weekdays 9:00 to 20:30 and Saturdays 9:00 to 13:00: open now, closes at 20:30.",
  back: "The house’s history: the change, struck through, and the revert that undid it in one step, above earlier commits.",
};

/** The compact cards pad like the compact Apps view (16px, 20px from 640); rows that carry a
 * background bleed to the group's edges, as a product table's do. */
const pad = (compact: boolean) => (compact ? "p-4 sm:p-5" : "px-6 py-5");
const bleedOut = (compact: boolean) => (compact ? "-mx-4 sm:-mx-5" : "-mx-6");
const bleedIn = (compact: boolean) => (compact ? "px-4 sm:px-5" : "px-6");

/** Code keeps its lines whole, as the product's code views do: on a narrow card the block runs to
 * the card's edges and scrolls sideways inside it, so a wrapped line never restarts at the left
 * edge and the page itself never scrolls. The inner box is as wide as the longest line, so the
 * added lines' fill reaches the end of every line.
 *
 * Below 640px the diff is wider than the card, and with no scrollbar a hard cut mid-token read as
 * a rendering bug, so that block fades at its right edge (`fade`). The mask is on the scroller, so
 * the added lines' fill fades with their text; FADE_END lets the end of the longest line scroll
 * clear of the fade and stop at the usual 16px from the edge. The build log fits a phone's card,
 * so it carries no fade over its last characters. */
const FADE = "max-sm:[mask-image:linear-gradient(to_left,transparent,#000_32px)]";
const FADE_END = "max-sm:pr-12";

function CodeScroll({
  compact,
  fade = false,
  className = "",
  children,
}: {
  compact: boolean;
  fade?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`overflow-x-auto [scrollbar-width:none] ${bleedOut(compact)} ${fade ? FADE : ""} ${className}`}
    >
      <div className="w-max min-w-full">{children}</div>
    </div>
  );
}

/** On a phone the tile is 22, not 20: its monogram is drawn at half the tile, and product text
 * stays at 11px or more below 1024px. Below 640px the subtitle goes rather than truncate: the
 * name and the hash carry the header. */
function RecordHead({ compact }: { compact: boolean }) {
  return (
    <div
      className="flex h-[48px] items-center gap-[8px] border-b px-[20px]"
      style={{ borderColor: APP.hairline }}
    >
      <AppTile name="almacen" size={compact ? 22 : 20} />
      <span className="text-[13px] font-semibold" style={{ color: APP.text }}>
        almacen
      </span>
      <span className="min-w-0 truncate text-[13px] max-sm:hidden" style={{ color: APP.subdued }}>
        one request, start to finish
      </span>
      <span className="ml-auto font-mono text-[12px]" style={{ color: APP.muted }}>
        4f2a91c
      </span>
    </div>
  );
}

function Written({ compact }: { compact: boolean }) {
  return (
    <>
      <p className="text-[14px] font-semibold leading-[20px]" style={{ color: APP.text }}>
        A page with the store’s hours, for mom
      </p>
      <p className="mt-[4px] text-[12px] leading-[18px]" style={{ color: APP.muted }}>
        {/* no-break before each middot, so a narrow card never starts a line with one */}
        {"1 file changed · written by the agent from your request · checks passed"}
      </p>
      <p className="mt-[12px] font-mono text-[12px] leading-[20px]" style={{ color: APP.muted }}>
        site/apps.json
      </p>
      <CodeScroll
        compact={compact}
        fade={compact}
        className="mt-[4px] font-mono text-[12px] leading-[20px]"
      >
        {DIFF.map(([sign, line], i) => (
          <p
            key={i}
            className={`flex ${bleedIn(compact)} ${compact ? FADE_END : ""}`}
            style={
              sign === "+"
                ? { background: "rgba(78,168,122,.10)", color: "#cfe9db" }
                : { color: APP.muted }
            }
          >
            <span className="w-[16px] shrink-0">{sign === "+" ? "+" : ""}</span>
            <span className="whitespace-pre">{line}</span>
          </p>
        ))}
      </CodeScroll>
    </>
  );
}

function Built({ compact }: { compact: boolean }) {
  return (
    <>
      {compact ? (
        <CodeScroll compact className="font-mono text-[12px] leading-[20px]">
          {BUILD.map(([t, step, detail]) => (
            <div key={step} className={`grid grid-cols-[48px_16px_1fr] gap-x-[8px] py-[4px] ${bleedIn(true)}`}>
              <span className="tnum text-right" style={{ color: APP.muted }}>
                {t}
              </span>
              <span className="flex h-[20px] items-center justify-center" style={{ color: APP.muted }}>
                <CheckIcon size={12} />
              </span>
              <span className="whitespace-pre">
                <span className="block" style={{ color: APP.text }}>
                  {step}
                </span>
                <span className="block" style={{ color: APP.subdued }}>
                  {detail}
                </span>
              </span>
            </div>
          ))}
        </CodeScroll>
      ) : (
        <div className="font-mono text-[12px] leading-[20px]">
          {BUILD.map(([t, step, detail]) => (
            <div
              key={step}
              className="grid h-[28px] grid-cols-[56px_16px_72px_1fr] items-center gap-x-[8px]"
            >
              <span className="tnum text-right" style={{ color: APP.muted }}>
                {t}
              </span>
              <span className="flex justify-center" style={{ color: APP.muted }}>
                <CheckIcon size={12} />
              </span>
              <span style={{ color: APP.text }}>{step}</span>
              <span className="min-w-0 truncate" style={{ color: APP.subdued }}>
                {detail}
              </span>
            </div>
          ))}
        </div>
      )}
      <p className="mt-[12px] text-[12px] leading-[18px]" style={{ color: APP.muted }}>
        The outcome goes back to GitHub as a check run.
      </p>
    </>
  );
}

function Shipped({ compact }: { compact: boolean }) {
  return (
    <div className={compact ? "" : "flex items-start gap-[24px]"}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-[12px]">
          <span
            className="flex min-w-0 items-center gap-[6px] font-mono text-[12px] leading-[20px]"
            style={{ color: APP.text }}
          >
            <Lock size={12} />
            <span className="truncate">almacen.toscanini.me</span>
          </span>
          <span
            className="flex shrink-0 items-center gap-[6px] text-[12px] leading-[20px]"
            style={{ color: APP.subdued }}
          >
            <span className="size-[6px] rounded-full" style={{ background: APP.ok }} />
            Live
          </span>
        </div>
        <div className="mt-[12px] flex flex-wrap gap-[6px]">
          {["certificate", "sign-in", "database", "health check"].map((c) => (
            <Chip key={c} tone="muted">
              {c}
            </Chip>
          ))}
        </div>
      </div>
      <StorePage compact={compact} />
    </div>
  );
}

/** The page the request asked for, as the store's customers see it. Its own palette: it is
 * almacen's page, not daedalus. Composed as the page's header: the name at the top, the week's
 * hours under it (the request was for the hours), today's state at the foot. The same 240×140 at
 * every width, under the chips below 1024px; a card-wide box only added empty cream. On a phone
 * its smallest line stays at 11px. */
function StorePage({ compact }: { compact: boolean }) {
  return (
    <div
      className={`flex h-[140px] flex-col ${compact ? "mt-[16px] w-full max-w-[240px]" : "w-[240px] shrink-0"}`}
      style={{
        background: "#ece6db",
        borderRadius: 6,
        boxShadow: "inset 0 0 0 1px rgba(0,0,0,.45)",
        padding: 14,
      }}
    >
      <p
        className={`font-semibold tracking-[0.12em] ${compact ? "text-[11px] leading-[14px]" : "text-[9px] leading-[12px]"}`}
        style={{ color: "#8a7b6e" }}
      >
        ALMACÉN
      </p>
      <div
        className="tnum mt-[10px] grid grid-cols-[auto_1fr] gap-x-[12px] text-[11px] leading-[16px]"
        style={{ color: "#5c5047" }}
      >
        <span>Lunes a viernes</span>
        <span>9:00–20:30</span>
        <span>Sábados</span>
        <span>9:00–13:00</span>
      </div>
      <div className="mt-auto">
        <p
          className="text-[22px] font-semibold leading-[26px] tracking-[-0.02em]"
          style={{ color: "#221a14" }}
        >
          Abierto ahora
        </p>
        <p className="mt-[2px] text-[11px] leading-[16px]" style={{ color: "#2f7a4f" }}>
          Cierra a las 20:30
        </p>
      </div>
    </div>
  );
}

function TakenBack({ compact }: { compact: boolean }) {
  return (
    <>
      <div className="flex items-center justify-between gap-[12px]">
        <span className="text-[13px]" style={{ color: APP.subdued }}>
          the house · history
        </span>
        <Btn ghost>Revert</Btn>
      </div>
      <div className="mt-[8px]">
        {HISTORY.map((r) => (
          <div
            key={r.when}
            className={`grid grid-cols-[64px_1fr_auto] items-baseline gap-x-[12px] py-[8px] text-[13px] leading-[20px] ${bleedOut(compact)} ${bleedIn(compact)}`}
            style={r.tag === "applied" ? { background: alpha(APP.text, 4) } : undefined}
          >
            <span className="font-mono text-[12px]" style={{ color: APP.muted }}>
              {r.when}
            </span>
            <span
              style={
                r.tag === "reverted"
                  ? {
                      color: APP.muted,
                      textDecorationLine: "line-through",
                      textDecorationColor: alpha(APP.text, 28),
                    }
                  : { color: r.tag === "applied" ? APP.text : APP.subdued }
              }
            >
              {r.what}
            </span>
            {r.tag ? (
              <span
                className="flex items-center gap-[6px] self-center text-[11px]"
                style={{ color: APP.subdued }}
              >
                {r.tag === "applied" ? (
                  <span className="size-[6px] rounded-full" style={{ background: APP.ok }} />
                ) : null}
                {r.tag}
              </span>
            ) : (
              <span />
            )}
          </div>
        ))}
      </div>
    </>
  );
}

const GROUP: Record<RecordStep, (compact: boolean) => ReactNode> = {
  written: (c) => <Written compact={c} />,
  built: (c) => <Built compact={c} />,
  shipped: (c) => <Shipped compact={c} />,
  back: (c) => <TakenBack compact={c} />,
};

/** The record from 1024px: one fragment whose header and four groups are its direct children, so
 * How can lay them on rows it shares with the annotations (`grid-rows-subgrid` in the className).
 * The dividers sit under each part, so every group's text starts exactly 20px into its row. */
export function HowRecord({ className = "" }: { className?: string }) {
  return (
    <div
      data-product
      role="img"
      aria-label={RECORD_LABEL}
      className={`fragment overflow-hidden ${className}`}
      style={{ color: APP.text }}
    >
      <RecordHead compact={false} />
      {ORDER.map((s, i) => (
        <div
          key={s}
          className={`${pad(false)} ${i < ORDER.length - 1 ? "border-b" : ""}`}
          style={{ borderColor: APP.hairline }}
        >
          {GROUP[s](false)}
        </div>
      ))}
    </div>
  );
}

/** Below 1024px the record splits into one card per group; the header stays on the first. */
export function HowRecordCard({ step, className = "" }: { step: RecordStep; className?: string }) {
  return (
    <div
      data-product
      role="img"
      aria-label={CARD_LABEL[step]}
      className={`fragment overflow-hidden ${className}`}
      style={{ color: APP.text }}
    >
      {step === "written" ? <RecordHead compact /> : null}
      <div className={pad(true)}>{GROUP[step](true)}</div>
    </div>
  );
}

/* ---------------------------------------------------------------- *
 * Decisions: the answer each question gets, as it looks in the app
 * ---------------------------------------------------------------- */

function Piece({
  label,
  className = "",
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      data-product
      role="img"
      aria-label={label}
      className={`fragment p-[14px] ${className}`}
      style={{ color: APP.text }}
    >
      {children}
    </div>
  );
}

/** One sign-in for the house: almacen's sign-in page, which the app never had to write. Its button
 * is in the product's raised tone, not its light primary: beside the page's own filled button, a
 * light one read as a second call to action on the site. */
export function SignIn({ className }: { className?: string }) {
  return (
    <Piece label="almacen’s sign-in page, with one button: Continue with a passkey." className={className}>
      <div className="flex items-center gap-[10px]">
        <AppTile name="almacen" size={22} />
        <span className="text-[13px] font-semibold">Sign in to almacen</span>
      </div>
      <div
        className="mt-[12px] flex h-[30px] w-full items-center justify-center rounded-[8px] text-[12.5px] font-semibold"
        style={{
          background: APP.raise,
          color: APP.text,
          boxShadow: `inset 0 0 0 1px ${APP.hairline}`,
        }}
      >
        Continue with a passkey
      </div>
    </Piece>
  );
}

/** Postgres on the box: one database per app on the shared cluster. */
export function Databases({ className }: { className?: string }) {
  const rows: Array<[string, string]> = [
    ["almacen", "12 MB"],
    ["hermes", "1.4 GB"],
    ["sankofa", "380 MB"],
  ];
  return (
    <Piece
      label="The databases on the box’s one cluster: almacen 12 MB, hermes 1.4 GB, sankofa 380 MB."
      className={className}
    >
      <div
        className="flex h-[20px] justify-between text-[11.5px] font-medium leading-[14px]"
        style={{ color: APP.subdued }}
      >
        <span>Database</span>
        <span>Size</span>
      </div>
      {rows.map(([name, size], i) => (
        <div
          key={name}
          className="-mx-[6px] flex h-[28px] items-center justify-between rounded-[6px] px-[6px] text-[13px]"
          style={i === 0 ? { background: alpha(APP.text, 4), color: APP.text } : { color: APP.subdued }}
        >
          <span>{name}</span>
          <span className="tnum">{size}</span>
        </div>
      ))}
    </Piece>
  );
}

/** One key for every model: the gateway key an app is given, and where its models run. */
export function Models({ className }: { className?: string }) {
  const rows: Array<[string, string]> = [
    ["smart", "Gaming PC"],
    ["voice", "Gaming PC"],
    ["frontier", "the cloud"],
  ];
  return (
    <Piece
      label="One gateway key, LITELLM_API_KEY, for every model: smart and voice on the gaming PC, frontier in the cloud."
      className={className}
    >
      {/* seven dots: the line still fits the narrowest column, 214px at 1024 */}
      <p className="truncate font-mono text-[11.5px] leading-[20px]">
        <span style={{ color: APP.muted }}>LITELLM_API_KEY=</span>
        <span style={{ color: APP.subdued }}>sk-•••••••</span>
      </p>
      <div className="mt-[6px]">
        {rows.map(([model, where]) => (
          <div key={model} className="flex h-[26px] items-center justify-between text-[13px]">
            <span style={{ color: APP.text }}>{model}</span>
            <span style={{ color: APP.subdued }}>{where}</span>
          </div>
        ))}
      </div>
    </Piece>
  );
}

/** Who can reach it: the app's exposure switch, drawn as the app's own segmented control
 * (app/src/components/tokens.ts, SEGMENT_*), with the address that follows it. */
export function Reach({ className }: { className?: string }) {
  return (
    <Piece
      label="An app’s exposure switch, set to Internet out of Off, House and Internet, with its address almacen.toscanini.me behind a certificate."
      className={className}
    >
      <div
        className="inline-flex items-center gap-[2px] rounded-[10px] border p-[3px]"
        style={{ borderColor: APP.hairline, background: alpha(APP.text, 3.5) }}
      >
        {["Off", "House", "Internet"].map((o) => {
          const on = o === "Internet";
          return (
            <span
              key={o}
              className="rounded-[7px] px-[10px] py-[5px] text-[12.5px] leading-[16px]"
              style={
                on
                  ? {
                      background: alpha(APP.text, 9),
                      color: APP.text,
                      fontWeight: 550,
                      boxShadow: `inset 0 1px 0 ${alpha(APP.text, 5)}`,
                    }
                  : { color: APP.muted }
              }
            >
              {o}
            </span>
          );
        })}
      </div>
      <p className="mt-[12px] flex items-center gap-[6px] font-mono text-[12px] leading-[16px]">
        <Lock size={10} />
        almacen.toscanini.me
      </p>
    </Piece>
  );
}
