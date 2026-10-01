import { describe, expect, it } from 'vitest'
import { ATTEMPT_MS, attemptsFor, PATIENT_MS } from './http'

// The escalating ladder is for the rootless-port first-SYN stall, which only
// a `host.containers.internal` origin can hit. Anything else — prometheus over
// its bridge, traefik, the internet — gets one patient attempt: retrying a
// slow answer there only queues another request behind it.

describe('attemptsFor', () => {
  it('puts only host.containers.internal on the ladder', () => {
    expect(attemptsFor('http://host.containers.internal:8989/api')).toBe(ATTEMPT_MS)
    expect(attemptsFor('http://prometheus:9090/api/v1/query?query=up')).toBe(PATIENT_MS)
    expect(attemptsFor('https://registry.example.org/v2/_catalog')).toBe(PATIENT_MS)
    expect(attemptsFor('not a url')).toBe(PATIENT_MS)
  })
})
