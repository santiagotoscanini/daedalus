import { createServerFn } from '@tanstack/react-start'
import { DEFAULT_THEME, isThemeChoice, presetById, type ThemeChoice } from '../lib/theme'

// Server functions behind the preferences in Settings. Values here never reach
// the site repo and never trigger a rebuild — see the `settings` table comment
// in lib/schema.ts for where that line is drawn.
//
// Value imports are dynamic so the database module is not pulled into a client
// bundle by a type import, matching server/registry.ts.

export const fetchTheme = createServerFn().handler(async (): Promise<ThemeChoice> => {
  const { readSetting, SETTING_KEYS } = await import('../lib/repo/settings')
  // A control plane that will not render because its theme row is
  // unreadable is worse than one rendering in the default palette.
  try {
    return (await readSetting(SETTING_KEYS.theme, isThemeChoice)) ?? DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
})

export const saveTheme = createServerFn({ method: 'POST' })
  .validator((data: unknown): ThemeChoice => {
    if (!isThemeChoice(data)) throw new Error('not a theme choice')
    // Reject an unknown preset id here rather than storing it and falling
    // back on every read: a preference the UI cannot show as selected is
    // indistinguishable from one that did not save.
    if (presetById(data.presetId).id !== data.presetId) throw new Error('unknown preset')
    return { presetId: data.presetId, scheme: data.scheme }
  })
  .handler(async ({ data }) => {
    const { writeSetting, SETTING_KEYS } = await import('../lib/repo/settings')
    await writeSetting(SETTING_KEYS.theme, data)
    return data
  })
