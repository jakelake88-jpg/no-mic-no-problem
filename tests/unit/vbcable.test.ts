import { describe, expect, it, vi } from 'vitest'
import { registryHasVbCable } from '../../src/main/vbcable/detect'
import { runElevated } from '../../src/main/vbcable/installer'

describe('registryHasVbCable', () => {
  it('detects VB-Audio registry entries', async () => {
    const runner = vi.fn((_c: string, _a: string[], cb: (e: Error | null, s: string) => void) =>
      cb(null, 'HKEY_LOCAL_MACHINE\\SOFTWARE\\VB-Audio\\Cable\r\n    Version REG_SZ 4.5')
    )
    expect(await registryHasVbCable(runner)).toBe(true)
  })

  it('returns false when the key is absent or reg.exe fails', async () => {
    const runner = vi.fn((_c: string, _a: string[], cb: (e: Error | null, s: string) => void) =>
      cb(new Error('exit 1'), '')
    )
    expect(await registryHasVbCable(runner)).toBe(false)
  })
})

describe('runElevated', () => {
  it('invokes powershell Start-Process -Verb RunAs with the exe path', async () => {
    const runner = vi.fn((_c: string, _a: string[], cb: (e: Error | null) => void) => cb(null))
    await runElevated('C:\\temp\\VBCABLE_Setup_x64.exe', runner)
    expect(runner).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining([
        '-Command',
        expect.stringContaining(
          "Start-Process -FilePath 'C:\\temp\\VBCABLE_Setup_x64.exe' -Verb RunAs -Wait"
        )
      ]),
      expect.any(Function)
    )
  })

  it("escapes single quotes in paths so PowerShell can't be broken out of", async () => {
    let command = ''
    const runner = vi.fn((_c: string, args: string[], cb: (e: Error | null) => void) => {
      command = args[args.length - 1] ?? ''
      cb(null)
    })
    await runElevated("C:\\it's here\\setup.exe", runner)
    expect(command).toContain("'C:\\it''s here\\setup.exe'")
  })

  it('propagates elevation failure (user declined UAC)', async () => {
    const runner = vi.fn((_c: string, _a: string[], cb: (e: Error | null) => void) =>
      cb(new Error('canceled'))
    )
    await expect(runElevated('C:\\x.exe', runner)).rejects.toThrow('canceled')
  })
})
