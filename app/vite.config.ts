import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

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
    // tries ws://daedalus.toscanini.me:3000, which nothing listens on, and HMR
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

  // Plugin order matters: Start must run before the React plugin.
  plugins: [tanstackStart(), viteReact()],
})
