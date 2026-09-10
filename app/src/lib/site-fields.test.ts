import { describe, expect, it } from 'vitest'
import {
  baseDomainError,
  hostnameShapeError,
  interfaceError,
  ipv4Error,
  leaseTimeError,
  mailAddressError,
  parseUpstreams,
  upstreamsError,
} from './site-fields'

describe('ipv4Error', () => {
  it('accepts a dotted quad and refuses everything else', () => {
    expect(ipv4Error('192.168.0.2')).toBeNull()
    expect(ipv4Error('0.0.0.0')).toBeNull()
    expect(ipv4Error('256.1.1.1')).not.toBeNull()
    expect(ipv4Error('192.168.0')).not.toBeNull()
    expect(ipv4Error('192.168.0.2 ')).toBeNull()
    expect(ipv4Error('')).not.toBeNull()
    expect(ipv4Error('01.2.3.4')).not.toBeNull()
  })
})

describe('hostnames', () => {
  it('is shape only — no domain rule', () => {
    expect(hostnameShapeError('s2.toscanini.me')).toBeNull()
    expect(hostnameShapeError('s2')).toBeNull()
    expect(hostnameShapeError('-s2.example')).not.toBeNull()
    expect(hostnameShapeError('a b.example')).not.toBeNull()
    expect(hostnameShapeError('')).not.toBeNull()
  })

  it('wants two labels for the base domain', () => {
    expect(baseDomainError('toscanini.me')).toBeNull()
    expect(baseDomainError('toscanini')).not.toBeNull()
  })
})

describe('leaseTimeError', () => {
  it('speaks dnsmasq', () => {
    for (const ok of ['8h', '3600', '1d', '2w', '30m', '90s', 'infinite']) {
      expect(leaseTimeError(ok)).toBeNull()
    }
    for (const bad of ['', '8 h', '8hours', 'forever', '1.5h']) {
      expect(leaseTimeError(bad)).not.toBeNull()
    }
  })
})

describe('interfaceError', () => {
  it('allows empty (null in the document) and refuses nonsense', () => {
    expect(interfaceError('')).toBeNull()
    expect(interfaceError('enp3s0')).toBeNull()
    expect(interfaceError('a'.repeat(16))).not.toBeNull()
    expect(interfaceError('en p3')).not.toBeNull()
  })
})

describe('mailAddressError', () => {
  it('asks for something@something', () => {
    expect(mailAddressError('a@b.c')).toBeNull()
    expect(mailAddressError('@b')).not.toBeNull()
    expect(mailAddressError('a@')).not.toBeNull()
    expect(mailAddressError('a b@c')).not.toBeNull()
  })
})

describe('upstreams', () => {
  it('parses one per line and validates each', () => {
    expect(parseUpstreams(' 8.8.8.8 \n\n8.8.4.4\n')).toEqual(['8.8.8.8', '8.8.4.4'])
    expect(upstreamsError(['8.8.8.8', '8.8.4.4'])).toBeNull()
    expect(upstreamsError(['1.1.1.1#5353', '2001:4860:4860::8888'])).toBeNull()
    expect(upstreamsError([])).not.toBeNull()
    expect(upstreamsError(['dns.google'])).not.toBeNull()
    expect(upstreamsError(['8.8.8.8#x'])).not.toBeNull()
  })
})
