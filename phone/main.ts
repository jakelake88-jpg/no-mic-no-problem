import { msg, type DesktopToPhone } from '@shared/protocol'
import { SignalingClient, type SignalingState } from './signaling'
import { applyAnswer, applyCandidate, captureMic, startMicSession, type MicSession } from './rtc'

type UiState =
  | 'idle'
  | 'connecting'
  | 'streaming'
  | 'reconnecting'
  | 'kicked'
  | 'bad-token'
  | 'mic-denied'
  | 'failed'

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`missing #${id}`)
  return el as T
}

const micButton = $<HTMLButtonElement>('mic-button')
const muteButton = $<HTMLButtonElement>('mute-button')
const statusPill = $('status-pill')
const statusDetail = $('status-detail')
const meterBar = $('meter-bar')

const token = new URLSearchParams(location.search).get('token') ?? ''
const wsUrl = `wss://${location.host}/ws?token=${encodeURIComponent(token)}`

let signaling: SignalingClient | null = null
let session: MicSession | null = null
let wakeLock: WakeLockSentinel | null = null
let audioCtx: AudioContext | null = null
let meterRaf = 0
let uiState: UiState = 'idle'

// ---- logging (local ring buffer + forwarded to the desktop) ----
const logRing: string[] = []
function plog(level: 'info' | 'warn' | 'error', message: string): void {
  const line = `${new Date().toISOString()} ${level} ${message}`
  logRing.push(line)
  if (logRing.length > 200) logRing.shift()
  console[level](message)
  signaling?.send(msg({ type: 'log', level, message }))
}

function setState(state: UiState, detail = ''): void {
  uiState = state
  document.body.dataset.state = state
  const labels: Record<UiState, string> = {
    idle: 'Ready',
    connecting: 'Connecting…',
    streaming: 'Live — you are the mic',
    reconnecting: 'Reconnecting…',
    kicked: 'Another phone took over',
    'bad-token': 'Pairing code expired',
    'mic-denied': 'Microphone blocked',
    failed: 'Connection failed'
  }
  statusPill.textContent = labels[state]
  const details: Partial<Record<UiState, string>> = {
    idle: 'Tap the mic to start.',
    'bad-token': 'Re-scan the QR code shown in the desktop app.',
    kicked: 'This page was replaced by a newer connection.',
    'mic-denied':
      'Allow microphone access for this site in your browser settings, then tap the mic again.',
    failed:
      'Could not reach your PC. If you are on guest/hotel Wi-Fi, the router may block device-to-device traffic.',
    streaming: 'Keep this page open — locking your screen will stop the mic.'
  }
  statusDetail.textContent = detail || details[state] || ''
  micButton.classList.toggle(
    'active',
    state === 'streaming' || state === 'connecting' || state === 'reconnecting'
  )
  muteButton.hidden = state !== 'streaming'
}

// ---- wake lock ----
async function acquireWakeLock(): Promise<void> {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen')
      plog('info', 'wake lock acquired')
    }
  } catch (err) {
    plog('warn', `wake lock unavailable: ${String(err)}`)
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && uiState === 'streaming' && !wakeLock) {
    void acquireWakeLock()
  }
})

// ---- level meter ----
function startMeter(stream: MediaStream): void {
  audioCtx = new AudioContext()
  const analyser = audioCtx.createAnalyser()
  analyser.fftSize = 512
  audioCtx.createMediaStreamSource(stream).connect(analyser)
  const buf = new Uint8Array(analyser.frequencyBinCount)
  const tick = (): void => {
    analyser.getByteTimeDomainData(buf)
    let peak = 0
    for (const v of buf) peak = Math.max(peak, Math.abs(v - 128) / 128)
    meterBar.style.width = `${Math.min(100, Math.round(peak * 140))}%`
    meterRaf = requestAnimationFrame(tick)
  }
  meterRaf = requestAnimationFrame(tick)
}

function stopMeter(): void {
  cancelAnimationFrame(meterRaf)
  meterBar.style.width = '0%'
  void audioCtx?.close()
  audioCtx = null
}

// ---- session orchestration ----
async function beginStreaming(): Promise<void> {
  let stream: MediaStream
  try {
    stream = await captureMic()
  } catch (err) {
    plog('error', `getUserMedia failed: ${String(err)}`)
    setState('mic-denied')
    return
  }

  startMeter(stream)
  await acquireWakeLock()

  session = await startMicSession(signaling!, stream, (state) => {
    plog('info', `pc connectionState=${state}`)
    if (state === 'connected') setState('streaming')
    if (state === 'failed') {
      setState('failed')
      // ICE failure on LAN usually means client isolation; a fresh attempt
      // via signaling reconnect is still worth trying.
    }
  })
}

function teardownSession(): void {
  session?.close()
  session = null
  stopMeter()
  void wakeLock?.release().catch(() => undefined)
  wakeLock = null
}

function onSignalMessage(message: DesktopToPhone): void {
  switch (message.type) {
    case 'hello-ack':
      plog('info', `paired with desktop v${message.appVersion}`)
      void beginStreaming()
      break
    case 'answer':
      if (session) void applyAnswer(session, message)
      break
    case 'candidate':
      if (session) void applyCandidate(session, message)
      break
    case 'kicked':
      teardownSession()
      setState('kicked')
      break
    case 'error':
      plog('error', `desktop error: ${message.code} ${message.message}`)
      break
  }
}

function onSignalState(state: SignalingState): void {
  switch (state) {
    case 'connecting':
      if (uiState !== 'idle') setState(session ? 'reconnecting' : 'connecting')
      break
    case 'open':
      // fresh WS -> fresh peer connection (old one is stale after a blip)
      if (session) {
        teardownSessionKeepUi()
      }
      break
    case 'closed':
      if (uiState === 'streaming') setState('reconnecting')
      break
    case 'kicked':
      teardownSession()
      setState('kicked')
      break
    case 'bad-token':
      teardownSession()
      setState('bad-token')
      break
  }
}

function teardownSessionKeepUi(): void {
  session?.close()
  session = null
  stopMeter()
}

micButton.addEventListener('click', () => {
  if (uiState === 'streaming' || uiState === 'connecting' || uiState === 'reconnecting') {
    signaling?.send(msg({ type: 'bye' }))
    signaling?.stop()
    signaling = null
    teardownSession()
    setState('idle')
    return
  }
  if (!token) {
    setState('bad-token', 'No pairing code in the address. Scan the QR code again.')
    return
  }
  setState('connecting')
  signaling = new SignalingClient(wsUrl, { onState: onSignalState, onMessage: onSignalMessage })
  signaling.start()
})

muteButton.addEventListener('click', () => {
  if (!session) return
  session.setMuted(!session.muted)
  muteButton.textContent = session.muted ? 'Unmute' : 'Mute'
  muteButton.classList.toggle('muted', session.muted)
})

window.addEventListener('pagehide', () => {
  signaling?.send(msg({ type: 'bye' }))
})

setState('idle')
plog('info', `phone page loaded: ${navigator.userAgent}`)
