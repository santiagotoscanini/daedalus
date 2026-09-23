// Gigabyte's boards, as the firmware and the website spell them.
//
// Gigabyte writes no revision into SMBIOS ("x.x"), so the revision is read
// off the firmware line: the FA/FB/FC series ships on the rev 1.2 board,
// the plain F series on rev 1.0/1.1. The website keys its support page on
// the same revision, so the inference also names the page. Client-safe:
// the Motherboard tab reads it too.

export type GigabyteRevision = { rev: '1.2' | '1.0/1.1'; pageSuffix: string }

export function gigabyteRevision(biosVersion: string | null): GigabyteRevision | null {
  if (biosVersion === null) return null
  if (/^F[A-Z]\d/i.test(biosVersion)) return { rev: '1.2', pageSuffix: '-rev-12' }
  if (/^F\d/i.test(biosVersion)) return { rev: '1.0/1.1', pageSuffix: '-rev-10-11' }
  return null
}

/** "B650 AORUS ELITE AX" + rev 1.2 → the support page's path segment. */
export function gigabytePageSlug(product: string, biosVersion: string | null): string {
  const base = product.trim().replace(/\s+/g, '-').toUpperCase()
  const suffix = /\bV\d\b/i.test(product) ? '' : (gigabyteRevision(biosVersion)?.pageSuffix ?? '')
  return `${base}${suffix}`
}

export function gigabytePageUrl(product: string, biosVersion: string | null): string {
  return `https://www.gigabyte.com/Motherboard/${gigabytePageSlug(product, biosVersion)}/support`
}
