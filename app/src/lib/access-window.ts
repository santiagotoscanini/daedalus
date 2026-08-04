// The time windows the access tab offers, split out from ./access because the
// route imports them as VALUES (the range picker, validateSearch) and ./access
// is server-only. Same split, and the same reason, as ./env-groups vs
// ./env-snapshot.

export const ACCESS_WINDOWS = ['24h', '7d', '30d'] as const
export type AccessWindow = (typeof ACCESS_WINDOWS)[number]

export const DEFAULT_WINDOW: AccessWindow = '7d'

export const WINDOW_SPEC: Record<
  AccessWindow,
  { label: string; prose: string; seconds: number; stepSeconds: number }
> = {
  // step doubles as the count_over_time window, so the series is a plain
  // histogram of requests per bucket rather than a rolling average.
  '24h': { label: '24h', prose: 'the last 24 hours', seconds: 86_400, stepSeconds: 900 },
  '7d': { label: '7d', prose: 'the last 7 days', seconds: 604_800, stepSeconds: 7_200 },
  // Loki's retention is 30 days (stacks/logging), so this is the whole of
  // recorded history — there is deliberately no longer option to offer.
  '30d': { label: '30d', prose: 'the last 30 days', seconds: 2_592_000, stepSeconds: 21_600 },
}

export function isAccessWindow(v: unknown): v is AccessWindow {
  return ACCESS_WINDOWS.includes(v as AccessWindow)
}
