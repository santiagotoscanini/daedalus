// One cookie out of a `Cookie` request header, for a route handler holding a
// Request rather than running inside one (where `getCookie` answers). Pure:
// a string in, a string or undefined out.

export function cookieValue(header: string | null | undefined, name: string): string | undefined {
  if (header === null || header === undefined || header === '') return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== name) continue
    const raw = part.slice(eq + 1).trim()
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }
  return undefined
}
