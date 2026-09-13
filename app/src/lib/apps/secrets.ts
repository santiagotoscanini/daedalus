import { readEnvSnapshot } from '../../host/env-snapshot'
import { getApp } from '../repo/apps'

// One secret value, on demand.
//
// Separate from the app payload so secrets never enter the page: loader data
// is serialised into the HTML, so shipping them and masking with CSS would put
// every database password in view-source — theatre, not concealment. Revealing
// is an explicit request for a named variable, behind the Pocket ID gate like
// the rest of the app.

export async function revealAppEnvVar(data: { name: string; key: string }) {
  // Confirms the app is one this instance manages, so the app name cannot be
  // used to read an arbitrary path out of the snapshot directory.
  const record = await getApp(data.name)
  if (!record) throw new Error(`no app named ${data.name}`)

  const snapshot = await readEnvSnapshot(data.name, new Map())
  const found = snapshot.vars.find((v) => v.key === data.key)
  if (!found) throw new Error(`no variable ${data.key} in ${data.name}`)

  // Only masked variables have anything to reveal: a non-secret value is
  // already in the page payload, so a request for one is not the UI — keep
  // this door exactly as narrow as its purpose.
  if (!found.secret) throw new Error(`${data.key} is not a masked variable`)

  return { value: found.value }
}
