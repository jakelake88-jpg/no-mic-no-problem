import { execFile } from 'node:child_process'
import log from 'electron-log'
import { VBCABLE_INPUT_LABEL } from '@shared/constants'

const routeLog = log.scope('audioroute')

/**
 * Per-app audio routing: sends the Bluetooth helper's playback to the
 * VB-CABLE virtual mic ("CABLE Input") automatically, replacing the manual
 * "App volume and device preferences" step.
 *
 * Windows persists a default render endpoint per application via the
 * undocumented-but-stable AudioPolicyConfig WinRT factory — the same store
 * the ms-settings:apps-volume page writes, and the approach proven in the
 * wild by EarTrumpet and SoundSwitch. The interface IID changed in 21H2, so
 * both variants are tried.
 *
 * The route targets the helper script's own process (powershell.exe): Windows
 * keys the persisted entry by executable, and the A2DP connection holder in
 * bluetooth.ts is also powershell.exe, so its audio session re-routes live.
 * Side effect (documented in the UI): while active, ANY PowerShell audio goes
 * to the virtual mic — unroute() clears the entry on disconnect/quit.
 */

/** DEVINTERFACE_AUDIO_RENDER — suffix of a render endpoint's device path. */
const AUDIO_RENDER_IFACE = '{e6327cad-dcec-4949-ae8a-991e976a79d2}'

/**
 * C# for the AudioPolicyConfig factory call, compiled in-process by
 * PowerShell's Add-Type. HSTRINGs are created explicitly (WindowsCreateString)
 * so nothing depends on the CLR's WinRT marshaling support. The 19
 * __incomplete__ methods only pad the vtable up to the three real entries —
 * layout as established by EarTrumpet's AudioPolicyConfigService.
 */
const CSHARP_ROUTER = `
using System;
using System.Runtime.InteropServices;

[ComImport]
[Guid("AB3D4648-E242-459F-B02F-541C70306324")]
[InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
public interface IAudioPolicyConfig21H2
{
    int __incomplete__add_CtxVolumeChange();
    int __incomplete__remove_CtxVolumeChanged();
    int __incomplete__add_RingerVibrateStateChanged();
    int __incomplete__remove_RingerVibrateStateChange();
    int __incomplete__SetVolumeGroupGainForId();
    int __incomplete__GetVolumeGroupGainForId();
    int __incomplete__GetActiveVolumeGroupForEndpointId();
    int __incomplete__GetVolumeGroupsForEndpoint();
    int __incomplete__GetCurrentVolumeContext();
    int __incomplete__SetVolumeGroupMuteForId();
    int __incomplete__GetVolumeGroupMuteForId();
    int __incomplete__SetRingerVibrateState();
    int __incomplete__GetRingerVibrateState();
    int __incomplete__SetPreferredChatApplication();
    int __incomplete__ResetPreferredChatApplication();
    int __incomplete__GetPreferredChatApplication();
    int __incomplete__GetCurrentChatApplications();
    int __incomplete__add_ChatContextChanged();
    int __incomplete__remove_ChatContextChanged();
    [PreserveSig] int SetPersistedDefaultAudioEndpoint(uint processId, int flow, int role, IntPtr deviceId);
    [PreserveSig] int GetPersistedDefaultAudioEndpoint(uint processId, int flow, int role, out IntPtr deviceId);
    [PreserveSig] int ClearAllPersistedApplicationDefaultEndpoints();
}

[ComImport]
[Guid("2A59116D-6C4F-45E0-A74F-707E3FEF9258")]
[InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
public interface IAudioPolicyConfigLegacy
{
    int __incomplete__add_CtxVolumeChange();
    int __incomplete__remove_CtxVolumeChanged();
    int __incomplete__add_RingerVibrateStateChanged();
    int __incomplete__remove_RingerVibrateStateChange();
    int __incomplete__SetVolumeGroupGainForId();
    int __incomplete__GetVolumeGroupGainForId();
    int __incomplete__GetActiveVolumeGroupForEndpointId();
    int __incomplete__GetVolumeGroupsForEndpoint();
    int __incomplete__GetCurrentVolumeContext();
    int __incomplete__SetVolumeGroupMuteForId();
    int __incomplete__GetVolumeGroupMuteForId();
    int __incomplete__SetRingerVibrateState();
    int __incomplete__GetRingerVibrateState();
    int __incomplete__SetPreferredChatApplication();
    int __incomplete__ResetPreferredChatApplication();
    int __incomplete__GetPreferredChatApplication();
    int __incomplete__GetCurrentChatApplications();
    int __incomplete__add_ChatContextChanged();
    int __incomplete__remove_ChatContextChanged();
    [PreserveSig] int SetPersistedDefaultAudioEndpoint(uint processId, int flow, int role, IntPtr deviceId);
    [PreserveSig] int GetPersistedDefaultAudioEndpoint(uint processId, int flow, int role, out IntPtr deviceId);
    [PreserveSig] int ClearAllPersistedApplicationDefaultEndpoints();
}

public static class AudioPolicyRouter
{
    [DllImport("combase.dll")]
    private static extern int RoGetActivationFactory(IntPtr classId, ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object factory);
    [DllImport("combase.dll", CharSet = CharSet.Unicode)]
    private static extern int WindowsCreateString([MarshalAs(UnmanagedType.LPWStr)] string src, int len, out IntPtr hstring);
    [DllImport("combase.dll")]
    private static extern int WindowsDeleteString(IntPtr hstring);

    private const string CLASS_ID = "Windows.Media.Internal.AudioPolicyConfig";
    private const int RENDER = 0; // EDataFlow.eRender

    private static void Check(int hr)
    {
        if (hr != 0) Marshal.ThrowExceptionForHR(hr);
    }

    // Empty devicePath clears the persisted entry for the process's app.
    public static void SetPersistedDefaultRender(uint processId, string devicePath)
    {
        IntPtr hDevice = IntPtr.Zero;
        IntPtr hClass = IntPtr.Zero;
        try
        {
            if (!string.IsNullOrEmpty(devicePath))
                Check(WindowsCreateString(devicePath, devicePath.Length, out hDevice));
            Check(WindowsCreateString(CLASS_ID, CLASS_ID.Length, out hClass));

            object factory;
            Guid iid = new Guid("AB3D4648-E242-459F-B02F-541C70306324");
            if (RoGetActivationFactory(hClass, ref iid, out factory) == 0)
            {
                IAudioPolicyConfig21H2 f = (IAudioPolicyConfig21H2)factory;
                for (int role = 0; role <= 2; role++) // eConsole, eMultimedia, eCommunications
                    Check(f.SetPersistedDefaultAudioEndpoint(processId, RENDER, role, hDevice));
                return;
            }
            iid = new Guid("2A59116D-6C4F-45E0-A74F-707E3FEF9258");
            Check(RoGetActivationFactory(hClass, ref iid, out factory));
            IAudioPolicyConfigLegacy g = (IAudioPolicyConfigLegacy)factory;
            for (int role = 0; role <= 2; role++)
                Check(g.SetPersistedDefaultAudioEndpoint(processId, RENDER, role, hDevice));
        }
        finally
        {
            if (hClass != IntPtr.Zero) WindowsDeleteString(hClass);
            if (hDevice != IntPtr.Zero) WindowsDeleteString(hDevice);
        }
    }
}
`

const PS_PREAMBLE = `
$ErrorActionPreference = 'Stop'
function Emit($line) { Write-Output $line; [Console]::Out.Flush() }
$src = @'
${CSHARP_ROUTER}
'@
Add-Type -TypeDefinition $src -ErrorAction Stop
`

/** Finds the active render endpoint whose registry properties mention the
 * label, then persists it as powershell.exe's default output. */
export function buildRouteScript(deviceLabel: string = VBCABLE_INPUT_LABEL): string {
  const label = deviceLabel.replace(/'/g, "''")
  return `
${PS_PREAMBLE}
$renderKey = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Render'
$endpointGuid = $null
$endpointName = $null
foreach ($k in (Get-ChildItem $renderKey -ErrorAction Stop)) {
  $state = (Get-ItemProperty -Path $k.PSPath -Name DeviceState -ErrorAction SilentlyContinue).DeviceState
  if ($state -ne 1) { continue } # 1 = DEVICE_STATE_ACTIVE
  $props = Get-ItemProperty -Path (Join-Path $k.PSPath 'Properties') -ErrorAction SilentlyContinue
  if ($null -eq $props) { continue }
  foreach ($p in $props.PSObject.Properties) {
    if ($p.Value -is [string] -and $p.Value -like ('*' + '${label}' + '*')) {
      $endpointGuid = $k.PSChildName
      $endpointName = $p.Value
      break
    }
  }
  if ($endpointGuid) { break }
}
if ($null -eq $endpointGuid) { Emit 'ROUTE_ERR virtual-mic-not-found'; exit 1 }
$devicePath = '\\\\?\\SWD#MMDEVAPI#{0.0.0.00000000}.' + $endpointGuid + '#${AUDIO_RENDER_IFACE}'
try {
  [AudioPolicyRouter]::SetPersistedDefaultRender([uint32]$PID, $devicePath)
} catch {
  Emit ('ROUTE_ERR set-endpoint ' + $_.Exception.Message.Replace([Environment]::NewLine, ' '))
  exit 1
}
Emit ('ROUTE_OK ' + $endpointName)
`
}

/** Clears the persisted powershell.exe route set by buildRouteScript. */
export function buildUnrouteScript(): string {
  return `
${PS_PREAMBLE}
try {
  [AudioPolicyRouter]::SetPersistedDefaultRender([uint32]$PID, '')
} catch {
  Emit ('ROUTE_ERR clear-endpoint ' + $_.Exception.Message.Replace([Environment]::NewLine, ' '))
  exit 1
}
Emit 'ROUTE_CLEARED'
`
}

export interface RouteResult {
  ok: boolean
  /** endpoint name on success; machine-readable reason on failure */
  detail: string
}

export function parseRouteResult(stdout: string): RouteResult {
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('ROUTE_OK')) return { ok: true, detail: line.slice('ROUTE_OK'.length).trim() }
    if (line.startsWith('ROUTE_ERR')) {
      return { ok: false, detail: line.slice('ROUTE_ERR'.length).trim() }
    }
    if (line === 'ROUTE_CLEARED') return { ok: true, detail: 'cleared' }
  }
  return { ok: false, detail: 'no result from helper' }
}

type Runner = (script: string) => Promise<string>

const defaultRunner: Runner = (script) =>
  new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 30_000 },
      (err, stdout, stderr) => {
        // The script Emits ROUTE_ERR before exiting non-zero; prefer that
        // parseable output over the generic exec error when present.
        if (err && !/ROUTE_/.test(stdout)) reject(new Error(stderr.trim() || err.message))
        else resolve(stdout)
      }
    )
  })

export class AudioRouter {
  constructor(
    private runner: Runner = defaultRunner,
    private platform: string = process.platform
  ) {}

  get supported(): boolean {
    return this.platform === 'win32'
  }

  async routeToVirtualMic(): Promise<RouteResult> {
    if (!this.supported) return { ok: false, detail: 'unsupported-platform' }
    try {
      const result = parseRouteResult(await this.runner(buildRouteScript()))
      routeLog.info(`route ${result.ok ? 'ok' : 'failed'}: ${result.detail}`)
      return result
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      routeLog.warn(`route helper failed: ${detail}`)
      return { ok: false, detail }
    }
  }

  async unroute(): Promise<void> {
    if (!this.supported) return
    try {
      const result = parseRouteResult(await this.runner(buildUnrouteScript()))
      routeLog.info(`unroute ${result.ok ? 'ok' : 'failed'}: ${result.detail}`)
    } catch (err) {
      routeLog.warn('unroute helper failed', err)
    }
  }
}
