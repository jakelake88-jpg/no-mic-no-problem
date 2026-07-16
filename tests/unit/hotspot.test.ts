import { describe, expect, it, vi } from 'vitest'
import { HotspotManager, parseHotspotJson, wifiQrPayload } from '../../src/main/net/hotspot'

describe('wifiQrPayload', () => {
  it('builds the standard join string', () => {
    expect(wifiQrPayload('MyNet', 'pass123')).toBe('WIFI:T:WPA;S:MyNet;P:pass123;;')
  })

  it('escapes special characters', () => {
    expect(wifiQrPayload('Ne;t', 'p:a,s"s\\')).toBe('WIFI:T:WPA;S:Ne\\;t;P:p\\:a\\,s\\"s\\\\;;')
  })
})

describe('parseHotspotJson', () => {
  it('parses PowerShell output', () => {
    expect(parseHotspotJson('{"ssid":"Net","passphrase":"pw","state":"Off"}')).toEqual({
      ssid: 'Net',
      passphrase: 'pw',
      state: 'Off'
    })
  })

  it('throws on unexpected shapes', () => {
    expect(() => parseHotspotJson('{"nope":1}')).toThrow()
    expect(() => parseHotspotJson('garbage')).toThrow()
  })
})

describe('HotspotManager', () => {
  it('reports unavailable off-Windows without invoking PowerShell', async () => {
    const runner = vi.fn()
    const mgr = new HotspotManager(runner, 'linux')
    const cap = await mgr.capability()
    expect(cap.available).toBe(false)
    expect(runner).not.toHaveBeenCalled()
  })

  it('reports capability from PowerShell on Windows', async () => {
    const runner = vi.fn().mockResolvedValue('{"ssid":"Net","passphrase":"pw","state":"Off"}')
    const mgr = new HotspotManager(runner, 'win32')
    expect((await mgr.capability()).available).toBe(true)
  })

  it('maps no-internet-profile to a helpful reason', async () => {
    const runner = vi.fn().mockRejectedValue(new Error('no-internet-profile'))
    const mgr = new HotspotManager(runner, 'win32')
    const cap = await mgr.capability()
    expect(cap.available).toBe(false)
    expect(cap.reason).toMatch(/internet connection/i)
  })

  it('start returns credentials and cleanup stops only if we started it', async () => {
    const runner = vi.fn().mockResolvedValue('{"ssid":"Net","passphrase":"pw"}')
    const mgr = new HotspotManager(runner, 'win32')

    await mgr.cleanup() // not started by us -> no PS call
    expect(runner).not.toHaveBeenCalled()

    const info = await mgr.start()
    expect(info.ssid).toBe('Net')

    runner.mockResolvedValue('ok')
    await mgr.cleanup() // started by us -> stop invoked
    expect(runner).toHaveBeenCalledTimes(2)
  })
})
