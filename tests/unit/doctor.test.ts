import { describe, expect, it, vi } from 'vitest'
import { makeNetworkPrivate, parseReport, runConnectivityReport } from '../../src/main/net/doctor'

describe('parseReport', () => {
  it('parses numeric NetworkCategory values (PS5 enum serialization)', () => {
    const report = parseReport(
      '{"profiles":[{"InterfaceAlias":"Ethernet 2","NetworkCategory":0},{"InterfaceAlias":"Wi-Fi","NetworkCategory":1}],"ruleExists":true}'
    )
    expect(report.profiles).toEqual([
      { alias: 'Ethernet 2', category: 'public' },
      { alias: 'Wi-Fi', category: 'private' }
    ])
    expect(report.ruleExists).toBe(true)
  })

  it('parses string categories and single-object profile form', () => {
    const report = parseReport(
      '{"profiles":{"InterfaceAlias":"Ethernet","NetworkCategory":"DomainAuthenticated"},"ruleExists":false}'
    )
    expect(report.profiles).toEqual([{ alias: 'Ethernet', category: 'domain' }])
    expect(report.ruleExists).toBe(false)
  })

  it('handles missing profiles', () => {
    expect(parseReport('{"profiles":null,"ruleExists":false}')).toEqual({
      profiles: [],
      ruleExists: false
    })
  })
})

describe('runConnectivityReport', () => {
  it('is a no-op off Windows', async () => {
    const runner = vi.fn()
    expect(await runConnectivityReport(runner, 'linux')).toEqual({
      profiles: [],
      ruleExists: false
    })
    expect(runner).not.toHaveBeenCalled()
  })

  it('degrades gracefully when PowerShell fails', async () => {
    const runner = vi.fn().mockRejectedValue(new Error('boom'))
    expect(await runConnectivityReport(runner, 'win32')).toEqual({
      profiles: [],
      ruleExists: false
    })
  })
})

describe('makeNetworkPrivate', () => {
  it('elevates a Set-NetConnectionProfile with the alias quoted', async () => {
    const runner = vi.fn().mockResolvedValue('')
    expect(await makeNetworkPrivate("Jake's LAN", runner, 'win32')).toBe(true)
    const script = runner.mock.calls[0]?.[0] as string
    expect(script).toContain('-Verb RunAs')
    expect(script).toContain("Set-NetConnectionProfile -InterfaceAlias 'Jake''s LAN'")
  })

  it('returns false when elevation is declined', async () => {
    const runner = vi.fn().mockRejectedValue(new Error('canceled'))
    expect(await makeNetworkPrivate('Ethernet', runner, 'win32')).toBe(false)
  })
})
