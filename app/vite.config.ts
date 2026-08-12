import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// daedalus runs `vite dev` in production — deliberately. It is an internal
// control plane for one operator, so the value of editing a file and seeing the
// browser update beats the value of a built bundle. There is therefore NO Nitro
// adapter here: Nitro only exists to emit `.output/` for `vite build`, and
// including it in dev adds a Vite environment that breaks server-function id
// resolution ("Invalid server function ID" at call time, not at startup).
//
// The container bind-mounts /etc/nixos/stacks/daedalus/app at /app, so the
// files Vite watches ARE the files in the flake repo. Editing one is the whole
// deploy; `nixos-rebuild` is only needed for the .nix module or the
// Containerfile.

// Injected by the apps platform (stacks/apps/apps.nix sets APP_HOSTNAME from
// the webApp's hostname). Read rather than restated so the vhost has one source
// of truth; the fallback keeps a bare `pnpm dev` on a laptop working.
const appHost = process.env.APP_HOSTNAME ?? 'localhost'

// Node turns an unhandled rejection into an uncaught exception and exits, so
// one rejected promise in one server function took the whole dev server with
// it — and the container with that. Nothing noticed: the unit is
// `Type=oneshot` + `RemainAfterExit`, so it stayed green over a dead
// container, and daedalus is the one app whose deploy timer is masked, so no
// timer resurrected it either. Registering a listener at all is what stops
// Node's conversion to a fatal exception; the body only has to report.
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

export default defineConfig({
  resolve: { tsconfigPaths: true },

  server: {
    // The container has no host port; traefik dials app-daedalus:3000 over the
    // private iso-daedalus-net bridge, so Vite must listen on all interfaces.
    host: '0.0.0.0',
    port: 3000,
    strictPort: true,

    // Vite rejects requests whose Host header it doesn't recognise with a bare
    // 403 and no explanation. Behind traefik every request arrives with the
    // public hostname, so without this the app is unreachable while looking
    // perfectly healthy in the logs.
    allowedHosts: [appHost],

    // The HMR websocket is the one connection the browser opens on its own, so
    // it does not inherit the proxy's scheme or port — left alone the client
    // tries ws://daedalus-app.toscanini.me:3000, which nothing listens on, and HMR
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

  // Plugin order matters: Start must run before the React plugin. The guard
  // transforms nothing, so it is free to sit first.
  plugins: [keepServingOnRejection(), tanstackStart(), viteReact()],
})
