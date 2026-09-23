import { createFileRoute, redirect } from '@tanstack/react-router'

// The Claude page is a System tab now — on this box and on every machine
// with an agent — because the remote-control server is a fact about a
// machine, and every machine on the network has one. This route stays for
// the bookmarks and the links that learned `/claude`: it sends them to the
// same subject on System, keeping the picked machine and turning the old
// Shotter sub-tab into its own tab there.

const NODE_ID = /^[0-9a-f]{16}$/

export const Route = createFileRoute('/claude')({
  validateSearch: (search: Record<string, unknown>): { tab?: 'shotter'; machine?: string } => ({
    tab: search.tab === 'shotter' ? 'shotter' : undefined,
    machine:
      typeof search.machine === 'string' && NODE_ID.test(search.machine)
        ? search.machine
        : undefined,
  }),
  beforeLoad: ({ search }) => {
    throw redirect({
      to: '/c/$category',
      params: { category: 'system' },
      search: {
        tab: search.tab === 'shotter' ? 'shotter' : 'claude',
        ...(search.machine === undefined ? {} : { machine: search.machine }),
      },
    })
  },
})
