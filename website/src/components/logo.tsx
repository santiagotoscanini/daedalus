/** The daedalus mark — the app icon inlined: a terracotta rounded square
 * carrying the square labyrinth as a single unbroken off-white stroke. */
export function Logo({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className} aria-hidden>
      <rect width="32" height="32" rx="7" fill="#e2795a" />
      <path
        d="M16 16 L16 20 L12 20 L12 12 L20 12 L20 24 L8 24 L8 8 L24 8 L24 28 L4 28 L4 4 L28 4"
        stroke="#fdf3ef"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
