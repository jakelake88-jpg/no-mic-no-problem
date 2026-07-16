/** Types shared across main, renderer, and tests. */

export interface Settings {
  /** Persisted user choice of served LAN IP; null = auto (highest-ranked). */
  chosenIp: string | null
  /** Persisted output device id; null = auto (prefer CABLE Input). */
  outputDeviceId: string | null
  port: number
  closeToTray: boolean
  startMinimized: boolean
  autoLaunch: boolean
  jitterTargetMs: number
  /** User dismissed the VB-CABLE banner ("use another output device instead"). */
  vbcableBannerDismissed: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  chosenIp: null,
  outputDeviceId: null,
  port: 43110,
  closeToTray: true,
  startMinimized: false,
  autoLaunch: false,
  jitterTargetMs: 40,
  vbcableBannerDismissed: false
}

export interface LanCandidate {
  address: string
  interfaceName: string
  /** Higher ranks first in the UI / auto-pick. */
  score: number
  /** Best-effort classification for UI labels. */
  kind: 'ethernet-or-wifi' | 'windows-hotspot' | 'usb-tether' | 'virtual' | 'other'
}
