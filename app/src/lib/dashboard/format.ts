// Value formatting for everything under the category pages.
//
// This lives on the SERVER side of the boundary on purpose. The unit is part
// of what a source means — `myspeed_download` is Mbps, `container_memory_
// usage_bytes` is bytes, a Jellyfin tick is 100ns — and the component that
// renders a number has no way to know which. Formatting where the number is
// read keeps that knowledge next to the query that produced it.
//
// Every helper takes null/undefined and renders an em dash, because "could not
// read this" is a real and common state on a page that talks to thirty
// services, and it must never look like a zero.

export const DASH = '—'

export function num(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH
  return v.toLocaleString('en-US', { maximumFractionDigits: digits })
}

export function bytes(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let n = v
  let u = 0
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024
    u++
  }
  return `${n.toFixed(n >= 10 || u === 0 ? 0 : 1)} ${units[u] ?? 'B'}`
}

export function rate(v: number | null | undefined): string {
  return v === null || v === undefined ? DASH : `${bytes(v)}/s`
}

export function text(v: string | null | undefined): string {
  return v === null || v === undefined || v === '' ? DASH : v
}

export function pct(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH
  return `${v.toFixed(digits)}%`
}

/**
 * A duration as the largest unit that still says something true.
 *
 * Deliberately one unit, not two: "3h 42m" is a measurement, "3h" is a glance,
 * and every caller here is a glance. The exception is the sub-minute range,
 * where "0h" would be actively wrong and "just now" is what a person means.
 */
export function since(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return DASH
  if (seconds < 45) return 'just now'
  if (seconds < 5400) return `${String(Math.round(seconds / 60))} min ago`
  if (seconds < 172800) return `${String(Math.round(seconds / 3600))}h ago`
  if (seconds < 63072000) return `${String(Math.round(seconds / 86400))}d ago`
  return `${String(Math.round(seconds / 31536000))}y ago`
}

/** A countdown, same one-unit rule as `since`. */
export function until(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return DASH
  if (seconds <= 0) return 'now'
  if (seconds < 90) return `${String(Math.round(seconds))}s`
  if (seconds < 5400) return `${String(Math.round(seconds / 60))} min`
  if (seconds < 172800) return `${String(Math.round(seconds / 3600))}h`
  return `${String(Math.round(seconds / 86400))}d`
}

/** Country name → flag. Same remap the homepage gluetun widgets carried. */
export function flag(country: string | undefined | null): string {
  const F: Record<string, string> = {
    Switzerland: '🇨🇭',
    'United States': '🇺🇸',
    'United Kingdom': '🇬🇧',
    Netherlands: '🇳🇱',
    Germany: '🇩🇪',
    France: '🇫🇷',
    Spain: '🇪🇸',
    Italy: '🇮🇹',
    Sweden: '🇸🇪',
    Norway: '🇳🇴',
    Finland: '🇫🇮',
    Denmark: '🇩🇰',
    Iceland: '🇮🇸',
    Ireland: '🇮🇪',
    Austria: '🇦🇹',
    Belgium: '🇧🇪',
    Poland: '🇵🇱',
    Romania: '🇷🇴',
    Portugal: '🇵🇹',
    Canada: '🇨🇦',
    Japan: '🇯🇵',
    Singapore: '🇸🇬',
    'Hong Kong': '🇭🇰',
    Australia: '🇦🇺',
    Argentina: '🇦🇷',
    Brazil: '🇧🇷',
  }
  if (country === undefined || country === null || country === '') return DASH
  return `${F[country] ?? '🌐'} ${country}`
}

/** Per-service API keys, rendered to /run/daedalus-dashboard/env by nix. */
export const key = (name: string): string => process.env[`DASH_${name}`] ?? ''
