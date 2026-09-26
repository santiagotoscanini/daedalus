import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// One image, two ways to run it (docker-entrypoint.sh picks). In dev mode
// (`fleet.daedalus.dev`, the host that develops the engine) the container
// bind-mounts this repository's `app/` at /app and runs `vite dev` against
// it, so editing a file is the whole deploy; `nixos-rebuild` is only needed
// for nix/stacks/daedalus/ or the Dockerfile and its entrypoint. Every other
// host runs the published image: `vite build`, then `server.mjs` as the
// listener (its header says why no adapter). There is NO Nitro adapter here
// either: including it in dev adds a Vite environment that breaks
// server-function id resolution ("Invalid server function ID" at call time,
// not at startup).
//
// Server-function ids differ between the two — path-derived in dev, sha256 in
// a build — and that is fine: a build derives both sides from
// sha256(file--function), and `scripts/check-build.mjs` fails the build if
// they ever disagree.

// Injected by the apps platform (nix/modules/apps/apps.nix sets APP_HOSTNAME from
// the webApp's hostname). Read rather than restated so the vhost has one source
// of truth; the fallback keeps a bare `pnpm dev` on a laptop working.
const appHost = process.env.APP_HOSTNAME ?? 'localhost'

// A rename in progress: the old address keeps being served (fleet.webApps
// aliases) until the operator confirms the new one, so Vite accepts both.
const appHostAliases = (process.env.APP_HOSTNAME_ALIASES ?? '').split(',').filter((h) => h !== '')

// Node turns an unhandled rejection into an uncaught exception and exits, so
// one rejected promise in one server function would take the whole dev server
// with it — and the container with that. Nothing would notice: the unit is
// `Type=oneshot` + `RemainAfterExit`, so it stays green over a dead
// container, and dev mode suppresses the app's deploy timer, so no timer
// resurrects it either. Registering a listener at all is what stops Node's
// conversion to a fatal exception; the body only has to report.
//
// Seen in the wild: Vite's SSR module runner failing to load a category data
// module mid-HMR, surfacing as ERR_LOAD_URL out of a server function. That
// request deserves to fail. The process does not.
//
// Registered from `configureServer` because that runs in the Node process
// that serves requests. The symbol survives an SSR program reload, which
// re-evaluates modules without restarting the process — without it, every
// reload would stack another listener until Node warns about a leak.
const REJECTION_GUARD = Symbol.for('daedalus.unhandledRejectionGuard')

function keepServingOnRejection(): Plugin {
  return {
    name: 'daedalus:keep-serving-on-rejection',
    apply: 'serve',
    configureServer() {
      const g = globalThis as unknown as Record<symbol, true | undefined>
      if (g[REJECTION_GUARD]) return
      g[REJECTION_GUARD] = true

      process.on('unhandledRejection', (reason) => {
        // console.error, not a logger: this is the Vite dev process itself,
        // whose stdout is what podman ships to journald and Loki.
        console.error('[daedalus] unhandled rejection — kept serving:', reason)
      })
    },
  }
}

export default defineConfig(({ command }) => ({
  resolve: { tsconfigPaths: true },

  ssr: {
    // lucide-react publishes no `exports` map — just `main` (CJS) and
    // `module` (ESM). Left external, the SSR runner resolves `main` and gets
    // a CJS build that `require`s its own copy of React, while the browser
    // loads the ESM one. Two React instances in one tree, and every page
    // importing an icon dies on hydration with "Invalid hook call" —
    // server-rendered HTML that looks perfect over a page that never becomes
    // interactive. Bundling it for SSR is what makes both sides share the
    // one React.
    //
    // A build bundles EVERY dependency into `dist/server`, so the runtime
    // image carries no React, router, radix or zod — only what cannot be
    // bundled (argon2 is a native addon) and what `server.mjs` imports itself.
    // Build-only: in dev it would push all of node_modules through the SSR
    // transform for nothing.
    noExternal: command === 'build' ? true : ['lucide-react'],
    external: command === 'build' ? ['@node-rs/argon2'] : [],
  },

  server: {
    // The container has no host port; traefik dials app-daedalus:3000 over the
    // private iso-daedalus-net bridge, so Vite must listen on all interfaces.
    host: '0.0.0.0',
    port: 3000,
    strictPort: true,

    // Vite rejects requests whose Host header it doesn't recognise with a bare
    // 403 and no explanation. Behind traefik every request arrives with the
    // public hostname, so without this the app is unreachable while looking
    // perfectly healthy in the logs. `app-daedalus` is the under-the-gate
    // door: shotter joins iso-daedalus-net and dials the container by name
    // for visual verification the SSO gate would otherwise block.
    //
    // APP_EXTRA_HOSTS: other public names routed to this server, such as the
    // GitHub webhook's `hooks.<baseDomain>`, bound by daedalus.nix.
    // Comma-separated; unset or empty adds nothing.
    allowedHosts: [
      appHost,
      ...appHostAliases,
      'app-daedalus',
      ...(process.env.APP_EXTRA_HOSTS ?? '')
        .split(',')
        .map((h) => h.trim())
        .filter((h) => h !== ''),
    ],

    // The HMR websocket is the one connection the browser opens on its own, so
    // it does not inherit the proxy's scheme or port — left alone the client
    // tries ws://<APP_HOSTNAME>:3000, which nothing listens on, and HMR
    // silently degrades to full page reloads. Point it back at traefik's TLS
    // entrypoint instead.
    hmr: {
      protocol: 'wss',
      host: appHost,
      clientPort: 443,
    },

    // inotify propagates through podman bind mounts, so the default watcher
    // sees host edits. If saves ever stop triggering a reload, `usePolling:
    // true` here is the fallback — it costs CPU, so don't enable it blind.
    watch: {
      ignored: ['**/.pnpm-store/**', '**/.corepack/**'],
    },
  },

  // Plugin order: Start must run before React. Tailwind is a CSS transform
  // with no opinion about the others, and the guard transforms nothing, so
  // both are free to sit first.
  plugins: [keepServingOnRejection(), tailwindcss(), tanstackStart(), viteReact()],
}))
