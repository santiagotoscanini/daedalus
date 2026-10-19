import { createRootRoute, HeadContent, Scripts, ScriptOnce, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { Footer } from "~/components/footer";
import { Nav } from "~/components/nav";
import { NotFound } from "~/components/not-found";

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
      { name: "theme-color", content: "#08090a" },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "daedalus" },
      { property: "og:image", content: `${SITE_URL}/og.png` },
      {
        property: "og:image:alt",
        content:
          "daedalus. Your own cloud, at home: two iPhones, a request for a recipe app and the app arriving on Grandma’s phone. Talking to the house like this is next.",
      },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:image", content: `${SITE_URL}/og.png` },
    ],
    links: [
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
      { rel: "icon", href: "/favicon.png", type: "image/png" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
    ],
  }),
  shellComponent: RootDocument,
  notFoundComponent: NotFound,
});

/** The motion switch (components/landing/motion.ts), run before the first paint: `data-js`, and
 * `data-motion="on"` unless the reader asked for reduced motion, so each figure can paint its start
 * state from the first frame. If the app has not hydrated in 6s (the bundle blocked or failed), both
 * come off again and every figure shows its final frame. ScriptOnce emits it on the server only and
 * the script removes itself, so hydration never sees it. */
const BOOT =
  "(function(d){d=document.documentElement;d.setAttribute('data-js','');" +
  "if(matchMedia('(prefers-reduced-motion: no-preference)').matches)d.setAttribute('data-motion','on');" +
  "setTimeout(function(){if(!window.__hydrated){d.removeAttribute('data-js');d.removeAttribute('data-motion')}},6000)})()";

function RootDocument({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    window.__hydrated = true;
  }, []);
  // GitHub Pages serves /404.html at whatever address was asked for, and the router would match that
  // address, not /404.html: hydrating there could only fail. The page is a heading and a link, so it
  // ships as plain HTML; the nav's sheet still opens, since it is a <details>.
  const staticPage = useRouterState({ select: (s) => s.matches.some((m) => m.routeId === "/404.html") });
  return (
    <html lang="en" className="bg-page" suppressHydrationWarning>
      <head>
        <ScriptOnce>{BOOT}</ScriptOnce>
        {/* After the switch, and in place: given through `links`, React hoists the sheet as a resource
            above every plain head child, and the switch then waited for the stylesheet to download */}
        <link rel="stylesheet" href={stylesCss} />
        <HeadContent />
      </head>
      <body className="bg-page text-ink-1 antialiased">
        {/* shown under the bar on the content's edge when a keyboard reaches it (styles.css) */}
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <Nav />
        {children}
        <Footer />
        {staticPage ? null : <Scripts />}
      </body>
    </html>
  );
}
