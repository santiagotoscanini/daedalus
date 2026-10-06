import { Link } from '@tanstack/react-router'
import { GitBranchIcon } from 'lucide-react'
import { Alert, AlertDescription } from './ui/alert'

// The one notice that belongs on every page.
//
// While site.json's `developer.engineOverride` is on, the running system is
// whatever the engine clone on disk says it is — not the pinned engine, and
// not the generation the next boot comes up on. Every Apply in that state is
// tested, not switched. That is a fact about the whole box, not about one
// tab, so it is drawn above every page rather than remembered on the one
// where it was set; it disappears the moment the Apply that clears it lands.

// A calm inline notice, not a loud bar: the tint and the hairline carry the
// tone, the sentence stays in body ink so it reads as text.
const CALM =
  'mb-6 rounded-xl border-warning/25 bg-warning/8 px-4 py-3 text-foreground [&>svg]:text-warning'
const CALM_BODY =
  'text-[0.84rem] text-muted-foreground opacity-100 [&_strong]:text-foreground [&_strong]:[font-weight:560] [&_a]:text-foreground [&_a]:underline [&_a]:underline-offset-2'

export function EngineOverrideBanner({ on }: { on: boolean }) {
  if (!on) return null
  return (
    <Alert variant="warning" className={CALM}>
      <GitBranchIcon />
      <AlertDescription className={CALM_BODY}>
        <p className="m-0">
          <strong>Engine override.</strong> The running system is built from the engine clone, not
          from the pinned engine; applies are tested, not switched, and the next boot comes up on
          the last switched generation. Image and engine updates are refused until it is cleared in{' '}
          <Link to="/settings" search={{ tab: 'developer' }}>
            Settings › Developer
          </Link>
          .
        </p>
      </AlertDescription>
    </Alert>
  )
}
