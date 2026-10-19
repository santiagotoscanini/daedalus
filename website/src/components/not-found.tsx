import { Link } from "@tanstack/react-router";

/** The not-found page, in the landing's own voice: one centred heading, one line, one way back.
 * Used twice with the same markup: as the root's notFoundComponent (a bad link followed inside the
 * site) and as /404.html, which GitHub Pages serves for any address it does not have. The block
 * sits a little above the middle of the space the nav and footer leave, where the eye centres it. */
export function NotFound() {
  return (
    <main id="main" className="wrap flex min-h-[calc(100svh-114px)] sm:min-h-[calc(100svh-73px)] flex-col items-center justify-center pb-12 pt-16">
      <h1 className="t-h2">Nothing lives here.</h1>
      <p className="t-intro mt-5">The page you asked for isn’t on this site.</p>
      <Link to="/" activeProps={{}} className="btn btn-secondary mt-8">
        Back to daedalus
      </Link>
    </main>
  );
}
