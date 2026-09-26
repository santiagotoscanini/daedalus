import { isAppName } from '../hostname'
import { isModuleId } from '../modules/registry'
import { type Decoder, is, withMessage } from './decode'

// Field decoders more than one server function reads (src/server/**), each
// refusing with the sentence the hand-written check it replaced used — those
// reach the page as the error text, so the wording is part of the contract.
//
// Pure, and only ever named inside a `.validator(...)`, which the Start
// compiler erases from the browser's copy of a server-function file.

/** An app's name (lib/hostname.ts `isAppName`) — what `appName(v)` checked. */
export const appNameField: Decoder<string> = withMessage(
  is(isAppName, 'an app name'),
  'expected an app name',
)

/** A module id this dashboard has (lib/modules/registry.ts). */
export const moduleIdField: Decoder<string> = withMessage(
  is(isModuleId, 'a module id'),
  'expected a module',
)
