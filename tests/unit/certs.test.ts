import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  certNeedsRegen,
  inspectPem,
  loadOrCreateCert,
  newSessionToken,
  tokenMatches
} from '../../src/main/server/certs'

describe('tokenMatches', () => {
  it('accepts the exact token and rejects everything else', () => {
    const token = newSessionToken()
    expect(tokenMatches(token, token)).toBe(true)
    expect(tokenMatches(token, token + 'x')).toBe(false)
    expect(tokenMatches(token, token.slice(0, -1))).toBe(false)
    expect(tokenMatches(token, '')).toBe(false)
    expect(tokenMatches(token, null)).toBe(false)
  })

  it('generates url-safe tokens with enough entropy', () => {
    const t = newSessionToken()
    expect(t).toMatch(/^[A-Za-z0-9_-]{20,}$/)
    expect(newSessionToken()).not.toBe(t)
  })
})

describe('certNeedsRegen', () => {
  const in1Year = new Date(Date.now() + 365 * 24 * 3600 * 1000)
  const in10Days = new Date(Date.now() + 10 * 24 * 3600 * 1000)

  it('keeps a fresh cert covering all IPs', () => {
    expect(
      certNeedsRegen({ notAfter: in1Year, sanIps: ['127.0.0.1', '192.168.1.5'] }, ['192.168.1.5'])
    ).toBe(false)
  })

  it('regenerates near expiry', () => {
    expect(certNeedsRegen({ notAfter: in10Days, sanIps: ['192.168.1.5'] }, ['192.168.1.5'])).toBe(
      true
    )
  })

  it('regenerates when an IP is missing from SANs', () => {
    expect(certNeedsRegen({ notAfter: in1Year, sanIps: ['192.168.1.5'] }, ['10.0.0.7'])).toBe(true)
  })
})

describe('loadOrCreateCert', () => {
  it('creates a cert with SANs for all LAN IPs and reuses it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nmnp-certs-'))
    const first = loadOrCreateCert(dir, ['192.168.1.5', '10.0.0.7'])
    expect(first.sanIps).toEqual(expect.arrayContaining(['127.0.0.1', '192.168.1.5', '10.0.0.7']))
    expect(first.notAfter.getTime()).toBeGreaterThan(Date.now())

    const second = loadOrCreateCert(dir, ['192.168.1.5'])
    expect(second.fingerprint256).toBe(first.fingerprint256) // reused

    const third = loadOrCreateCert(dir, ['172.16.9.9']) // uncovered IP -> regen
    expect(third.fingerprint256).not.toBe(first.fingerprint256)
    expect(third.sanIps).toContain('172.16.9.9')

    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('inspectPem exposes fingerprint and SANs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nmnp-certs2-'))
    const pair = loadOrCreateCert(dir, ['192.168.44.44'])
    const info = inspectPem(pair.cert)
    expect(info.sanIps).toContain('192.168.44.44')
    expect(info.fingerprint256).toBe(pair.fingerprint256)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
