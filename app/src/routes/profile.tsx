import { createFileRoute } from '@tanstack/react-router'

import { GuardedAwait } from '../components/error'
import { Measure, PageHead } from '../components/page'
import { ProfilePage } from '../components/profile'
import { known } from '../lib/known'
import { fetchOperator, fetchProfile } from '../server/profile'

// The person, not the box: the Pocket ID account the signed-in operator uses
// everywhere, and the one thing about them nix owns. Reached from the account
// menu at the foot of the rail, beside Settings, and kept apart from it — see
// components/profile.tsx for why.
//
// The Linux account is a file read and is awaited. The profile asks Pocket
// ID, so it streams in behind the page like every other upstream.

export const Route = createFileRoute('/profile')({
  loader: async () => ({
    operator: await known('operator', fetchOperator),
    profile: fetchProfile(),
  }),
  component: Page,
})

function Page() {
  const { operator, profile } = Route.useLoaderData()
  return (
    <Measure>
      <PageHead title="Profile">
        Who you are to every app on this box. Saved to your Pocket ID account as you go — nothing
        here rebuilds.
      </PageHead>

      <GuardedAwait
        resetKey="profile"
        promise={profile}
        fallback={<ProfilePage operator={operator} profile={null} />}
      >
        {(p) => <ProfilePage operator={operator} profile={p} />}
      </GuardedAwait>
    </Measure>
  )
}
