import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { env } from '../env'

// The two design documents, served as MCP resources.
//
// WHY THEY ARE RESOURCES. An agent that can press Apply should be able to read
// what Apply does first. ARCHITECTURE.md is the engine as built — the bridge,
// the apply flow, the seam; BUILDS.md is the build→zot→deploy loop the write
// tools drive. Handing those to a caller before it acts is the cheapest
// possible way to stop it inventing a mental model of this box.
//
// WHY A HARD ALLOWLIST. The mount below is a directory, and a resource server
// that takes a path is a file browser with extra steps. These two names are
// the whole surface: there is no parameter, no template, and no way to ask for
// a third file. A doc added later is a line in this table and a redeploy, which
// is the correct amount of friction for widening what an agent can read.
//
// WHERE THEY COME FROM. The container bind-mounts `/app` — the engine repo's
// `app/` directory, the dev server's source — and nothing above it, so the
// repo root's markdown is not reachable by default. stacks/daedalus mounts the
// engine workspace read-only at ENGINE_DOCS_DIR for exactly these two files.
// Until that mount lands (it arrives with the operator's next switch), a read
// answers with the sentence below rather than throwing: a missing design doc
// is a degraded resource, not a broken server.

const DEFAULT_DIR = '/engine'

export type McpDoc = {
  uri: string
  name: string
  file: string
  title: string
  description: string
}

export const MCP_DOCS: readonly McpDoc[] = [
  {
    uri: 'daedalus://docs/architecture',
    name: 'ARCHITECTURE.md',
    file: 'ARCHITECTURE.md',
    title: 'Daedalus architecture',
    description:
      'The engine as built: the file-drop bridge, the apply flow, the server-function seam, and what writes where.',
  },
  {
    uri: 'daedalus://docs/builds',
    name: 'BUILDS.md',
    file: 'BUILDS.md',
    title: 'How the box builds an app',
    description:
      'The push → GitHub App webhook → Railpack build → zot → deploy loop the write tools drive.',
  },
] as const

const docsDir = (): string => env.get('ENGINE_DOCS_DIR') ?? DEFAULT_DIR

/**
 * A document's text, or an explanation of why it is not here.
 *
 * Never throws. The failure this actually has — the mount not existing yet —
 * is an operations fact the caller can act on, and reading it as a sentence
 * beats reading it as a stack trace.
 */
export async function readMcpDoc(doc: McpDoc): Promise<string> {
  const path = join(docsDir(), doc.file)
  try {
    return await readFile(path, 'utf8')
  } catch {
    return (
      `${doc.file} is not readable at ${path}.\n\n` +
      'The engine workspace is mounted read-only into this container by ' +
      'stacks/daedalus (ENGINE_DOCS_DIR); a mount added but not yet switched ' +
      'onto the running system looks exactly like this. Read the file from ' +
      '~santiago/projects/daedalus/ on the host instead.'
    )
  }
}
