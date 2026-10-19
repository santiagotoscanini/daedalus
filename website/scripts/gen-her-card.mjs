// Grandma's handwriting on her recipe card in the hero (components/sections/hero/her-card.tsx), as
// static filled outlines. Run once, offline; the page never loads a font for it. The card has to say
// the same words as the typed list under it, so the ink is real letters set in Homemade Apple
// (Font Diner, Apache-2.0, google/fonts apache/homemadeapple), not generated scribble.
//
// Regenerate (no node on the host; opentype.js is installed outside the repo, in the container):
//   podman run --rm --dns 8.8.8.8 -v ~/projects/daedalus:/r docker.io/library/node:24 bash -c \
//     'mkdir /tmp/g && cd /tmp/g && npm init -y >/dev/null && npm i opentype.js@1.3.4 >/dev/null && \
//      node /r/website/scripts/gen-her-card.mjs'
// It writes src/components/sections/hero/her-card-paths.ts. A photo of a real card, vectorised
// (potrace), can replace that file's export with no other change.

import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const FONT_URL = "https://raw.githubusercontent.com/google/fonts/main/apache/homemadeapple/HomemadeApple-Regular.ttf";
const OUT = new URL("../src/components/sections/hero/her-card-paths.ts", import.meta.url);

// opentype.js lives in the directory the script is run from (see above), never in website/
const opentype = createRequire(join(process.cwd(), "noop.js"))("opentype.js");

// Cap heights in card units: the spec asks 13 and 9.5; this face has a very small x-height, so the
// ingredients go up a step (its lowercase is then about 5 units tall) to stay readable at 1x.
const ITEM_CAP = 10.5;

// In card units (the card is 274 x 164; the blue rules sit at 54, 74 ... 154, the red one at 34).
// Each line turns a little about its own start and sits a little off its line, alternating, the
// way a hand moves down an index card. The values are fixed, so the output never changes.
const TITLE = { text: "Lentil Soup", cap: 13.5, x: 14, base: 27, rot: -0.4, jit: 0, space: 2 };
const ITEMS = [
  { text: "1 cup lentils", rot: 0.6, jit: 0.4 },
  { text: "1 onion, chopped", rot: -0.6, jit: -0.6 },
  { text: "2 carrots", rot: 0.6, jit: 0.8 },
  { text: "Cumin, a pinch", rot: -0.6, jit: -0.3 },
  { text: "Salt, a pinch", rot: 0.6, jit: 0.5 },
].map((l, i) => ({ ...l, cap: ITEM_CAP, x: 16, base: 52 + 20 * i, space: 1.3 }));

const res = await fetch(FONT_URL);
if (!res.ok) throw new Error(`font: HTTP ${res.status}`);
const font = opentype.parse(await res.arrayBuffer());

/** Font size that gives `cap` units of height above the baseline, measured on real glyphs. */
function sizeFor(cap, refs) {
  const tops = refs.map((ch) => font.charToGlyph(ch).getBoundingBox().y2);
  const top = tops.reduce((a, b) => a + b, 0) / tops.length;
  return (cap * font.unitsPerEm) / top;
}
const SIZE_TITLE = sizeFor(TITLE.cap, ["L"]);
const SIZE_ITEM = sizeFor(ITEM_CAP, ["1", "C", "S"]);

// The font is an autotrace: hundreds of tiny curves per letter, far finer than a 10px letter can
// show. Each contour is flattened to points 0.1 apart and thinned (Ramer-Douglas-Peucker) to within
// EPS of the true outline, a twentieth of a CSS pixel, which no screen resolves.
const EPS = 0.06;
const STEP = 0.1;

/** Ramer-Douglas-Peucker on an open polyline; keeps both ends. */
function thin(pts) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    const [ax, ay] = pts[i];
    const [bx, by] = pts[j];
    const len = Math.hypot(bx - ax, by - ay);
    let far = -1;
    let at = -1;
    for (let k = i + 1; k < j; k++) {
      const [px, py] = pts[k];
      // a closed contour starts and ends on one point: measure from that point instead
      const d = len < 1e-6 ? Math.hypot(px - ax, py - ay) : Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len;
      if (d > far) [far, at] = [d, k];
    }
    if (far > EPS) {
      keep[at] = 1;
      stack.push([i, at], [at, j]);
    }
  }
  return pts.filter((_, k) => keep[k]);
}

/** Points along one contour's commands, STEP apart or closer. */
function flatten(cmds) {
  const pts = [];
  let [x, y] = [0, 0];
  for (const cmd of cmds) {
    if (cmd.type === "M" || cmd.type === "L") {
      [x, y] = [cmd.x, cmd.y];
      pts.push([x, y]);
      continue;
    }
    const [x0, y0] = [x, y];
    const curve =
      cmd.type === "Q"
        ? (t) => {
            const u = 1 - t;
            return [u * u * x0 + 2 * u * t * cmd.x1 + t * t * cmd.x, u * u * y0 + 2 * u * t * cmd.y1 + t * t * cmd.y];
          }
        : (t) => {
            const u = 1 - t;
            const [a, b, c, d] = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
            return [a * x0 + b * cmd.x1 + c * cmd.x2 + d * cmd.x, a * y0 + b * cmd.y1 + c * cmd.y2 + d * cmd.y];
          };
    const hull =
      cmd.type === "Q"
        ? Math.hypot(cmd.x1 - x0, cmd.y1 - y0) + Math.hypot(cmd.x - cmd.x1, cmd.y - cmd.y1)
        : Math.hypot(cmd.x1 - x0, cmd.y1 - y0) +
          Math.hypot(cmd.x2 - cmd.x1, cmd.y2 - cmd.y1) +
          Math.hypot(cmd.x - cmd.x2, cmd.y - cmd.y2);
    const n = Math.max(1, Math.ceil(hull / STEP));
    for (let k = 1; k <= n; k++) pts.push(curve(k / n));
    [x, y] = [cmd.x, cmd.y];
  }
  return pts;
}

/** "-0.3" -> "-.3", "0.4" -> ".4": path data only. */
const num = (v) => {
  const s = String(Math.round(v * 10) / 10);
  return s === "-0" ? "0" : s.replace(/^(-?)0\./, "$1.");
};

/** One line's outline as relative path data, turned `rot` degrees about (x, base) and dropped `jit`. */
function line({ text, x, base, rot, jit, space }, size) {
  // word by word, so a word space can be widened: this face sets them so tight that a swash capital
  // runs into the word before it ("LentilSoup")
  const path = new opentype.Path();
  let pen = x;
  for (const word of text.split(" ")) {
    path.extend(font.getPath(word, pen, base + jit, size, { kerning: true }));
    pen += font.getAdvanceWidth(word, size, { kerning: true }) + font.getAdvanceWidth(" ", size) * space;
  }
  const a = (rot * Math.PI) / 180;
  const [c, s] = [Math.cos(a), Math.sin(a)];
  const T = ([px, py]) => {
    const dx = px - x;
    const dy = py - base;
    return [x + dx * c - dy * s, base + dx * s + dy * c];
  };
  const contours = [];
  let cur = [];
  for (const cmd of path.commands) {
    if (cmd.type === "Z") {
      if (cur.length) contours.push(cur);
      cur = [];
    } else cur.push(cmd);
  }
  if (cur.length) contours.push(cur);

  // absolute points rounded first, so the relative steps add back up exactly to rounded positions
  let [cx, cy] = [0, 0];
  let points = 0;
  const out = [];
  for (const contour of contours) {
    const pts = thin(flatten(contour).map(T)).map(([px, py]) => [Math.round(px * 10) / 10, Math.round(py * 10) / 10]);
    const dedup = pts.filter((p, k) => k === 0 || p[0] !== pts[k - 1][0] || p[1] !== pts[k - 1][1]);
    if (dedup.length > 1 && dedup[0][0] === dedup.at(-1)[0] && dedup[0][1] === dedup.at(-1)[1]) dedup.pop();
    if (dedup.length < 3) continue;
    points += dedup.length;
    let d = "";
    for (const [k, [px, py]] of dedup.entries()) {
      const [sx, sy] = [num(px - cx), num(py - cy)];
      const step = sx + (sy.startsWith("-") ? "" : " ") + sy;
      d += k === 0 ? `m${step}` : k === 1 ? `l${step}` : (step.startsWith("-") ? "" : " ") + step;
      [cx, cy] = [px, py];
    }
    out.push(`${d}z`);
    [cx, cy] = dedup[0];
  }
  const bb = path.getBoundingBox();
  return { d: out.join(""), points, right: bb.x2, top: bb.y1, bottom: bb.y2 };
}

const lines = [line(TITLE, SIZE_TITLE), ...ITEMS.map((l) => line(l, SIZE_ITEM))];
for (const [i, l] of lines.entries()) {
  const src = i === 0 ? TITLE : ITEMS[i - 1];
  console.log(
    `${src.text.padEnd(18)} right ${l.right.toFixed(1)}  top ${l.top.toFixed(1)}  bottom ${l.bottom.toFixed(1)}  ${l.points} points, ${l.d.length} chars`,
  );
}
console.log(`sizes: title ${SIZE_TITLE.toFixed(2)}px, items ${SIZE_ITEM.toFixed(2)}px`);

const ts = `/** GENERATED by scripts/gen-her-card.mjs; do not edit by hand.
 *
 * Grandma's handwriting on her card, in card units (274 x 164): "${TITLE.text}" with a cap height of
 * ${TITLE.cap} on baseline ${TITLE.base}, then the five ingredients with a cap height of ${ITEM_CAP} on baselines 52 to 132,
 * each line turned and dropped a little about its start. Filled outlines of Homemade Apple
 * (Font Diner, Apache License 2.0, github.com/google/fonts/tree/main/apache/homemadeapple), so
 * no font is loaded at runtime. Regenerate with the command at the top of the script. */

export const HER_CARD_INK: readonly string[] = [
${lines.map((l) => `  "${l.d}",`).join("\n")}
];
`;
writeFileSync(OUT, ts);
console.log(`wrote ${OUT.pathname} (${ts.length} bytes)`);
