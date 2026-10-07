import { Logo } from "~/components/logo";
import { MARKS } from "~/components/walk/marks";
import { BRAND } from "~/data/brand-marks";
import type { Service } from "~/data/services";

/** A service's mark, or its monogram when simple-icons has none. In the
 * current text colour; the tile around it carries the tier. */
export function Glyph({ s, size = 28 }: { s: Service; size?: number }) {
  if (s.mark === "daedalus") return <Logo size={size} />;
  const d = s.mark ? ({ ...MARKS, ...BRAND } as Record<string, string>)[s.mark] : undefined;
  if (d) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d={d} />
      </svg>
    );
  }
  return (
    <span className="uv-mono" style={{ fontSize: size * 0.62 }}>
      {s.mono ?? s.name.slice(0, 2)}
    </span>
  );
}
