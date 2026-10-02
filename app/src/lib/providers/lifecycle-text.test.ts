import { describe, expect, it } from 'vitest'
import { installText, type LifecycleFacts, processText, unmanagedInstall } from './lifecycle-text'

// The two machines' real reports from agent 0.27.0 on 2026-10-02, and the
// shape an older agent sends (the lifecycle fields empty).
const pc: LifecycleFacts = {
  speaks: true,
  present: true,
  running: true,
  install: {
    method: 'msi',
    scope: 'user',
    location: 'C:\\Users\\micro\\AppData\\Local\\lemonade_server\\',
    installer_version: '10.8.1',
    user: 'Santi-PC\\micro',
  },
  pid: 16312,
  session: 1,
  owner: 'Santi-PC\\micro',
}
const mac: LifecycleFacts = {
  speaks: true,
  present: true,
  running: true,
  install: {
    method: 'pkg',
    scope: 'machine',
    location: null,
    installer_version: '10.9.0',
    user: null,
  },
  pid: null,
  session: null,
  owner: null,
}
const old: LifecycleFacts = {
  ...pc,
  speaks: false,
  install: null,
  pid: null,
  session: null,
  owner: null,
}

describe('the install line', () => {
  it('names the method and scope the agent found', () => {
    expect(installText(pc)).toEqual({ text: 'MSI · per user (Santi-PC\\micro)', tone: null })
    expect(installText(mac)).toEqual({ text: 'macOS package · per machine', tone: null })
  })
  it('says an agent too old to report, never "cannot manage"', () => {
    expect(installText(old)).toEqual({ text: 'not reported — its agent is too old', tone: 'warn' })
    expect(unmanagedInstall(old)).toBe(false)
  })
  it('calls it unmanaged only when an agent that speaks it found no record', () => {
    const none = { ...pc, install: null }
    expect(installText(none)).toEqual({ text: 'not one the agent can manage', tone: 'warn' })
    expect(unmanagedInstall(none)).toBe(true)
    expect(unmanagedInstall({ ...none, speaks: null })).toBe(false)
    expect(installText({ ...none, speaks: null }).text).toMatch(/^unknown/)
  })
  it('is none with nothing reported', () => {
    expect(installText({ ...pc, present: false, install: null }).text).toBe('none')
  })
})

describe('the process line', () => {
  it('names pid, session and owner', () => {
    expect(processText(pc)).toBe('pid 16312 · session 1 · Santi-PC\\micro')
  })
  it('never says "not running" of a server that answers', () => {
    expect(processText(mac)).toBe('running · pid not reported')
    expect(processText(old)).toBe('running · pid not reported')
  })
  it('says not running only of a stopped server', () => {
    expect(processText({ ...pc, running: false, pid: null })).toBe('not running')
    expect(processText({ ...old, running: false })).toBe('not running')
  })
})
