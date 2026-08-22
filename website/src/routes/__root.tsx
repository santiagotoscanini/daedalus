import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { Footer } from "~/components/footer";
import { Nav } from "~/components/nav";

// Imported as ?url and declared as a <link> below — a bare CSS import is
// injected by JS after the client bundle evaluates, so the SSR document
// would arrive unstyled and repaint.
import stylesCss from "../styles.css?url";

const SITE_URL = "https://daedalus.toscanini.me";
const TITLE = "Daedalus — build yourself a cloud";
const DESCRIPTION =
  "Daedalus is an open-source personal cloud platform: push-to-deploy, managed Postgres, single sign-on, monitoring and backups on one box you own — your own Vercel, your own AWS, with NixOS as the reproducible backend.";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { name: "theme-color", content: "#08080a" },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "daedalus" },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:url", content: SITE_URL },
      { property: "og:image", content: `${SITE_URL}/og.png` },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: TITLE },
      { name: "twitter:description", content: DESCRIPTION },
      { name: "twitter:image", content: `${SITE_URL}/og.png` },
    ],
    links: [
      { rel: "stylesheet", href: stylesCss },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
      { rel: "icon", href: "/favicon.png", type: "image/png" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
      { rel: "canonical", href: SITE_URL },
    ],
  }),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="bg-app">
      <head>
        <HeadContent />
      </head>
      <body className="bg-app text-fg antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-panel focus:px-3 focus:py-2"
        >
          Skip to content
        </a>
        <div className="grain" aria-hidden />
        <Nav />
        {children}
        <Footer />
        <Scripts />
      </body>
    </html>
  );
}
