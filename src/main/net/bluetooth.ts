import { execFile, spawn, type ChildProcess } from 'node:child_process'
import log from 'electron-log'

const btLog = log.scope('bluetooth')

/**
 * Experimental Bluetooth mode: the PC becomes an A2DP sink via the WinRT
 * AudioPlaybackConnection API (Windows 10 2004+), driven from PowerShell —
 * the same no-native-modules pattern as hotspot.ts.
 *
 * The phone page loops its mic through the phone's media output, which the
 * phone routes over Bluetooth to the PC like music. Latency is bounded by
 * A2DP itself (~100-250 ms SBC) — tunable parts live on the phone page.
 *
 * IMPORTANT lifetime detail: the A2DP sink connection lives only as long as
 * the process that opened it, so connect() keeps a PowerShell child alive
 * and disconnect() kills it.
 */

const PS_PREAMBLE = `
$ErrorActionPreference = 'Stop'
[Windows.Media.Audio.AudioPlaybackConnection,Windows.Media.Audio,ContentType=WindowsRuntime] | Out-Null
[Windows.Devices.Enumeration.DeviceInformation,Windows.Devices.Enumeration,ContentType=WindowsRuntime] | Out-Null
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}
`

const PS_LIST = `
${PS_PREAMBLE}
$selector = [Windows.Media.Audio.AudioPlaybackConnection]::GetDeviceSelector()
$found = Await ([Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync($selector)) ([Windows.Devices.Enumeration.DeviceInformationCollection])
$list = @($found | ForEach-Object { [pscustomobject]@{ id = $_.Id; name = $_.Name } })
if ($list.Count -eq 0) { '[]' } else { ConvertTo-Json -InputObject $list -Compress }
`

/** __DEVICE_ID__ is substituted (single-quote-escaped) before launch. */
const PS_CONNECT = `
${PS_PREAMBLE}
$conn = [Windows.Media.Audio.AudioPlaybackConnection]::TryCreateFromId('__DEVICE_ID__')
if ($null -eq $conn) { Write-Output 'BT_ERROR create-failed'; exit 1 }
$conn.Start()
$result = $conn.Open()
if ($result.Status -ne 'Success') { Write-Output ('BT_ERROR open-failed ' + $result.Status); exit 1 }
Write-Output 'BT_CONNECTED'
while ($true) {
  Start-Sleep -Seconds 1
  if ($conn.State -ne 'Opened') { Write-Output 'BT_CLOSED'; exit 0 }
}
`

export interface BtDevice {
  id: string
  name: string
}

export function parseDeviceList(stdout: string): BtDevice[] {
  const trimmed = stdout.trim()
  if (!trimmed) return []
  const parsed = JSON.parse(trimmed) as unknown
  const arr = Array.isArray(parsed) ? parsed : [parsed]
  return arr
    .filter(
      (d): d is Record<string, unknown> =>
        typeof d === 'object' && d !== null && typeof (d as BtDevice).id === 'string'
    )
    .map((d) => ({ id: String(d.id), name: String(d.name ?? 'Unknown device') }))
}

export type BtState = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface BtStateEvent {
  state: BtState
  detail?: string
}

/** Interpret one stdout line from the connect process; null = not a state line. */
export function parseConnectLine(line: string): BtStateEvent | null {
  const l = line.trim()
  if (l === 'BT_CONNECTED') return { state: 'connected' }
  if (l === 'BT_CLOSED') return { state: 'disconnected', detail: 'closed' }
  if (l.startsWith('BT_ERROR')) return { state: 'error', detail: l.slice('BT_ERROR'.length).trim() }
  return null
}

type ListRunner = (script: string) => Promise<string>
type SpawnFn = (script: string) => ChildProcess

const defaultListRunner: ListRunner = (script) =>
  new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 30_000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.trim() || err.message))
        else resolve(stdout)
      }
    )
  })

const defaultSpawn: SpawnFn = (script) =>
  spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })

export class BluetoothAudio {
  private child: ChildProcess | null = null

  constructor(
    private listRunner: ListRunner = defaultListRunner,
    private spawnFn: SpawnFn = defaultSpawn,
    private platform: string = process.platform
  ) {}

  get supported(): boolean {
    return this.platform === 'win32'
  }

  async listDevices(): Promise<BtDevice[]> {
    if (!this.supported) return []
    try {
      return parseDeviceList(await this.listRunner(PS_LIST))
    } catch (err) {
      btLog.warn('device enumeration failed', err)
      return []
    }
  }

  /**
   * Open the A2DP sink connection for a paired phone and hold it until
   * disconnect(). onState receives connecting/connected/disconnected/error.
   */
  connect(deviceId: string, onState: (e: BtStateEvent) => void): void {
    this.disconnect()
    onState({ state: 'connecting' })
    const script = PS_CONNECT.replace('__DEVICE_ID__', deviceId.replace(/'/g, "''"))
    const child = this.spawnFn(script)
    this.child = child

    let buf = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const event = parseConnectLine(buf.slice(0, idx))
        buf = buf.slice(idx + 1)
        if (event) {
          btLog.info(`state: ${event.state}${event.detail ? ` (${event.detail})` : ''}`)
          onState(event)
        }
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => btLog.warn(`ps: ${chunk.toString().trim()}`))
    child.on('exit', (code) => {
      if (this.child === child) {
        this.child = null
        // A clean BT_CLOSED already reported disconnected; anything else is unexpected.
        if (code !== 0) onState({ state: 'error', detail: `helper exited (${code})` })
        else onState({ state: 'disconnected' })
      }
    })
  }

  disconnect(): void {
    if (this.child) {
      const child = this.child
      this.child = null // prevents the exit handler from reporting an error
      child.kill()
      btLog.info('connection released')
    }
  }
}
