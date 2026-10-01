// The Tasks tab's row and draft shapes, shared by its card and its editor.

import type { AppTabData } from '../../../server/registry'
import type { AppRecord } from '../shared'

export type TasksData = Extract<AppTabData, { kind: 'tasks' }>
export type TaskRow = TasksData['tasks']['tasks'][number]
/** A task as the registry holds it — what the editor edits and saves back. */
export type TaskDraft = AppRecord['tasks'][number]
