import { describe, expect, it } from 'vitest'
import { ATTEMPT_MS, attemptsFor, PATIENT_MS } from './http'

// The escalating ladder is for the rootless-port first-SYN stall, which any
// origin that resolves to the host can hit: `host.containers.internal`, and a
// dotted hostname reaching traefik's published port. Only a bridge peer
// dialled by its bare container name gets one patient attempt: retrying a
// slow answer there only queues another request behind it.

describe('attemptsFor', () => {
  it('gives only a bridge peer one patient attempt', () => {
    expect(attemptsFor('http://prometheus:9090/api/v1/query?query=up')).toBe(PATIENT_MS)
    expect(attemptsFor('http://host.containers.internal:8989/api')).toBe(ATTEMPT_MS)
    expect(attemptsFor('https://registry.example.org/v2/_catalog')).toBe(ATTEMPT_MS)
    expect(attemptsFor('not a url')).toBe(ATTEMPT_MS)
  })
})
