import { describe, expect, it } from 'vitest'
import type { Ctx } from '../../../core/ctx'
import type { ControllerClient } from '../../../host/controller/client'
import { ControllerError, type SystemInfo } from '../../../host/controller/wire'
import { loadController } from './controller'

const INFO = {
  api: 1,
  version: '0.13.0',
  mode: 'controller',
  uptimeSecs: 42,
  telemetry: 'minimal',
  capabilities: ['claude.remote_control', 'telemetry.minimal'],
} as SystemInfo

const ctxWith = (controller: Partial<ControllerClient>) => ({ controller }) as unknown as Ctx

describe('the Host tab’s controller board', () => {
  it('reads the controller and its own Claude report', async () => {
    const d = await loadController(
      ctxWith({
        systemInfo: async () => INFO,
        claudeStatus: async () => ({ reporting: true, wanted: false, report: null }),
      }),
    )
    expect(d).toEqual({
      reachable: true,
      version: '0.13.0',
      mode: 'controller',
      api: 1,
      uptimeSecs: 42,
      telemetry: 'minimal',
      capabilities: ['claude.remote_control', 'telemetry.minimal'],
      claude: { wanted: false, reporting: true, state: null },
    })
  })

  it('asks nothing about Claude of a controller that does not offer it', async () => {
    const d = await loadController(
      ctxWith({
        systemInfo: async () => ({ ...INFO, capabilities: ['telemetry.minimal'] }),
        claudeStatus: () => Promise.reject(new Error('must not be asked')),
      }),
    )
    expect(d.reachable && d.claude).toBeNull()
  })

  it('says why when the controller is not there', async () => {
    const d = await loadController(
      ctxWith({
        systemInfo: () =>
          Promise.reject(
            new ControllerError(
              'unreachable',
              'no socket at /controller/api.sock; is daedalus-controller running?',
            ),
          ),
      }),
    )
    expect(d).toEqual({
      reachable: false,
      error: 'no socket at /controller/api.sock; is daedalus-controller running?',
    })
  })
})
