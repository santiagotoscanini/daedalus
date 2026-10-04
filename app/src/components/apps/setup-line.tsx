// A new app's way to its first container, as one line on its page:
// setting up · building · starting · running (lib/apps/setup.ts decides
// where it is). A step that stopped says why, with the build's log when there
// is one, and a Retry that runs that step again.

import { Link, useRouter } from '@tanstack/react-router'
import { cn } from '../../lib/cn'
import { SETUP_STEPS, type SetupProgress } from '../../lib/setup-progress'
import { retryAppSetupFn } from '../../server/registry'
import { usePoll } from '../poll'
import { Alert, AlertDescription } from '../ui/alert'
import { Button } from '../ui/button'
import { useAction } from '../use-action'

const FAILED: Record<NonNullable<SetupProgress['failed']>['what'], string> = {
  register: 'setup failed',
  build: 'build failed',
  apply: 'start failed',
}

/** How often the page asks again while the app is on its way. */
const POLL_MS = 5_000

export function SetupLine({ name, setup }: { name: string; setup: SetupProgress }) {
  const router = useRouter()
  const retry = useAction()
  usePoll(() => router.invalidate(), POLL_MS, setup.failed === null)
  const at = SETUP_STEPS.indexOf(setup.step)

  return (
    <Alert
      variant={setup.failed === null ? 'default' : 'destructive'}
      className="mb-[1.35rem]"
      aria-live="polite"
    >
      <AlertDescription>
        <p className="m-0 flex flex-wrap items-center gap-x-2 font-mono text-[0.84rem]">
          {SETUP_STEPS.map((s, i) => (
            <span key={s} className="inline-flex items-center gap-x-2">
              {i > 0 && (
                <span aria-hidden="true" className="text-muted-foreground">
                  ·
                </span>
              )}
              <span
                aria-current={i === at ? 'step' : undefined}
                className={cn(
                  i < at && 'text-subdued',
                  i === at && 'font-semibold text-foreground',
                  i > at && 'text-muted-foreground',
                  i === at && setup.failed !== null && 'text-danger',
                )}
              >
                {i === at && setup.failed !== null ? FAILED[setup.failed.what] : s}
              </span>
            </span>
          ))}
        </p>
        {setup.failed !== null && <p className="m-0 mt-[0.45rem]">{setup.failed.detail}</p>}
        {setup.note !== null && (
          <p className="m-0 mt-[0.45rem] text-muted-foreground">{setup.note}</p>
        )}
        {(setup.failed !== null || setup.buildId !== null) && (
          <div className="mt-[0.7rem] flex flex-wrap items-center gap-3">
            {setup.failed !== null && (
              <Button
                type="button"
                size="sm"
                disabled={retry.busy}
                onClick={() => {
                  retry.run(() => retryAppSetupFn({ data: { name } }))
                }}
              >
                {retry.busy ? 'Retrying…' : 'Retry'}
              </Button>
            )}
            {setup.buildId !== null && (
              <Link
                to="/apps/$name/builds/$id"
                params={{ name, id: setup.buildId }}
                className="text-[0.82rem]"
              >
                Build log →
              </Link>
            )}
          </div>
        )}
        {retry.error !== null && <p className="m-0 mt-[0.45rem]">{retry.error}</p>}
      </AlertDescription>
    </Alert>
  )
}
