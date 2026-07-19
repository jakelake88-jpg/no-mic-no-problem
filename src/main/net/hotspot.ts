import { execFile } from 'node:child_process'
import log from 'electron-log'

const hsLog = log.scope('hotspot')

/**
 * Windows Mobile Hotspot control via the WinRT NetworkOperatorTetheringManager,
 * driven from PowerShell (no native modules, no elevation required).
 *
 * The PS snippets use the well-known WinRT-async-await bridge:
 * WindowsRuntimeSystemExtensions.AsTask on the IAsyncOperation.
 */

const PS_PREAMBLE = `
$ErrorActionPreference = 'Stop'
[Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime] | Out-Null
[Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager,Windows.Networking.NetworkOperators,ContentType=WindowsRuntime] | Out-Null
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}
$profile = [Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile()
if ($profile -eq $null) { throw 'no-internet-profile' }
$manager = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager]::CreateFromConnectionProfile($profile)
`

const PS_CAPABILITY = `
${PS_PREAMBLE}
$config = $manager.GetCurrentAccessPointConfiguration()
[pscustomobject]@{
  state = $manager.TetheringOperationalState.ToString()
  ssid = $config.Ssid
  passphrase = $config.Passphrase
} | ConvertTo-Json -Compress
`

const PS_START = `
${PS_PREAMBLE}
if ($manager.TetheringOperationalState -ne 'On') {
  $result = Await ($manager.StartTetheringAsync()) ([Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult])
  if ($result.Status -ne 'Success') { throw ('start-failed: ' + $result.Status) }
}
$config = $manager.GetCurrentAccessPointConfiguration()
[pscustomobject]@{ ssid = $config.Ssid; passphrase = $config.Passphrase } | ConvertTo-Json -Compress
`

const PS_STOP = `
${PS_PREAMBLE}
if ($manager.TetheringOperationalState -eq 'On') {
  $result = Await ($manager.StopTetheringAsync()) ([Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult])
  if ($result.Status -ne 'Success') { throw ('stop-failed: ' + $result.Status) }
}
'ok'
`

export type PsRunner = (script: string) => Promise<string>

const defaultRunner: PsRunner = (script) =>
  new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 30_000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.trim() || err.message))
        else resolve(stdout.trim())
      }
    )
  })

export interface HotspotStatus {
  state: string
  ssid: string
  passphrase: string
}

export function parseHotspotJson(stdout: string): {
  ssid: string
  passphrase: string
  state?: string
} {
  const parsed = JSON.parse(stdout) as Record<string, unknown>
  if (typeof parsed.ssid !== 'string' || typeof parsed.passphrase !== 'string') {
    throw new Error('unexpected hotspot output')
  }
  return {
    ssid: parsed.ssid,
    passphrase: parsed.passphrase,
    state: typeof parsed.state === 'string' ? parsed.state : undefined
  }
}

/** Wi-Fi join string understood natively by phone camera apps. */
export function wifiQrPayload(ssid: string, passphrase: string): string {
  const esc = (s: string): string => s.replace(/([\\;,:"])/g, '\\$1')
  return `WIFI:T:WPA;S:${esc(ssid)};P:${esc(passphrase)};;`
}

export class HotspotManager {
  /** True when THIS app turned the hotspot on (so quit stops it; never stop a user-started hotspot). */
  private startedByUs = false

  constructor(
    private runner: PsRunner = defaultRunner,
    private platform: string = process.platform
  ) {}

  async capability(): Promise<{ available: boolean; reason: string | null }> {
    if (this.platform !== 'win32') {
      return { available: false, reason: 'Hotspot hosting requires Windows.' }
    }
    try {
      const out = await this.runner(PS_CAPABILITY)
      parseHotspotJson(out)
      return { available: true, reason: null }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      hsLog.info(`hotspot unavailable: ${message}`)
      const reason = message.includes('no-internet-profile')
        ? 'No active internet connection to share.'
        : 'This PC cannot host a hotspot (a Wi-Fi adapter is required).'
      return { available: false, reason }
    }
  }

  async start(): Promise<HotspotStatus> {
    const out = await this.runner(PS_START)
    const info = parseHotspotJson(out)
    this.startedByUs = true
    hsLog.info(`hotspot started: ${info.ssid}`)
    return { state: 'On', ssid: info.ssid, passphrase: info.passphrase }
  }

  async stop(): Promise<void> {
    await this.runner(PS_STOP)
    this.startedByUs = false
    hsLog.info('hotspot stopped')
  }

  /** Called on app quit: stop the hotspot only if we started it. */
  async cleanup(): Promise<void> {
    if (this.startedByUs) {
      try {
        await this.stop()
      } catch (err) {
        hsLog.warn('failed to stop hotspot on quit', err)
      }
    }
  }
}
