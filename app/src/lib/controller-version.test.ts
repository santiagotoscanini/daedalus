import { describe, expect, it } from 'vitest'
import { AGENT_VERSION } from '../host/controller/generated/constants'
import { controllerSkew } from './controller-version'

describe('the controller against the agent this app ships beside', () => {
  it('is no skew for the same release, whatever build of it', () => {
    expect(controllerSkew(AGENT_VERSION)).toBeNull()
    expect(controllerSkew(`${AGENT_VERSION}+0a1b2c3d`)).toBeNull()
  })

  it('names both releases when they differ', () => {
    expect(controllerSkew('0.24.1+ff00', '0.25.0')).toEqual({ runs: '0.24.1', ships: '0.25.0' })
    expect(controllerSkew('0.26.0', '0.25.0')).toEqual({ runs: '0.26.0', ships: '0.25.0' })
  })
})
