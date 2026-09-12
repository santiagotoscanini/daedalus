/** Per-page metadata, in one place.
 *
 * The reason this is a function and not two hand-written blocks: canonical,
 * `og:url`, `og:title`, `og:description` and the twitter pair are PER PAGE,
 * and a root route can only carry one value for each. Declared once in
 * `__root.tsx`, /docs inherited the landing page's — it announced itself as a
 * duplicate of `/` to every crawler, and a shared /docs link previewed with
 * the landing page's headline. Routes call this, so a new route cannot
 * quietly ship the same mistake.
 *
 * `description` is written to survive a search result: one sentence, under
 * ~155 characters, saying what the page is rather than how good it is.
 */

export const SITE_URL = "https://daedalus.toscanini.me";

export function pageHead(input: {
  /** Path with no trailing slash: "" for the landing page, "/docs" below it. */
  path: string;
  title: string;
  description: string;
}): {
  meta: Array<Record<string, string>>;
  links: Array<Record<string, string>>;
} {
  const url = `${SITE_URL}${input.path}`;
  return {
    meta: [
      { title: input.title },
      { name: "description", content: input.description },
      { property: "og:title", content: input.title },
      { property: "og:description", content: input.description },
      { property: "og:url", content: url },
      { name: "twitter:title", content: input.title },
      { name: "twitter:description", content: input.description },
    ],
    links: [{ rel: "canonical", href: url }],
  };
}
