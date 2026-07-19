import { describe, expect, it, vi } from 'vitest'
import {
  AudioRouter,
  buildRouteScript,
  buildUnrouteScript,
  parseRouteResult
} from '../../src/main/net/audioRouting'

describe('parseRouteResult', () => {
  it('parses success with the endpoint name', () => {
    expect(parseRouteResult('ROUTE_OK CABLE Input (VB-Audio Virtual Cable)\n')).toEqual({
      ok: true,
      detail: 'CABLE Input (VB-Audio Virtual Cable)'
    })
  })

  it('parses failures with a reason', () => {
    expect(parseRouteResult('ROUTE_ERR virtual-mic-not-found\n')).toEqual({
      ok: false,
      detail: 'virtual-mic-not-found'
    })
    expect(parseRouteResult('ROUTE_ERR set-endpoint E_NOINTERFACE\n')).toEqual({
      ok: false,
      detail: 'set-endpoint E_NOINTERFACE'
    })
  })

  it('parses the unroute acknowledgement', () => {
    expect(parseRouteResult('ROUTE_CLEARED\n')).toEqual({ ok: true, detail: 'cleared' })
  })

  it('skips noise lines and fails on empty output', () => {
    expect(parseRouteResult('WARNING: something\nROUTE_OK CABLE Input\n').ok).toBe(true)
    expect(parseRouteResult('')).toEqual({ ok: false, detail: 'no result from helper' })
  })
})

describe('buildRouteScript', () => {
  it('targets the virtual mic label and the render-endpoint device path', () => {
    const script = buildRouteScript()
    expect(script).toContain('CABLE Input')
    expect(script).toContain('MMDevices\\Audio\\Render')
    // \\?\SWD#MMDEVAPI#{0.0.0.00000000}.{guid}#{DEVINTERFACE_AUDIO_RENDER}
    expect(script).toContain('SWD#MMDEVAPI#{0.0.0.00000000}.')
    expect(script).toContain('{e6327cad-dcec-4949-ae8a-991e976a79d2}')
  })

  it('carries both AudioPolicyConfig IIDs (21H2 and legacy)', () => {
    const script = buildRouteScript()
    expect(script).toContain('AB3D4648-E242-459F-B02F-541C70306324')
    expect(script).toContain('2A59116D-6C4F-45E0-A74F-707E3FEF9258')
    expect(script).toContain('Windows.Media.Internal.AudioPolicyConfig')
  })

  it('escapes single quotes in the device label for PowerShell', () => {
    expect(buildRouteScript("O'Cable")).toContain("O''Cable")
  })

  it('unroute clears via an empty device path', () => {
    const script = buildUnrouteScript()
    expect(script).toContain("SetPersistedDefaultRender([uint32]$PID, '')")
    expect(script).toContain('ROUTE_CLEARED')
  })
})

describe('AudioRouter', () => {
  it('short-circuits off Windows', async () => {
    const runner = vi.fn()
    const router = new AudioRouter(runner, 'linux')
    expect(router.supported).toBe(false)
    expect(await router.routeToVirtualMic()).toEqual({ ok: false, detail: 'unsupported-platform' })
    await router.unroute()
    expect(runner).not.toHaveBeenCalled()
  })

  it('routes via the helper and reports the endpoint', async () => {
    const runner = vi.fn().mockResolvedValue('ROUTE_OK CABLE Input (VB-Audio Virtual Cable)\n')
    const router = new AudioRouter(runner, 'win32')
    expect(await router.routeToVirtualMic()).toEqual({
      ok: true,
      detail: 'CABLE Input (VB-Audio Virtual Cable)'
    })
    expect(runner.mock.calls[0]?.[0]).toContain('CABLE Input')
  })

  it('turns helper crashes into a failed result instead of throwing', async () => {
    const runner = vi.fn().mockRejectedValue(new Error('powershell missing'))
    const router = new AudioRouter(runner, 'win32')
    expect(await router.routeToVirtualMic()).toEqual({ ok: false, detail: 'powershell missing' })
  })

  it('unroute swallows helper failures', async () => {
    const runner = vi.fn().mockRejectedValue(new Error('boom'))
    const router = new AudioRouter(runner, 'win32')
    await expect(router.unroute()).resolves.toBeUndefined()
  })
})
