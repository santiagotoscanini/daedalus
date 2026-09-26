import { defineViews } from '../../../lib/modules/tabs'
import type { Tabs } from '../data'
import { manifest } from '../manifest'
import { FilesView } from './files'
import { FinanceView } from './finance'
import { HouseView } from './house'
import { IdpView } from './idp'
import { PantryView } from './pantry'
import { PhotosView } from './photos'
import { ToolsView } from './tools'

// The Home pages — a tab per household subject.
//
// Read the same way as every Media and AI tab: artwork, the name, the version
// running, the verdict on whether that version is current, one sentence saying
// what this thing is FOR, and the link you came to click. Eight services whose
// UIs look nothing alike become eight pages read identically.
//
// The rule on the tab row separates what the house shares from what one person
// uses. See the note in the loader for why that is the line.

export const views = defineViews<typeof manifest, Tabs>(manifest, {
  house: HouseView,
  photos: PhotosView,
  files: FilesView,
  pantry: PantryView,
  signin: IdpView,
  finance: FinanceView,
  tools: ToolsView,
})
