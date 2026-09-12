import { useRouter } from '@tanstack/react-router'
import { useEffect, useId, useState } from 'react'
import {
  boxBuildRefusal,
  buildEnvSizeError,
  ENV_ENTRIES_MAX,
  type EnvMapKind,
  envEntryError,
  envMapError,
} from '../../lib/build-settings'
import { type BuildPublish, type BuildStrategy, RAILPACK_KNOB_NAMES } from '../../lib/builds'
import { OWNER } from '../../lib/site'
import { type BuildSettingsResult, setBuildSettingsFn } from '../../server/builds'
import { Segmented, Toggle } from '../controls'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Board, Facts } from '../viz'
import { type AppRecord, BOARD_FOOT, GHOST_BTN } from './shared'

// Apps › <name> › Settings › Builds. These save on their own server function,
// not saveApp: the columns are engine-only, so a change here is live at once
// and never waits for, or shows up in, an Apply.

const FIELD_LABEL = 'text-[0.76rem] text-(--dim)'

export function BuildSettings({ app }: { app: AppRecord }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // Only blocks turning it on: an app already building can still turn it off.
  const nameRefusal = app.buildOnBox ? null : boxBuildRefusal(app.name)

  const save = async (patch: Record<string, unknown>): Promise<boolean> => {
    setSaving(true)
    setError(null)
    try {
      const r: BuildSettingsResult = await setBuildSettingsFn({
        data: { app: app.name, ...patch },
      })
      if (!r.ok) {
        setError(r.reason)
        return false
      }
      await router.invalidate()
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setSaving(false)
    }
  }

  return (
    <Board title="Builds" icon="⚙" span={12}>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-8 gap-y-4 max-[50rem]:grid-cols-[minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <Toggle
            checked={app.buildOnBox}
            disabled={saving || nameRefusal !== null}
            onChange={(v) => {
              void save({ buildOnBox: v })
            }}
            label="Build on this box"
            hint={
              nameRefusal ??
              'Pushes to the repo’s default branch build here, and Build now works. The repo keeps its GitHub Actions workflows until you remove them.'
            }
          />
          <div className="flex flex-col gap-[0.35rem]">
            <span className={FIELD_LABEL}>Strategy</span>
            <Segmented<BuildStrategy>
              value={app.buildStrategy as BuildStrategy}
              disabled={saving}
              label="Build strategy"
              onChange={(v) => {
                void save({ buildStrategy: v })
              }}
              options={[
                { value: 'auto', label: 'Auto' },
                { value: 'railpack', label: 'Railpack' },
                { value: 'dockerfile', label: 'Dockerfile' },
              ]}
            />
            <p className={BOARD_FOOT}>
              Auto uses Railpack when the repo has a railpack.json, else its Dockerfile when it has
              one, else Railpack.
            </p>
          </div>
          <div className="flex flex-col gap-[0.35rem]">
            <span className={FIELD_LABEL}>Publish</span>
            <Segmented<BuildPublish>
              value={app.buildPublish as BuildPublish}
              disabled={saving}
              label="Publish mode"
              onChange={(v) => {
                void save({ buildPublish: v })
              }}
              options={[
                { value: 'live', label: 'Live' },
                { value: 'candidate', label: 'Candidate' },
              ]}
            />
            <p className={BOARD_FOOT}>
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
                    <span className="text-(--text-muted)">not linked yet</span>
                  ) : (
                    <span>
                      <a
                        href={`https://github.com/${OWNER}/${app.name}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {OWNER}/{app.name}
                      </a>{' '}
                      <span className="font-mono text-[0.76rem] text-(--dim)">
                        #{app.githubRepoId}
                      </span>
                    </span>
                  ),
              },
            ]}
          />
          {app.githubRepoId === null && (
            <p className={BOARD_FOOT}>
              The hourly sweep links an app to its GitHub repository by name, through the installed
              App. Builds wait for that.
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
            kind="placeholders"
            title="Build placeholders"
            value={app.buildEnvPlaceholders}
            other={app.railpackEnv}
            keyPlaceholder="VITE_PUBLIC_URL"
            help="Env names the build needs set but never uses for real: a build that reads DATABASE_URL at import time, say. Dummy values only, never secrets. The build sees them in the clear, and so does anyone with its log. Names the builder’s own tools read are refused: PATH, HOME, GIT_*, NODE_*, NPM_CONFIG_*, PNPM_* and the like."
            onSave={(v) => save({ buildEnvPlaceholders: v })}
          />
          <EnvMapEditor
            kind="railpack"
            title="Railpack switches"
            value={app.railpackEnv}
            other={app.buildEnvPlaceholders}
            keyPlaceholder="RAILPACK_PRUNE_DEPS"
            help={`The Railpack switches this box passes on: ${RAILPACK_KNOB_NAMES.join(', ')}. Start, build and install commands are not switches here: they belong in the repo’s railpack.json, where they are reviewed with the code. Ignored when the build uses the Dockerfile.`}
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

const INPUT =
  'h-auto rounded-[8px] bg-(--panel-2) px-[0.6rem] py-[0.4rem] font-mono md:text-[0.8rem] dark:bg-(--panel-2)'

/** Name–value pairs, edited as a draft and saved together. */
function EnvMapEditor({
  kind,
  title,
  value,
  other,
  keyPlaceholder,
  help,
  onSave,
}: {
  kind: EnvMapKind
  title: string
  value: Record<string, string>
  /** The app's other build env map, saved: the size cap is on both together. */
  other: Record<string, string>
  keyPlaceholder: string
  help: string
  onSave: (v: Record<string, string>) => Promise<boolean>
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
  const problem =
    envMapError(kind, entries) ??
    (kind === 'placeholders' ? buildEnvSizeError(draft, other) : buildEnvSizeError(other, draft))
  const [busy, setBusy] = useState(false)

  const set = (id: number, patch: Partial<Row>) => {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  return (
    <section aria-labelledby={headId} className="flex flex-col gap-2">
      <h4 id={headId} className="m-0 text-[0.84rem] [font-weight:550]">
        {title}
      </h4>
      <p className={BOARD_FOOT}>{help}</p>
      {rows.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-[0.4rem] p-0">
          {rows.map((r) => {
            const rowError =
              r.key === '' && r.value === '' ? null : envEntryError(kind, r.key.trim(), r.value)
            return (
              <li
                key={r.id}
                className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-[0.4rem]"
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
        <p role="alert" className="m-0 text-[0.76rem] text-danger">
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
                setBusy(true)
                void onSave(Object.fromEntries(entries)).finally(() => {
                  setBusy(false)
                })
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
