import type { TabFace } from './modules/manifest'

// Who a box's SMTP relay belongs to, by its host: the name and the mark the
// Email page's relay tab wears.
//
// Keyed by the host exactly as `fleet.mail.smtpHost` spells it, and only
// for hosts that are one provider's own submission server — nothing is
// inferred from a domain suffix, so a relay this map does not name keeps the
// tab's neutral face. Add a row only with the mark under public/ beside it
// (service-groups.ts's ICON_FILES, whose test checks the file exists).
//
// Client-safe: pure data.

const PROVIDERS: Record<string, TabFace> = {
  'smtp.gmail.com': { label: 'Gmail', logo: '/icon-gmail.svg' },
  'smtp.googlemail.com': { label: 'Gmail', logo: '/icon-gmail.svg' },
  'smtp.protonmail.ch': { label: 'Proton Mail', logo: '/icon-proton-mail.svg' },
}

/** The provider a relay host is, or null for one this map does not name. */
export function relayProvider(host: string | null | undefined): TabFace | null {
  if (host === null || host === undefined) return null
  return PROVIDERS[host.trim().toLowerCase()] ?? null
}

/** Every mark the map names, for the test that holds each to a file. */
export const PROVIDER_LOGOS: readonly string[] = [
  ...new Set(Object.values(PROVIDERS).map((p) => p.logo)),
]
