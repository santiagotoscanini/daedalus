import { describe, expect, it } from 'vitest'
import { NO_ROSTER } from '../claude-roster'
import { DecodeError } from '../contract/decode'
import { factsShape } from './claude'

// The rollout property, and the only reason this decoder is worth a test.
//
// The roster key is published by stacks/daedalus/host/claude-snapshot.sh, and
// between the rebuild that installs the new script and its next timer tick the
// file on disk is the OLD script's output. A decoder that treated the new key
// as required would blank the whole Claude page for that minute — including
// the boards that have nothing to do with the roster, which is the shape of
// failure this page exists to be immune to.

const minimal = {
  service: {
    activeState: 'active',
    subState: 'running',
    result: 'success',
    restarts: 0,
    memoryBytes: null,
    cpuNsec: null,
    activeSince: null,
  },
  remote: { version: null, spawnMode: null, maxSessions: null, environmentId: null },
  sessions: [],
  credentials: {
    present: false,
    subscriptionType: null,
    rateLimitTier: null,
    expiresAt: null,
    refreshExpiresAt: null,
    scopes: [],
  },
  settings: { model: null, effortLevel: null },
  cli: { version: '2.1.260', storePath: null },
}

describe('a snapshot written before the roster existed', () => {
  it('decodes, with an empty roster', () => {
    const facts = factsShape(minimal, '')
    expect(facts.roster).toEqual(NO_ROSTER)
    expect(facts.service.activeState).toBe('active')
  })

  it('leaves the pre-roster session fields alone', () => {
    const facts = factsShape(
      {
        ...minimal,
        // The older script wrote no `status` on a session either.
        sessions: [{ pid: 91660, transcriptId: 'a', alive: true, lastActivityAt: 1 }],
      },
      '',
    )
    expect(facts.sessions[0]?.status).toBeNull()
    expect(facts.sessions[0]?.alive).toBe(true)
  })
})

describe('a roster the current script wrote', () => {
  it('fills in every field the script may have left out', () => {
    const facts = factsShape(
      {
        ...minimal,
        roster: {
          agentsAvailable: true,
          agents: [{ id: '3ab35c23', kind: 'background' }],
          transcripts: [{ id: '63a9d108-9cb0-52ce-a893-2100b396d0e6' }],
        },
      },
      '',
    )
    expect(facts.roster.agents[0]).toEqual({
      id: '3ab35c23',
      sessionId: null,
      pid: null,
      kind: 'background',
      state: null,
      status: null,
      name: null,
      cwd: null,
      startedAt: null,
    })
    expect(facts.roster.transcripts[0]?.sizeBytes).toBe(0)
    expect(facts.roster.transcripts[0]?.startedAt).toBeNull()
    expect(facts.roster.transcriptTotal).toBe(0)
  })

  it('refuses a transcript with no id, which is the one field that is not a label', () => {
    expect(() =>
      factsShape({ ...minimal, roster: { transcripts: [{ cwd: '/etc/nixos' }] } }, ''),
    ).toThrow(DecodeError)
  })

  it('names the path of a field of the wrong type', () => {
    expect(() => factsShape({ ...minimal, roster: { transcripts: [{ id: 5 }] } }, '')).toThrow(
      /roster\.transcripts\[0\]\.id/,
    )
  })
})
