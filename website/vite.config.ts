import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact, { reactCompilerPreset } from "@vitejs/plugin-react";
import { readdirSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";

/** The landing's catalog tier is a claim about nix/modules, so the build checks it: every module
 * directory is on the page, and every catalog tile names one that exists. A module that lands, or
 * one that moves out, fails the build until src/data/services.ts says so. */
function inventory(): Plugin {
  return {
    name: "daedalus-inventory",
    async buildStart() {
      const { SERVICES } = await import("./src/data/services.ts");
      const dirs = readdirSync(new URL("../nix/modules", import.meta.url), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      const named = new Set(SERVICES.flatMap((s) => (s.module ? [s.module] : [])));
      const missing = dirs.filter((d) => !named.has(d));
      const stale = [...named].filter((m) => !dirs.includes(m));
      if (missing.length > 0 || stale.length > 0) {
        throw new Error(
          `src/data/services.ts disagrees with nix/modules. Not on the page: [${missing.join(", ")}]. Not a module: [${stale.join(", ")}].`,
        );
      }
    },
  };
}

// The site deploys as STATIC HTML to GitHub Pages: `prerender` renders every
// route to plain .html at build time (crawlLinks walks the internal links),
// and the deploy workflow publishes dist/client. There is no server anywhere
// — TanStack Start is used here for its SSR-quality build-time rendering,
// then the pages hydrate into a normal SPA in the browser.
//
// Tailwind v4 is a Vite plugin — no PostCSS step; the scanned directories are
// declared by @source in src/styles.css, not here.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  // Plugin order matters: tailwind → tanstackStart → viteReact (Start must
  // run before the React plugin).
  plugins: [
    inventory(),
    tailwindcss(),
    tanstackStart({
      prerender: {
        enabled: true,
        crawlLinks: true,
      },
    }),
    viteReact(),
    // React Compiler. A SEPARATE plugin, not an option on viteReact —
    // @vitejs/plugin-react v6 moved its transform to oxc and silently ignores
    // the v4-era `babel` option. The compiler runtime ships inside React 19.
    babel({ presets: [reactCompilerPreset()] }),
  ],
});
