import { createFileRoute, redirect } from '@tanstack/react-router'

// Apps is the whole point of the control plane, so it is the landing page.
// Redirect rather than duplicate the list here.
export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({ to: '/apps' })
  },
})
