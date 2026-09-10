import type { SiteField } from '../core/site'
import type { SiteDocument } from '../core/site/file'

// The client half of editing site.json: reading a dotted field out of the
// document, and the light, local validators the inputs run before a save.
//
// The server is the real validator — it decodes the whole document and
// refuses a bad type — so what is checked here is only what turns a red
// input box into the difference between "fix the typo" and "failed rebuild":
// an address that is not an address, a hostname that is not hostname-shaped,
// a lease dnsmasq would reject at startup. Nothing here reaches for node.

export function getSiteField(doc: SiteDocument, field: SiteField): unknown {
  return field.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], doc)
}

const OCTET = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/

/** A dotted quad. */
export function ipv4Error(value: string): string | null {
  const v = value.trim()
  if (v === '') return 'an address is required.'
  const parts = v.split('.')
  if (parts.length !== 4 || !parts.every((p) => OCTET.test(p))) {
    return 'not an IPv4 address — four numbers 0–255, dotted.'
  }
  return null
}

/** One label: letters, digits, inner hyphens. */
const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i

/** Hostname-shaped: labels joined by dots, 253 characters at most. */
export function hostnameShapeError(value: string): string | null {
  const v = value.trim()
  if (v === '') return 'a hostname is required.'
  if (v.length > 253) return 'too long for a hostname.'
  if (!v.split('.').every((l) => l.length > 0 && l.length <= 63 && LABEL.test(l))) {
    return 'not hostname-shaped — labels of letters, digits and inner hyphens, joined by dots.'
  }
  return null
}

/** A domain the box publishes under: at least two labels. */
export function baseDomainError(value: string): string | null {
  const shape = hostnameShapeError(value)
  if (shape !== null) return shape
  if (!value.trim().includes('.')) return 'needs at least two labels, like example.net.'
  return null
}

/** dnsmasq's lease syntax: a number with an optional unit, or `infinite`. */
export function leaseTimeError(value: string): string | null {
  const v = value.trim()
  if (v === '') return 'a lease time is required.'
  if (!/^\d+[smhdw]?$/.test(v) && v !== 'infinite') {
    return 'dnsmasq wants a number with an optional s/m/h/d/w unit, or `infinite`.'
  }
  return null
}

/** A Linux interface name: 1–15 characters, no whitespace or slash. */
export function interfaceError(value: string): string | null {
  const v = value.trim()
  if (v === '') return null // null in the document: "let the kernel pick"
  if (v.length > 15 || /[\s/]/.test(v)) return 'not an interface name — 15 characters at most.'
  return null
}

/** An address, loosely: something@something. */
export function mailAddressError(value: string): string | null {
  const v = value.trim()
  if (v === '') return 'an address is required.'
  const at = v.indexOf('@')
  if (at < 1 || at === v.length - 1 || /\s/.test(v)) return 'not a mail address.'
  return null
}

/** Pi-hole upstreams: an IPv4 or IPv6 address, each optionally `#port`. */
export function upstreamsError(list: readonly string[]): string | null {
  if (list.length === 0) return 'at least one upstream, or the box cannot resolve anything.'
  for (const raw of list) {
    const [addr, port, ...rest] = raw.split('#')
    if (rest.length > 0 || addr === undefined || addr === '') return `"${raw}" is not an upstream.`
    if (port !== undefined && !/^\d{1,5}$/.test(port)) return `"${raw}": the port is not a number.`
    const v6 = addr.includes(':') && /^[0-9a-f:.]+$/i.test(addr)
    if (!v6 && ipv4Error(addr) !== null) return `"${raw}" is not an IPv4 or IPv6 address.`
  }
  return null
}

/** The textarea's lines as the document's list: trimmed, blanks dropped. */
export function parseUpstreams(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
}
