import { spawn, type ChildProcess } from 'node:child_process'
import log from 'electron-log'

const hfpLog = log.scope('hfp')

/**
 * Bluetooth calls (HFP hands-free) link — "enable the phone's calls toggle".
 *
 * The PC connects OUT to the phone's Hands-Free Audio Gateway RFCOMM service
 * (UUID 0x111F) and performs the HFP Service-Level-Connection handshake as a
 * hands-free unit. Outbound initiation needs no WinRT event handlers, so it
 * is scriptable from PowerShell like the other helpers.
 *
 * Scope (stated in the UI too): this makes the phone treat the PC as its
 * call-audio device. HFP still only opens an audio channel during an actual
 * telephone call, and in that channel the hands-free side SUPPLIES the mic —
 * it does not receive the phone's mic. The link doubles as a diagnostics
 * probe: every unsolicited AT event from the phone is surfaced.
 */

const PS_HFP_CONNECT = `
$ErrorActionPreference = 'Stop'
[Windows.Devices.Bluetooth.BluetoothDevice,Windows.Devices.Bluetooth,ContentType=WindowsRuntime] | Out-Null
[Windows.Devices.Bluetooth.Rfcomm.RfcommServiceId,Windows.Devices.Bluetooth.Rfcomm,ContentType=WindowsRuntime] | Out-Null
[Windows.Devices.Enumeration.DeviceInformation,Windows.Devices.Enumeration,ContentType=WindowsRuntime] | Out-Null
[Windows.Networking.Sockets.StreamSocket,Windows.Networking.Sockets,ContentType=WindowsRuntime] | Out-Null
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
$asTaskAction = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}
function AwaitAction($WinRtTask) {
  $netTask = $asTaskAction.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
}

function Emit($line) { Write-Output $line; [Console]::Out.Flush() }

# --- find the paired phone by name ---
Emit 'HFP_INFO stage=find-device'
$selector = [Windows.Devices.Bluetooth.BluetoothDevice]::GetDeviceSelectorFromPairingState($true)
$all = Await ([Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync($selector)) ([Windows.Devices.Enumeration.DeviceInformationCollection])
$target = $all | Where-Object { $_.Name -eq '__DEVICE_NAME__' } | Select-Object -First 1
if ($null -eq $target) { Emit 'HFP_ERROR find-device not-paired'; exit 1 }
$device = Await ([Windows.Devices.Bluetooth.BluetoothDevice]::FromIdAsync($target.Id)) ([Windows.Devices.Bluetooth.BluetoothDevice])
if ($null -eq $device) { Emit 'HFP_ERROR find-device open-failed'; exit 1 }

# --- locate the phone's Hands-Free Audio Gateway service (UUID 0x111F) ---
Emit 'HFP_INFO stage=find-service'
$agId = [Windows.Devices.Bluetooth.Rfcomm.RfcommServiceId]::FromUuid([Guid]'0000111F-0000-1000-8000-00805F9B34FB')
$result = Await ($device.GetRfcommServicesForIdAsync($agId)) ([Windows.Devices.Bluetooth.Rfcomm.RfcommDeviceServicesResult])
if ($result.Services.Count -eq 0) { Emit 'HFP_ERROR find-service phone-offers-no-hfp'; exit 1 }
$svc = $result.Services[0]

# --- connect RFCOMM ---
Emit 'HFP_INFO stage=rfcomm-connect'
$socket = New-Object Windows.Networking.Sockets.StreamSocket
try {
  AwaitAction ($socket.ConnectAsync($svc.ConnectionHostName, $svc.ConnectionServiceName))
} catch {
  Emit ('HFP_ERROR rfcomm-connect ' + $_.Exception.Message.Replace([Environment]::NewLine, ' '))
  exit 1
}
# PowerShell 5 cannot construct WinRT DataWriter/DataReader over socket
# streams; bridge to plain .NET streams instead.
$netOut = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForWrite($socket.OutputStream, 0)
$netIn = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($socket.InputStream, 0)

function SendAt($cmd) {
  $bytes = [System.Text.Encoding]::ASCII.GetBytes($cmd + "\`r")
  $netOut.Write($bytes, 0, $bytes.Length)
  $netOut.Flush()
}
function ReadChunk() {
  $buf = New-Object byte[] 1024
  $n = $netIn.Read($buf, 0, 1024)
  if ($n -le 0) { return $null }
  return [System.Text.Encoding]::ASCII.GetString($buf, 0, $n)
}
function Exchange($cmd) {
  Emit ('HFP_AT > ' + $cmd)
  SendAt $cmd
  $buf = ''
  for ($i = 0; $i -lt 8; $i++) {
    $chunk = ReadChunk
    if ($null -eq $chunk) { break }
    $buf += $chunk
    foreach ($line in ($chunk -split "\`r\`n")) {
      if ($line.Trim().Length -gt 0) { Emit ('HFP_AT < ' + $line.Trim()) }
    }
    if ($buf -match 'OK' -or $buf -match 'ERROR') { break }
  }
  return $buf
}

# --- HFP Service Level Connection handshake (we are the hands-free unit) ---
Emit 'HFP_INFO stage=slc'
Exchange 'AT+BRSF=0' | Out-Null
Exchange 'AT+CIND=?' | Out-Null
Exchange 'AT+CIND?' | Out-Null
Exchange 'AT+CMER=3,0,0,1' | Out-Null
Emit 'HFP_CONNECTED'

# --- hold the link; surface every unsolicited event from the phone ---
try {
  while ($true) {
    $chunk = ReadChunk
    if ($null -eq $chunk) { break }
    foreach ($line in ($chunk -split "\`r\`n")) {
      if ($line.Trim().Length -gt 0) { Emit ('HFP_EVENT ' + $line.Trim()) }
    }
  }
} catch {
  # remote closed / radio dropped
}
Emit 'HFP_CLOSED'
exit 0
`

export type HfpState = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface HfpEvent {
  state?: HfpState
  detail?: string
  /** raw AT traffic / stage info for the diagnostics panel */
  trace?: string
}

/** Interpret one stdout line from the HFP helper; null = not ours. */
export function parseHfpLine(line: string): HfpEvent | null {
  const l = line.trim()
  if (l === 'HFP_CONNECTED') return { state: 'connected' }
  if (l === 'HFP_CLOSED') return { state: 'disconnected', detail: 'closed' }
  if (l.startsWith('HFP_ERROR')) {
    return { state: 'error', detail: l.slice('HFP_ERROR'.length).trim() }
  }
  if (l.startsWith('HFP_INFO') || l.startsWith('HFP_AT') || l.startsWith('HFP_EVENT')) {
    return { trace: l }
  }
  return null
}

type SpawnFn = (script: string) => ChildProcess

const defaultSpawn: SpawnFn = (script) =>
  spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })

export class HfpLink {
  private child: ChildProcess | null = null

  constructor(
    private spawnFn: SpawnFn = defaultSpawn,
    private platform: string = process.platform
  ) {}

  get supported(): boolean {
    return this.platform === 'win32'
  }

  connect(deviceName: string, onEvent: (e: HfpEvent) => void): void {
    this.disconnect()
    onEvent({ state: 'connecting' })
    // single-quote-escape for the PowerShell string literal
    const script = PS_HFP_CONNECT.replace('__DEVICE_NAME__', deviceName.replace(/'/g, "''"))
    const child = this.spawnFn(script)
    this.child = child

    let buf = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const event = parseHfpLine(buf.slice(0, idx))
        buf = buf.slice(idx + 1)
        if (event) {
          if (event.trace) hfpLog.info(event.trace)
          else hfpLog.info(`state: ${event.state} ${event.detail ?? ''}`)
          onEvent(event)
        }
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => hfpLog.warn(`ps: ${chunk.toString().trim()}`))
    child.on('exit', (code) => {
      if (this.child === child) {
        this.child = null
        if (code !== 0) onEvent({ state: 'error', detail: `helper exited (${code})` })
        else onEvent({ state: 'disconnected' })
      }
    })
  }

  disconnect(): void {
    if (this.child) {
      const child = this.child
      this.child = null
      child.kill()
      hfpLog.info('calls link released')
    }
  }
}
