import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// The two design documents, served as MCP resources.
//
// WHY THEY ARE RESOURCES. An agent that can press Apply should be able to read
// what Apply does first. ARCHITECTURE.md is the engine as built — the bridge,
// the apply flow, the seam; BUILDS.md is the build→zot→deploy loop the write
// tools drive. Handing those to a caller before it acts is the cheapest
// possible way to stop it inventing a mental model of this box.
//
// WHY A HARD ALLOWLIST. These two names are the whole surface: there is no
// parameter, no template, and no way to ask for a third file. A doc added
// later is a line in this table and a redeploy, which is the correct amount
// of friction for widening what an agent can read.
//
// WHERE THEY COME FROM. The image itself: the Dockerfile's runtime stage
// copies both from the repository root into DOCS_DIR, so the published image,
// one built on the box and the dev-mode runtime all carry them at the same
// path, at the engine revision the image was built from. A read that fails
// answers with the sentence below rather than throwing: a missing design doc
// is a degraded resource, not a broken server.

const DOCS_DIR = '/opt/daedalus/docs'

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

/**
 * A document's text, or an explanation of why it is not here.
 *
 * Never throws. The failure this actually has — an image built without them —
 * is an operations fact the caller can act on, and reading it as a sentence
 * beats reading it as a stack trace.
 */
export async function readMcpDoc(doc: McpDoc): Promise<string> {
  const path = join(DOCS_DIR, doc.file)
  try {
    return await readFile(path, 'utf8')
  } catch {
    return (
      `${doc.file} is not readable at ${path}.\n\n` +
      'The image copies both design documents from the engine repository root ' +
      '(its Dockerfile, runtime stage); one built without them looks exactly ' +
      'like this. Read the file from the engine repository instead.'
    )
  }
}
