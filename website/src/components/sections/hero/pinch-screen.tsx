/** Phone B's last layer: Pinch, open on Grandma's Lentil Soup. One still screen proves the request
 * was heard: her handwritten card at the top, the same recipe typed out under it (so "lentils" is
 * searchable), and the family's notes, over a floating tab bar. iOS light mode in Pinch's own warm
 * colours, at iOS sizes x 0.761 (a 402pt screen drawn 306px wide).
 *
 * This is the hero's final frame: what the prerender, reduced motion and no-JS show. With motion it
 * opens out of its Home Screen icon (hero.css, `.pinch-open`). Styles: `.pinch*` in hero.css. */

import { HerCard } from "./her-card";

const TYPED = ["1 cup lentils", "1 onion, chopped", "2 carrots", "Cumin, a pinch", "Salt, a pinch"];

const NOTES = [
  { who: "Dad", text: "Her pinch was a tablespoon." },
  { who: "Sofi", text: "Made it Sunday. Doubled the carrots." },
];

/** Tab glyphs on an 18-unit grid, stroked in the label's colour. */
const TABS = [
  {
    label: "Recipes",
    glyph: (
      <path d="M3 3.5C3 2.7 3.7 2 4.5 2H13v13H4.5C3.7 15 3 15.7 3 16.5V3.5Zm0 13c0-.8.7-1.5 1.5-1.5H13v3H4.5c-.8 0-1.5-.7-1.5-1.5Z" />
    ),
  },
  {
    label: "Scan",
    glyph: (
      <>
        <path d="M2 6V3.5C2 2.7 2.7 2 3.5 2H6M12 2h2.5c.8 0 1.5.7 1.5 1.5V6M16 12v2.5c0 .8-.7 1.5-1.5 1.5H12M6 16H3.5C2.7 16 2 15.3 2 14.5V12" />
        <circle cx="9" cy="9" r="2.6" />
      </>
    ),
  },
  {
    label: "Family",
    glyph: (
      <path d="M6.5 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm-4.5 7c0-2.5 2-4.5 4.5-4.5S11 12.5 11 15M12.5 8.5a2 2 0 1 0 0-4M13 10.6c1.8.4 3 2 3 3.9" />
    ),
  },
];

export function PinchScreen() {
  return (
    <div className="pinch selection-warm">
      <div className="pinch-nav">
        <span className="pinch-back">
          <svg width="8" height="13" viewBox="0 0 8 13" fill="none" aria-hidden>
            <path d="M6.75 1.25 1.5 6.5l5.25 5.25" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Recipes
        </span>
        <svg className="pinch-share" width="13" height="15" viewBox="0 0 16 18.5" fill="none" aria-hidden>
          <path
            d="M8 1v11M4.5 4.5 8 1l3.5 3.5M3 8H1.5v9.5h13V8H13"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>

      <p className="pinch-title">Lentil Soup</p>
      <p className="pinch-byline">
        <span className="pinch-chip">G</span>
        Grandma’s card
      </p>

      <div className="pinch-card">
        <HerCard />
      </div>

      <p className="pinch-head pinch-head-typed">Typed from her card</p>
      <ul className="pinch-cell pinch-typed">
        {TYPED.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>

      <p className="pinch-head pinch-head-notes">Notes</p>
      <ul className="pinch-cell pinch-notes">
        {NOTES.map((n) => (
          <li key={n.who}>
            <span className="pinch-chip pinch-chip-note">{n.who[0]}</span>
            <span>
              <span className="pinch-note-who">{n.who}</span>
              <span className="pinch-note-text">{n.text}</span>
            </span>
          </li>
        ))}
      </ul>

      <div className="pinch-tabs">
        {TABS.map((t, i) => (
          <span key={t.label} className="pinch-tab" data-on={i === 0 ? "" : undefined}>
            <svg width="17" height="17" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              {t.glyph}
            </svg>
            {t.label}
          </span>
        ))}
      </div>
    </div>
  );
}
