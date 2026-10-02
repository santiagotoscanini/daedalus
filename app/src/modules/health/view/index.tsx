import { defineViews } from '../../../lib/modules/tabs'
import type { Tabs } from '../data'
import { manifest } from '../manifest'
import { NutritionView } from './nutrition'
import { PantryView } from './pantry'
import { RecordView } from './record'
import { TrainingView } from './training'

// The Health pages — a person's record, then what feeds it.
//
// The rule on the tab row separates applications with a page of their own from
// tool servers that exist only behind the gateway. See ../manifest.ts.

export const views = defineViews<typeof manifest, Tabs>(manifest, {
  record: RecordView,
  pantry: PantryView,
  nutrition: NutritionView,
  training: TrainingView,
})
