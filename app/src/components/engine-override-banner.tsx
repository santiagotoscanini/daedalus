import { Link } from '@tanstack/react-router'
import { GitBranchIcon } from 'lucide-react'
import { Alert, AlertDescription } from './ui/alert'

// The one notice that belongs on every page.
//
// While site.json's `developer.engineOverride` is set, the running system is
// whatever an engine clone on disk says it is — not the pinned engine, and
// not the generation the next boot comes up on. Every Apply in that state is
// tested, not switched. That is a fact about the whole box, not about one
// tab, so it is drawn above every page rather than remembered on the one
// where it was set; it disappears the moment the Apply that clears it lands.

export function EngineOverrideBanner({ path }: { path: string | null }) {
  if (path === null) return null
  return (
    <Alert variant="warning" className="mb-6">
      <GitBranchIcon />
      <AlertDescription>
        <p className="m-0">
          <strong>Engine override.</strong> The running system is built from{' '}
          <code className="font-mono text-[0.8rem]">{path}</code>, not from the pinned engine;
          applies are tested, not switched, and the next boot comes up on the last switched
          generation. Image and engine updates are refused until it is cleared in{' '}
          <Link to="/settings" search={{ tab: 'developer' }}>
            Settings › Developer
          </Link>
          .
        </p>
      </AlertDescription>
    </Alert>
  )
}
