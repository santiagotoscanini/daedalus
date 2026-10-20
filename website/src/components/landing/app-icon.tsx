/** The five app icons the page's story is told with: Pinch (the flagship, Grandma's recipe card) and
 * the four example requests in the tree. They are drawn the way a Home Screen icon is: the squircle
 * outline, a top-lit ground, one whole object lit from above with the same soft shadow straight
 * down in every icon, and a hairline of light along the top edge (all the way round on Backpack's
 * navy, the one ground dark enough to lose its edge on the page). Every size uses the same artwork;
 * below 30px the details too fine to survive drop out (a pencil, a hinge, the ruled lines) or become
 * a plainer mark that does the same job (Pinch's title a dash, Sitter's roof a house), and the marks
 * that carry the picture keep a minimum size in screen pixels, so a 20px icon reads as the same
 * thing as the 256px one.
 *
 * `<AppIcon app size />` renders an `aria-hidden` SVG of `size` px on a 1024 grid. Ids are prefixed
 * with `useId()` because several copies of one icon share a page. The outline and the handwriting
 * are literals from `scripts/gen-icon-paths.mjs`; nothing here is computed beyond those size floors.
 *
 * `<BetaIcon size />` is the icon on the TestFlight notification that reaches Grandma's phone. No
 * real company's mark belongs on her phone, so it is a plain blue tile with an arrow going down into
 * an open tray, the way any app's "ready to install" is drawn: it reads as an app icon, and as
 * nobody's in particular. */

import { type ReactNode, useId } from "react";
import { DOOR_MARKS, PINCH_HAND, SQUIRCLE } from "./app-icon-paths";

export type AppId = "pinch" | "backpack" | "pillbox" | "sitter" | "doorframe";

/** Each ground's top and bottom colour. Backpack's navy is lifted well off the page's near-black and
 * gets its rim lit (`rim`), so at 20px its tile is as large and as present as its neighbours'. */
const GROUND: Record<AppId, { top: string; bottom: string; rim?: true }> = {
  pinch: { top: "#F26B4A", bottom: "#D9472E" },
  backpack: { top: "#3B5189", bottom: "#2B3F7A", rim: true },
  pillbox: { top: "#2D5BD7", bottom: "#2249B8" },
  sitter: { top: "#8E7CF0", bottom: "#6C5BD8" },
  doorframe: { top: "#D4A56A", bottom: "#B07D45" },
};

interface Art {
  /** the useId prefix */
  u: string;
  size: number;
  /** ≤29px: the finest lines are dropped */
  small: boolean;
  /** a length in grid units that never renders smaller than `minPx` screen pixels */
  sw: (base: number, minPx: number) => number;
}

/** The shadow every icon's object casts straight down onto its ground: a wide soft layer and a tight
 * one where it nearly touches, the same two drops in all five, each in a dark of its ground's own hue
 * (a grey shadow on a coloured ground reads as dirt). Only the strength differs, so it reads the same
 * on navy as on coral. */
function Shadow({ id, color, far, near }: { id: string; color: string; far: number; near: number }) {
  return (
    <filter id={id} x="-30%" y="-30%" width="160%" height="170%" colorInterpolationFilters="sRGB">
      <feGaussianBlur in="SourceAlpha" stdDeviation="30.7" />
      <feOffset dy="30.7" result="far" />
      <feFlood floodColor={color} floodOpacity={far} />
      <feComposite in2="far" operator="in" result="farShadow" />
      <feGaussianBlur in="SourceAlpha" stdDeviation="6" />
      <feOffset dy="6" result="near" />
      <feFlood floodColor={color} floodOpacity={near} />
      <feComposite in2="near" operator="in" result="nearShadow" />
      <feMerge>
        <feMergeNode in="farShadow" />
        <feMergeNode in="nearShadow" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
  );
}

/** Grandma's recipe card on the coral ground: an index card turned −8°, the red rule a quarter of the
 * way down with her title written above it, three blue rules, and at 64px and up the faint ring a mug
 * left near its corner. The ring sits wholly on the paper: hung over the card's edge, its cut arc read
 * as a curled corner. The card's shadow is cast from an unturned copy so it falls straight down.
 * Below 40px a pen stroke of the scrawl's weight is a dark bar that fuses with the card's top edge and
 * reads as a clapperboard, so the title becomes one short dash, the rule moves down to make room for
 * it, and two blue rules stay (the third has no room): a dash over a red rule over blue lines is
 * still an index card. */
function Pinch({ u, size, sw }: Art) {
  const tiny = size < 40;
  const rule = sw(12.3, 1);
  const ruleY = tiny ? -202.8 + 133 : -105.5;
  const dash = sw(14, 0.8);
  const lines = tiny ? [232, 318] : [171.35, 248.45, 325.55];
  const lineH = tiny ? sw(6.1, 0.7) : 6.1;
  const card = { x: -338, y: -202.8, width: 676, height: 405.6, rx: 20.5 };
  return (
    <>
      <defs>
        <Shadow id={`${u}s`} color="#7A1E0E" far={0.3} near={0.16} />
        <linearGradient id={`${u}p`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFF9F0" />
          <stop offset="1" stopColor="#FCF0DC" />
        </linearGradient>
      </defs>
      <g filter={`url(#${u}s)`}>
        <rect {...card} fill="#FFF6E6" transform="translate(512 481.3) rotate(-8)" />
      </g>
      <g transform="translate(512 481.3) rotate(-8)">
        <rect {...card} fill={`url(#${u}p)`} />
        <rect x="-338" y={ruleY - rule / 2} width="676" height={rule} fill="#E2483A" />
        {lines.map((y) => (
          <rect key={y} x="-338" y={-202.8 + y} width="676" height={lineH} fill="#A9C2DE" />
        ))}
        {tiny ? (
          <rect x="-262" y={-150 - dash / 2} width="270.4" height={dash} rx={dash / 2} fill="#4A2E1F" />
        ) : (
          <path
            d={PINCH_HAND}
            fill="none"
            stroke="#4A2E1F"
            strokeWidth={sw(14.3, 0.9)}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {size >= 64 && (
          <g transform="rotate(8)">
            <ellipse
              cx="264"
              cy="84"
              rx="70"
              ry="64"
              transform="rotate(-18 264 84)"
              fill="none"
              stroke="#C99A62"
              strokeOpacity=".34"
              strokeWidth="12"
            />
            <path d="M208 50A60 56 -18 0 1 318 60" fill="none" stroke="#C99A62" strokeOpacity=".22" strokeWidth="7" />
          </g>
        )}
      </g>
    </>
  );
}

/** A school backpack on navy: one grab handle, the flap with its clasp, a front pocket, and a pencil
 * in the side pocket. Drawn 20 units left of centre, because the side pocket and the pencil put the
 * picture's weight to the right of the bag. Below 30px the pencil is a 1px sliver that only blurs the
 * silhouette, so it goes; the bag grows a tenth, centred, and its front pocket turns solid. */
function Backpack({ u, small, sw }: Art) {
  return (
    <g transform={small ? "translate(512 524) scale(1.1) translate(-536 -524)" : "translate(-20 0)"}>
      <defs>
        <Shadow id={`${u}s`} color="#060B20" far={0.5} near={0.3} />
        <linearGradient id={`${u}b`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#F7CB4C" />
          <stop offset="1" stopColor="#F2BE3A" />
        </linearGradient>
      </defs>
      {!small && (
        <g transform="translate(752 600) rotate(16)">
          <rect x="-18" y="-330" width="36" height="330" fill="#fff" />
          <rect x="6" y="-330" width="12" height="330" fill="#E3E7EE" />
          <rect x="-18" y="-338" width="36" height="14" fill="#C9CED8" />
          <path d="M-18 -338V-370a18 18 0 0 1 36 0V-338Z" fill="#F49AB0" />
        </g>
      )}
      <path
        d="M452 292C452 212 572 212 572 292"
        fill="none"
        stroke="#D9A92E"
        strokeWidth={sw(26, 1.4)}
        strokeLinecap="round"
      />
      <g filter={`url(#${u}s)`}>
        <path
          d="M282 470C282 365 367 280 472 280L552 280C657 280 742 365 742 470L742 706C742 767 693 816 632 816L392 816C331 816 282 767 282 706Z"
          fill={`url(#${u}b)`}
        />
        <path d="M282 470C282 365 367 280 472 280L552 280C657 280 742 365 742 470L742 530Q512 600 282 530Z" fill="#D9A92E" />
        <rect x="494" y="548" width="36" height="52" rx="10" fill="#fff" />
        {small ? (
          <rect x="362" y="650" width="300" height="126" rx="36" fill="#D9A92E" />
        ) : (
          <rect
            x="362"
            y="650"
            width="300"
            height="126"
            rx="36"
            fill="#D9A92E"
            fillOpacity=".16"
            stroke="#D9A92E"
            strokeWidth="14"
          />
        )}
        <rect x="718" y="560" width="72" height="230" rx="30" fill="#D9A92E" />
      </g>
    </g>
  );
}

/** The lid marks of the three closed compartments, faint blue at 64px and up: sunrise, midday and a
 * crescent moon, each drawn about 0,0, the middle of its compartment. */
const LID_MARK = [
  "M-22 8A22 22 0 0 1 22 8ZM-36 22H36M0 -24V-32M-21.2 -13.2L-26.9 -18.9M21.2 -13.2L26.9 -18.9",
  "M-16 0A16 16 0 1 0 16 0A16 16 0 1 0 -16 0ZM26 0H36M-26 0H-36M0 26V36M0 -26V-36" +
    "M18.4 18.4L25.5 25.5M-18.4 18.4L-25.5 25.5M18.4 -18.4L25.5 -25.5M-18.4 -18.4L-25.5 -25.5",
  null,
  "M-1.9 -27.9A28 28 0 1 0 25.8 10.9A24 24 0 0 1 -1.9 -27.9Z",
] as const;

/** A day's pillbox on blue: morning, midday, evening and bed, the evening lid standing open on its
 * hinge with Dad's capsule inside. Four compartments, not a week's seven: at 20px seven white slats
 * read as a barcode, and four boxes, one of them open, read as a pillbox. Below 30px a 1px capsule
 * reads as a slash, so it becomes a round coral pill 4 device pixels across and the hinge drops out.
 * Every straight edge sits on a multiple of 25.6 units, whole device pixels at 20px and 40px on a 2x
 * screen. */
function Pillbox({ u, size, small }: Art) {
  return (
    <>
      <defs>
        <Shadow id={`${u}s`} color="#0B2268" far={0.36} near={0.2} />
      </defs>
      <g filter={`url(#${u}s)`}>
        <rect x="102.4" y="409.6" width="819.2" height="281.6" rx="64" fill="#1B3F9A" />
        <path d="M537.6 409.6V332.8Q537.6 307.2 563.2 307.2H665.6Q691.2 307.2 691.2 332.8V409.6Z" fill="#DCE6FA" />
      </g>
      {[128, 332.8, 537.6, 742.4].map((x, i) =>
        i === 2 ? (
          <g key={x}>
            <rect x={x} y="435.2" width="153.6" height="230.4" rx="38.4" fill="#0E2A70" />
            {small ? (
              <circle cx="614.4" cy="588.8" r="51.2" fill="#FF7A6B" />
            ) : (
              <g transform="translate(614.4 554) rotate(35)">
                <rect x="-22" y="-75" width="44" height="150" rx="22" fill="#fff" />
                <path d="M-22 0V-53A22 22 0 0 1 22 -53V0Z" fill="#FF7A6B" />
              </g>
            )}
            {!small && <rect x={x} y="405.6" width="153.6" height="8" fill="#9FB6E8" />}
          </g>
        ) : (
          <g key={x}>
            <rect x={x} y="435.2" width="153.6" height="230.4" rx="38.4" fill={i % 2 ? "#E3EDFF" : "#FFFFFF"} />
            {size >= 64 && (
              <path
                d={LID_MARK[i] ?? ""}
                transform={`translate(${x + 76.8} 550.4)`}
                fill="#2249B8"
                stroke="#2249B8"
                strokeWidth="8"
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity=".45"
              />
            )}
          </g>
        ),
      )}
    </>
  );
}

/** A babysitter's evening on violet: a crescent moon, one star, and the roof the children sleep under.
 * An open roof line under a moon is also what a photo placeholder looks like (a mountain under a sun),
 * so below 34px the roof is a filled house with the moon's own colour in its window, and the chimney
 * goes. The house is 14 device pixels wide at 20px on a 2x screen, and its walls, eaves and apex sit
 * on multiples of 25.6 units. */
function Sitter({ u, size, sw }: Art) {
  const house = size < 34;
  return (
    <>
      <defs>
        <mask id={`${u}m`}>
          <rect width="1024" height="1024" fill="#fff" />
          <circle cx="500" cy="350" r="150" fill="#000" />
        </mask>
        <Shadow id={`${u}s`} color="#2A1B86" far={0.3} near={0.16} />
      </defs>
      <g filter={`url(#${u}s)`}>
        <circle cx="430" cy="400" r="168" fill="#FFE9A8" mask={`url(#${u}m)`} />
        <path d="M690 248Q700 290 742 300Q700 310 690 352Q680 310 638 300Q680 290 690 248Z" fill="#fff" />
        {house ? (
          <>
            <path d="M512 640L332.8 768V896H691.2V768Z" fill="#fff" fillOpacity=".95" />
            <rect x="473.6" y="793.6" width="76.8" height="76.8" fill="#FFE9A8" />
          </>
        ) : (
          <path
            d="M200 846L512 640L824 846M690 757.5V690H742V791.9"
            fill="none"
            stroke="#fff"
            strokeWidth={sw(22, 1.2)}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </g>
    </>
  );
}

/** Below 48px, where four ticks would be hairlines: the two height marks the small doorway keeps. Four
 * short ticks in a column at the casing's edge read as a notebook's spiral binding; two lines drawn
 * across the casing's face, far apart, read as pencil marks. Both centres are multiples of 128 units,
 * so the 1px lines sit on whole device pixels at 20px and at 32px on a 2x screen. */
const SMALL_MARKS = [384, 640] as const;

/** A whole doorway on a warm wall: both casings and the head, the door shut in it with its knob, and
 * on the left casing the children's heights marked in pencil as four plain ticks, long and short in
 * turn (two lines below 48px, see `SMALL_MARKS`). The casing is the object that casts the shadow, so
 * the head darkens the top of the door. The doorway stands on the floor below the icon's edge,
 * centred, and the edges of the casing, the door and the pencil lines sit on multiples of 25.6 units,
 * whole device pixels at 20px and 40px on a 2x screen. */
function Doorframe({ u, size, small, sw }: Art) {
  const line = sw(12, 1);
  return (
    <>
      <defs>
        <Shadow id={`${u}s`} color="#4A2C0E" far={0.3} near={0.16} />
      </defs>
      <rect x="307.2" y="256" width="409.6" height="768" fill="#8E6233" />
      {size >= 40 && (
        <g fill="none" stroke="#7A5226" strokeWidth="10">
          <rect x="363.2" y="320" width="297.6" height="288" rx="10" />
          <rect x="363.2" y="688" width="297.6" height="400" rx="10" />
        </g>
      )}
      <circle cx="654.8" cy="648" r={sw(24, 0.8)} fill="#F1D6A0" />
      <g filter={`url(#${u}s)`}>
        <path d="M128 1024V76.8H896V1024H716.8V256H307.2V1024Z" fill="#F4E7D3" />
      </g>
      {!small && <path d="M289.2 1024V238H734.8V1024" fill="none" stroke="#E2CDAE" strokeWidth="6" />}
      {size >= 48
        ? DOOR_MARKS.map(([y, length]) => (
            <path
              key={y}
              d={`M148 ${y}h${length}`}
              stroke="#5A3F22"
              strokeOpacity=".85"
              strokeWidth={sw(9, 0.9)}
              strokeLinecap="round"
            />
          ))
        : SMALL_MARKS.map((y) => (
            <rect key={y} x="153.6" y={y - line / 2} width="128" height={line} fill="#5A3F22" fillOpacity=".85" />
          ))}
    </>
  );
}

/** The squircle every icon is cut to: its ground, its art, and the light along its edge. A `rim`
 * lights the whole edge, brightest at the top, the way a dark glass tile catches the light. */
function Tile({
  u,
  size,
  top,
  bottom,
  rim,
  children,
}: {
  u: string;
  size: number;
  top: string;
  bottom: string;
  rim?: boolean;
  children: ReactNode;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" aria-hidden style={{ display: "block" }}>
      <defs>
        <clipPath id={`${u}c`}>
          <path d={SQUIRCLE} />
        </clipPath>
        <linearGradient id={`${u}bg`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={top} />
          <stop offset="1" stopColor={bottom} />
        </linearGradient>
        {rim ? (
          <linearGradient id={`${u}hl`} x1="0" y1="0" x2="0" y2="1024" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#fff" stopOpacity=".22" />
            <stop offset=".3" stopColor="#fff" stopOpacity=".15" />
            <stop offset="1" stopColor="#fff" stopOpacity=".1" />
          </linearGradient>
        ) : (
          <linearGradient id={`${u}hl`} x1="0" y1="0" x2="0" y2="300" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#fff" stopOpacity=".10" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
        )}
      </defs>
      <g clipPath={`url(#${u}c)`}>
        <rect width="1024" height="1024" fill={`url(#${u}bg)`} />
        {children}
      </g>
      <path
        d={SQUIRCLE}
        fill="none"
        stroke={`url(#${u}hl)`}
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
        clipPath={`url(#${u}c)`}
      />
    </svg>
  );
}

export function AppIcon({ app, size }: { app: AppId; size: number }) {
  const u = useId();
  const art: Art = { u, size, small: size <= 29, sw: (base, minPx) => Math.max(base, (minPx * 1024) / size) };
  return (
    <Tile u={u} size={size} {...GROUND[app]}>
      {app === "pinch" && <Pinch {...art} />}
      {app === "backpack" && <Backpack {...art} />}
      {app === "pillbox" && <Pillbox {...art} />}
      {app === "sitter" && <Sitter {...art} />}
      {app === "doorframe" && <Doorframe {...art} />}
    </Tile>
  );
}

/** A build arriving to be installed: an arrow down into an open tray, drawn in the 30px icon's own
 * pixels (the group scales them to the 1024 grid) with a 2px line, about half the tile across as an
 * app's glyph is. Every edge falls on a whole device pixel at 2x, and the glyph sits half a pixel
 * above the middle, where the eye puts the centre of a shape heavier at its foot. */
export function BetaIcon({ size }: { size: number }) {
  const u = useId();
  return (
    <Tile u={u} size={size} top="#4A90E2" bottom="#2F6FD0">
      <g
        transform="scale(34.1333)"
        fill="none"
        stroke="#fff"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M15 7.5V17M11.5 13.5L15 17L18.5 13.5" />
        <path d="M9 16.5V21.5H21V16.5" />
      </g>
    </Tile>
  );
}
