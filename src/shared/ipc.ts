/**
 * Typed IPC surface between the renderer (via preload contextBridge) and main.
 * Channel names are constants so main and preload cannot drift.
 */
import type { PhoneToDesktop, DesktopToPhone } from './protocol'
import type { LanCandidate, Settings } from './types'

export const IPC = {
  // renderer -> main (invoke)
  getState: 'app:get-state',
  setLanIp: 'app:set-lan-ip',
  rotateToken: 'app:rotate-token',
  getSettings: 'settings:get',
  setSettings: 'settings:set',
  sendSignal: 'signal:to-phone',
  vbcableDetectHint: 'vbcable:renderer-detect', // renderer reports enumerateDevices result
  vbcableInstall: 'vbcable:install',
  vbcableRegistryCheck: 'vbcable:registry-check',
  hotspotCapability: 'hotspot:capability',
  hotspotStart: 'hotspot:start',
  hotspotStop: 'hotspot:stop',
  fixFirewall: 'firewall:fix',
  copyDiagnostics: 'diagnostics:copy',
  openExternal: 'app:open-external',
  logFromRenderer: 'log:renderer',
  // main -> renderer (send)
  signalFromPhone: 'signal:from-phone',
  phoneConnected: 'phone:connected',
  phoneDisconnected: 'phone:disconnected',
  stateChanged: 'app:state-changed',
  vbcableProgress: 'vbcable:progress',
  e2eGetStats: 'e2e:get-stats'
} as const

export interface PairingInfo {
  url: string
  qrDataUrl: string
  ip: string
  port: number
  token: string
}

export interface AppState {
  pairing: PairingInfo
  lanCandidates: LanCandidate[]
  certFingerprint: string
  certNotAfter: string
  appVersion: string
  platform: string
  e2e: boolean
}

export interface HotspotCapability {
  available: boolean
  reason: string | null
}

export interface HotspotInfo {
  ssid: string
  passphrase: string
  /** WIFI:T:WPA;S:<ssid>;P:<pass>;; join string rendered as QR by the renderer */
  wifiQrDataUrl: string
}

export type VbCableProgress =
  | { step: 'downloading'; receivedBytes: number; totalBytes: number | null }
  | { step: 'extracting' }
  | { step: 'waiting-for-installer' }
  | { step: 'done' }
  | { step: 'failed'; error: string }

export interface RendererApi {
  getState(): Promise<AppState>
  setLanIp(ip: string | null): Promise<AppState>
  rotateToken(): Promise<AppState>
  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Settings>): Promise<Settings>
  sendSignal(message: DesktopToPhone): void
  onSignal(cb: (message: PhoneToDesktop) => void): () => void
  onPhoneConnected(cb: (ua: string) => void): () => void
  onPhoneDisconnected(cb: (reason: string) => void): () => void
  onStateChanged(cb: (state: AppState) => void): () => void
  reportVbCableDetected(present: boolean): void
  vbcableRegistryCheck(): Promise<boolean>
  vbcableInstall(): Promise<void>
  onVbCableProgress(cb: (p: VbCableProgress) => void): () => void
  hotspotCapability(): Promise<HotspotCapability>
  hotspotStart(): Promise<HotspotInfo>
  hotspotStop(): Promise<void>
  fixFirewall(): Promise<boolean>
  copyDiagnostics(rendererBlob: string): Promise<void>
  openExternal(url: string): void
  log(level: 'info' | 'warn' | 'error', message: string): void
}
