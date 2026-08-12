import type { fetchApp } from '../../server/registry'

export type LoaderData = Awaited<ReturnType<typeof fetchApp>>
export type AppRecord = NonNullable<LoaderData>['app']
