import { useEffect, useId, useState } from 'react'
import {
  boxBuildRefusal,
  ENV_ENTRIES_MAX,
  envEntryError,
  envMapError,
} from '../../lib/build-settings'
import { type BuildPublish, type BuildStrategy, RAILPACK_KNOB_NAMES } from '../../lib/builds'

import { appRepo } from '../../lib/site'
import { useSite } from '../../lib/site-context'
import { setBuildSettingsFn } from '../../server/builds'
import { Segmented } from '../controls'
import { Toggle } from '../slider'
import { FOOT, INPUT_MONO } from '../tokens'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { useAction } from '../use-action'
import { Board, Facts } from '../viz'
import { type AppRecord, GHOST_BTN } from './shared'

// Apps › <name> › Settings › Builds. These save on their own server function,
// not saveApp: the columns are engine-only, so a change here is live at once
// and never waits for, or shows up in, an Apply.

const FIELD_LABEL = 'text-[0.75rem] text-muted-foreground'

export function BuildSettings({ app }: { app: AppRecord }) {
  const repo = appRepo(useSite(), app.name)
  const { run, busy: saving, error } = useAction()
  // Only blocks turning it on: an app already building can still turn it off.
  const nameRefusal = app.buildOnBox ? null : boxBuildRefusal(app.name)

  const save = (patch: Record<string, unknown>) => {
    run(() => setBuildSettingsFn({ data: { app: app.name, ...patch } }))
  }

  return (
    <Board title="Builds" icon="⚙" span={12}>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-8 gap-y-4 max-[50rem]:grid-cols-[minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <Toggle
            checked={app.buildOnBox}
            disabled={saving || nameRefusal !== null}
            onChange={(v) => {
              save({ buildOnBox: v })
            }}
            label="Build on this box"
            hint={
              nameRefusal ??
              'Pushes to the repo’s default branch build here, and Build now works. Nothing in the repo needs a workflow file: the box takes the push webhook itself.'
            }
          />
          <div className="flex flex-col gap-1.5">
            <span className={FIELD_LABEL}>Strategy</span>
            <Segmented<BuildStrategy>
              value={app.buildStrategy as BuildStrategy}
              disabled={saving}
              label="Build strategy"
              onChange={(v) => {
                save({ buildStrategy: v })
              }}
              options={[
                { value: 'auto', label: 'Auto' },
                { value: 'railpack', label: 'Railpack' },
                { value: 'dockerfile', label: 'Dockerfile' },
              ]}
            />
            <p className={FOOT}>
              Auto uses Railpack when the repo has a railpack.json, else its Dockerfile when it has
              one, else Railpack.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className={FIELD_LABEL}>Publish</span>
            <Segmented<BuildPublish>
              value={app.buildPublish as BuildPublish}
              disabled={saving}
              label="Publish mode"
              onChange={(v) => {
                save({ buildPublish: v })
              }}
              options={[
                { value: 'live', label: 'Live' },
                { value: 'candidate', label: 'Candidate' },
              ]}
            />
            <p className={FOOT}>
              {app.buildPublish === 'candidate'
                ? 'Pushed as candidate-<sha> and never deployed. For comparing a box build with the image the app runs today.'
                : 'Pushed as sha-<sha> and latest, and deployed like any other push to the registry.'}
            </p>
          </div>
          <Facts
            list
            rows={[
              {
                k: 'repository',
                v:
                  app.githubRepoId === null ? (
                    <span className="text-subdued">not linked yet</span>
                  ) : (
                    <span>
                      <a href={`https://github.com/${repo}`} target="_blank" rel="noreferrer">
                        {repo}
                      </a>{' '}
                      <span className="font-mono text-[0.75rem] text-muted-foreground">
                        #{app.githubRepoId}
                      </span>
                    </span>
                  ),
              },
            ]}
          />
          {app.githubRepoId === null && (
            <p className={FOOT}>
              An app is linked to the repository of the same name the installed App can see. Build
              now or the next push links it; the hourly sweep tries too.
            </p>
          )}
          {error !== null && (
            <p role="alert" className="m-0 text-[0.78rem] text-danger">
              {error}
            </p>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          <EnvMapEditor
            title="Railpack switches"
            value={app.railpackEnv}
            keyPlaceholder="RAILPACK_PRUNE_DEPS"
            help={`The Railpack switches this box passes on: ${RAILPACK_KNOB_NAMES.join(', ')}. Start, build and install commands are not switches here: they belong in the repo’s railpack.json, where they are reviewed with the code. Ignored when the build uses the Dockerfile.`}
            busy={saving}
            onSave={(v) => save({ railpackEnv: v })}
          />
        </div>
      </div>
    </Board>
  )
}

type Row = { id: number; key: string; value: string }

const toRows = (m: Record<string, string>): Row[] =>
  Object.entries(m).map(([key, value], id) => ({ id, key, value }))

const INPUT = INPUT_MONO

/** Name–value pairs, edited as a draft and saved together. */
function EnvMapEditor({
  title,
  value,
  keyPlaceholder,
  help,
  busy,
  onSave,
}: {
  title: string
  value: Record<string, string>
  keyPlaceholder: string
  help: string
  busy: boolean
  onSave: (v: Record<string, string>) => void
}) {
  const headId = useId()
  const [rows, setRows] = useState<Row[]>(() => toRows(value))
  const [next, setNext] = useState(() => Object.keys(value).length)
  const saved = JSON.stringify(value)
  useEffect(() => {
    setRows(toRows(JSON.parse(saved) as Record<string, string>))
  }, [saved])

  // A row just added and still blank is not an entry yet: it neither dirties
  // the draft nor draws "needs a name" before anything is typed.
  const entries = rows
    .filter((r) => r.key.trim() !== '' || r.value !== '')
    .map((r): [string, string] => [r.key.trim(), r.value])
  const draft = Object.fromEntries(entries)
  const dirty = JSON.stringify(draft) !== saved || entries.length !== Object.keys(value).length
  const problem = envMapError(entries)

  const set = (id: number, patch: Partial<Row>) => {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  return (
    <section aria-labelledby={headId} className="flex flex-col gap-2">
      <h4 id={headId} className="m-0 text-[0.84rem] [font-weight:550]">
        {title}
      </h4>
      <p className={FOOT}>{help}</p>
      {rows.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {rows.map((r) => {
            const rowError =
              r.key === '' && r.value === '' ? null : envEntryError(r.key.trim(), r.value)
            return (
              <li
                key={r.id}
                className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-1.5"
              >
                <Input
                  aria-label={`${title}: name`}
                  className={INPUT}
                  value={r.key}
                  placeholder={keyPlaceholder}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={rowError !== null}
                  onChange={(e) => {
                    set(r.id, { key: e.target.value })
                  }}
                />
                <Input
                  aria-label={`${title}: value`}
                  className={INPUT}
                  value={r.value}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => {
                    set(r.id, { value: e.target.value })
                  }}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${r.key || 'this entry'}`}
                  onClick={() => {
                    setRows((rs) => rs.filter((x) => x.id !== r.id))
                  }}
                >
                  ✕
                </Button>
              </li>
            )
          })}
        </ul>
      )}
      {problem !== null && dirty && (
        <p role="alert" className="m-0 text-[0.75rem] text-danger">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={GHOST_BTN}
          disabled={rows.length >= ENV_ENTRIES_MAX}
          onClick={() => {
            setRows((rs) => [...rs, { id: next, key: '', value: '' }])
            setNext((n) => n + 1)
          }}
        >
          Add
        </Button>
        {dirty && (
          <>
            <Button
              type="button"
              size="sm"
              disabled={busy || problem !== null}
              onClick={() => {
                onSave(Object.fromEntries(entries))
              }}
            >
              {busy ? 'Saving…' : 'Save'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setRows(toRows(value))
              }}
            >
              Discard
            </Button>
          </>
        )}
      </div>
    </section>
  )
}
