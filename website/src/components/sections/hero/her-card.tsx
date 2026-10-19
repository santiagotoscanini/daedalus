/** Grandma's recipe card as Pinch scanned it: a ruled cream index card, a little crooked, with her
 * handwriting and one old coffee ring. The handwriting says exactly what the typed list under it
 * says, because that is the promise ("keep her handwriting", and search it): it is real letters,
 * outlines of Homemade Apple committed as path data (her-card-paths.ts, made by
 * scripts/gen-her-card.mjs), so no font loads. A photo of a real card can replace that file.
 * Drawn in card units, 274 x 164 CSS px. Styles: styles/landing/hero.css, `.her-card`. */

import { HER_CARD_INK } from "./her-card-paths";

const BLUE_RULES = [54, 74, 94, 114, 134, 154];

export function HerCard() {
  return (
    <div className="her-card">
      <svg width="274" height="164" viewBox="0 0 274 164" aria-hidden>
        <rect x="0" y="33.4" width="274" height="1.2" fill="#E2483A" />
        {BLUE_RULES.map((y) => (
          <rect key={y} x="0" y={y - 0.4} width="274" height="0.8" fill="#A9C2DE" />
        ))}
        <g fill="#4A2E1F" fillOpacity=".92">
          {HER_CARD_INK.map((d, i) => (
            <path key={i} d={d} />
          ))}
        </g>
        {/* where a mug once stood */}
        <g fill="none" stroke="#C99A62">
          <ellipse cx="236" cy="122" rx="18" ry="16.5" transform="rotate(-18 236 122)" strokeOpacity=".38" strokeWidth="2.2" />
          <path d="M221 113A15.5 14.5 -18 0 1 249 116" strokeOpacity=".22" strokeWidth="1.2" />
        </g>
      </svg>
    </div>
  );
}
