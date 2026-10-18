// Every in-page link on the prerendered site must land on an element. A hash that names no id
// scrolls nowhere and fails silently: the nav's "How it works" pointed at #talk, a section that no
// longer existed, from every page. Runs after `vite build` (package.json "build"), reads the
// prerendered HTML under dist/client, and exits 1 if any `#x` or `/page#x` has no `id="x"` on the
// page it names.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../dist/client/", import.meta.url));

/** dist/client/docs/index.html -> "/docs"; dist/client/index.html -> "/" */
function routeOf(file) {
  const rel = relative(root, file).split(sep).join("/");
  const path = rel.replace(/(^|\/)index\.html$/, "").replace(/\.html$/, "");
  return `/${path}`.replace(/\/$/, "") || "/";
}

function htmlFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    if (d.isDirectory()) return htmlFiles(p);
    return d.name.endsWith(".html") ? [p] : [];
  });
}

let files;
try {
  files = htmlFiles(root);
} catch {
  console.error(`check-anchors: no build at ${root}; run vite build first`);
  process.exit(1);
}
if (!files.some((f) => routeOf(f) === "/")) {
  console.error("check-anchors: no prerendered index.html");
  process.exit(1);
}

const pages = new Map(
  files.map((f) => {
    const html = readFileSync(f, "utf8");
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    return [routeOf(f), { html, ids }];
  }),
);

const broken = [];
let checked = 0;
for (const [route, { html }] of pages) {
  for (const [, href] of html.matchAll(/\shref="([^"]*#[^"]*)"/g)) {
    const m = /^(\/[^?#]*)?(?:\?[^#]*)?#(.+)$/.exec(href);
    if (!m) continue; // another origin, or a bare "#"
    const target = m[1] ? m[1].replace(/\/$/, "") || "/" : route;
    const hash = decodeURIComponent(m[2]);
    checked++;
    const page = pages.get(target);
    if (!page) broken.push(`${route}: ${href} (no prerendered page ${target})`);
    else if (!page.ids.has(hash)) broken.push(`${route}: ${href} (no id="${hash}" on ${target})`);
  }
}

if (broken.length > 0) {
  console.error(`check-anchors: ${broken.length} link(s) point at nothing:\n  ${[...new Set(broken)].join("\n  ")}`);
  process.exit(1);
}
console.log(`check-anchors: ${checked} in-page links across ${pages.size} pages, all resolve`);
