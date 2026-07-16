export const APP_NAME = 'No Mic? No Problem'
export const APP_ID = 'com.nomicnoproblem.app'

/** Default HTTPS/WSS port; falls back to an ephemeral port when taken. */
export const DEFAULT_PORT = 43110

/** Playback device label fragment that identifies the VB-CABLE input endpoint. */
export const VBCABLE_INPUT_LABEL = 'CABLE Input'
/** Recording device (what the game selects as its microphone). Used in copy only. */
export const VBCABLE_OUTPUT_LABEL = 'CABLE Output'

/**
 * VB-CABLE driver pack download. VB-Audio revs this file in place, so we do not
 * pin a hash; on HTTP failure the wizard falls back to opening VBCABLE_HOMEPAGE.
 */
export const VBCABLE_DOWNLOAD_URL =
  'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip'
export const VBCABLE_HOMEPAGE = 'https://vb-audio.com/Cable/'
export const VBCABLE_SETUP_EXE = 'VBCABLE_Setup_x64.exe'

/** Receiver jitter buffer targets (ms) exposed in the UI. */
export const JITTER_TARGET_LOW_MS = 20
export const JITTER_TARGET_DEFAULT_MS = 40
export const JITTER_TARGET_STABLE_MS = 80
