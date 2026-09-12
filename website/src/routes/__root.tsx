import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { Footer } from "~/components/footer";
import { Nav } from "~/components/nav";

// Imported as ?url and declared as a <link> below — a bare CSS import is
// injected by JS after the client bundle evaluates, so the SSR document
// would arrive unstyled and repaint.
import stylesCss from "../styles.css?url";
import { SITE_URL } from "~/site-head";

// Only tags that are byte-identical on EVERY page belong here. Anything a
// page OWNS — title, description, canonical, and the og/twitter pair that
// carries them — is built by `pageHead` in the route itself. Declared here,
// they were inherited: /docs shipped a canonical pointing at `/` and previewed
// with the landing page's headline. See src/site-head.ts.
export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "theme-color", content: "#08080a" },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "daedalus" },
      { property: "og:image", content: `${SITE_URL}/og.png` },
      { property: "og:image:alt", content: "The daedalus mark: a square labyrinth drawn in ember." },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:image", content: `${SITE_URL}/og.png` },
    ],
    links: [
      { rel: "stylesheet", href: stylesCss },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
      { rel: "icon", href: "/favicon.png", type: "image/png" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
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
