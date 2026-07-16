import type { AppState } from '@shared/ipc'
import type { PhoneToDesktop } from '@shared/protocol'
import { VBCABLE_HOMEPAGE, VBCABLE_OUTPUT_LABEL } from '@shared/constants'
import { AudioOut } from './audioOut'
import { addCandidate, answerOffer, type ReceiverSession, type ReceiverStats } from './rtc'

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`missing #${id}`)
  return el as T
}

const connPill = $('conn-pill')
const qrImg = $<HTMLImageElement>('qr')
const pairUrl = $('pair-url')
const ipSelect = $<HTMLSelectElement>('ip-select')
const rotateBtn = $<HTMLButtonElement>('rotate-token')
const streamingCard = $('streaming')
const pairingCard = $('pairing')
const meterBar = $('meter-bar')
const statsLine = $('stats-line')
const outputSelect = $<HTMLSelectElement>('output-select')
const routingNote = $('routing-note')
const latencySelect = $<HTMLSelectElement>('latency-select')
const muteToggle = $<HTMLButtonElement>('mute-toggle')
const banner = $('vbcable-banner')
const diagText = $('diag-text')

const audioOut = new AudioOut()
let session: ReceiverSession | null = null
let lastStats: ReceiverStats | null = null
let appState: AppState | null = null
let phase: 'waiting' | 'phone-connected' | 'streaming' = 'waiting'
let vbCablePresent = false

function log(level: 'info' | 'warn' | 'error', message: string): void {
  window.api.log(level, `[ui] ${message}`)
}

function setPhase(next: typeof phase): void {
  phase = next
  document.body.dataset.phase = next
  streamingCard.hidden = next !== 'streaming'
  pairingCard.hidden = next === 'streaming'
  connPill.textContent =
    next === 'waiting'
      ? 'Waiting for your phone'
      : next === 'phone-connected'
        ? 'Phone connected — starting audio…'
        : 'Live'
  connPill.className = `pill ${next}`
}

// ---------- pairing ----------

function renderPairing(state: AppState): void {
  appState = state
  qrImg.src = state.pairing.qrDataUrl
  pairUrl.textContent = state.pairing.url
  ipSelect.replaceChildren(
    ...state.lanCandidates.map((c) => {
      const opt = document.createElement('option')
      opt.value = c.address
      const label =
        c.kind === 'usb-tether'
          ? 'via USB cable'
          : c.kind === 'windows-hotspot'
            ? 'via PC hotspot'
            : c.kind === 'virtual'
              ? 'virtual adapter'
              : c.interfaceName
      opt.textContent = `${c.address} (${label})`
      opt.selected = c.address === state.pairing.ip
      return opt
    })
  )
}

ipSelect.addEventListener('change', () => {
  void window.api.setLanIp(ipSelect.value).then(renderPairing)
})
rotateBtn.addEventListener('click', () => {
  void window.api.rotateToken().then(renderPairing)
})

// ---------- WebRTC ----------

async function handleSignal(message: PhoneToDesktop): Promise<void> {
  switch (message.type) {
    case 'offer': {
      session?.close()
      const jitter = Number(latencySelect.value)
      session = await answerOffer(
        message,
        (m) => window.api.sendSignal(m),
        (stream) => {
          audioOut.attach(stream)
          setPhase('streaming')
        },
        (state) => {
          log('info', `pc state=${state}`)
          if (state === 'failed') {
            statsLine.textContent =
              'Connection failed — your router may block device-to-device traffic (client isolation).'
          }
        },
        jitter
      )
      break
    }
    case 'candidate':
      if (session) void addCandidate(session, message)
      break
    case 'mic-state':
      statsLine.textContent = message.muted ? 'Phone muted itself' : statsLine.textContent
      break
    case 'bye':
      teardown('phone ended the session')
      break
    case 'hello':
    case 'log':
      break // handled in main
  }
}

function teardown(reason: string): void {
  log('info', `teardown: ${reason}`)
  session?.close()
  session = null
  audioOut.detach()
  setPhase('waiting')
}

// ---------- streaming UI ----------

async function refreshOutputs(): Promise<void> {
  const settings = await window.api.getSettings()
  const chosen = await audioOut.autoSelect(settings.outputDeviceId)
  const outputs = await audioOut.listOutputs()
  vbCablePresent = outputs.some((o) => o.isVbCable)
  window.api.reportVbCableDetected(vbCablePresent)
  outputSelect.replaceChildren(
    ...outputs.map((o) => {
      const opt = document.createElement('option')
      opt.value = o.deviceId
      opt.textContent = o.isVbCable ? `${o.label} — virtual mic` : o.label
      opt.selected = o.deviceId === chosen?.deviceId
      return opt
    })
  )
  routingNote.textContent = chosen?.isVbCable
    ? `Routing to the virtual mic — pick "${VBCABLE_OUTPUT_LABEL}" in your game.`
    : vbCablePresent
      ? 'Not routed to the virtual mic — games will not hear this output.'
      : ''
  banner.hidden = vbCablePresent || appState?.platform !== 'win32' || bannerDismissed
}

outputSelect.addEventListener('change', () => {
  void audioOut.setSink(outputSelect.value).then(() => {
    void window.api.setSettings({ outputDeviceId: outputSelect.value })
    void refreshOutputs()
  })
})

latencySelect.addEventListener('change', () => {
  const ms = Number(latencySelect.value)
  session?.setJitterTarget(ms)
  void window.api.setSettings({ jitterTargetMs: ms })
})

muteToggle.addEventListener('click', () => {
  audioOut.muted = !audioOut.muted
  muteToggle.textContent = audioOut.muted ? 'Unmute' : 'Mute'
  muteToggle.classList.toggle('muted', audioOut.muted)
})

// meters + stats loop
setInterval(() => {
  meterBar.style.width = `${Math.min(100, Math.round(audioOut.level() * 140))}%`
}, 66)

setInterval(() => {
  if (!session) return
  void session.getStats().then((s) => {
    lastStats = s
    const rtt = s.rttMs === null ? '—' : `${s.rttMs} ms`
    statsLine.textContent = `RTT ${rtt} · jitter ${s.jitterMs} ms · buffer ${s.jitterBufferMs ?? '—'} ms · loss ${s.packetsLost}`
  })
}, 1000)

// ---------- VB-CABLE wizard ----------

const wizard = $('wizard')
const wizardStep = $('wizard-step')
const wizardProgress = $('wizard-progress')
const wizardGo = $<HTMLButtonElement>('wizard-go')
const wizardRecheck = $<HTMLButtonElement>('wizard-recheck')
let bannerDismissed = false

$('vbcable-setup').addEventListener('click', () => {
  wizard.hidden = false
})
$('vbcable-dismiss').addEventListener('click', () => {
  bannerDismissed = true
  banner.hidden = true
  void window.api.setSettings({ vbcableBannerDismissed: true })
})
$('wizard-close').addEventListener('click', () => {
  wizard.hidden = true
})
$('vbcable-homepage').addEventListener('click', (e) => {
  e.preventDefault()
  window.api.openExternal(VBCABLE_HOMEPAGE)
})

wizardGo.addEventListener('click', () => {
  wizardGo.disabled = true
  wizardStep.textContent = 'Starting download…'
  window.api.vbcableInstall().catch((err: Error) => {
    wizardStep.textContent = `Failed: ${err.message}. Use the vb-audio.com link below, then Re-check.`
    wizardGo.disabled = false
    wizardRecheck.hidden = false
  })
})

window.api.onVbCableProgress((p) => {
  switch (p.step) {
    case 'downloading': {
      const pct = p.totalBytes ? Math.round((p.receivedBytes / p.totalBytes) * 100) : null
      wizardStep.textContent = pct === null ? 'Downloading…' : `Downloading… ${pct}%`
      wizardProgress.style.width = `${pct ?? 30}%`
      break
    }
    case 'extracting':
      wizardStep.textContent = 'Unpacking…'
      wizardProgress.style.width = '70%'
      break
    case 'waiting-for-installer':
      wizardStep.textContent =
        'Complete the VB-Audio installer window (click "Install Driver"), then click Re-check.'
      wizardProgress.style.width = '85%'
      wizardRecheck.hidden = false
      break
    case 'done':
      wizardStep.textContent = 'Installer finished — checking for the device…'
      wizardProgress.style.width = '100%'
      wizardRecheck.hidden = false
      void recheckVbCable()
      break
    case 'failed':
      wizardStep.textContent = `Failed: ${p.error}. Use the vb-audio.com link below, then Re-check.`
      wizardGo.disabled = false
      wizardRecheck.hidden = false
      break
  }
})

async function recheckVbCable(): Promise<void> {
  await refreshOutputs()
  if (vbCablePresent) {
    wizardStep.textContent = 'Virtual mic detected and selected. You are all set!'
    wizard.hidden = true
  } else {
    const inRegistry = await window.api.vbcableRegistryCheck()
    wizardStep.textContent = inRegistry
      ? 'Driver installed but the device is not visible yet — a reboot usually fixes this.'
      : 'Still not detected. Finish the VB-Audio installer, or reboot and try again.'
  }
}
wizardRecheck.addEventListener('click', () => void recheckVbCable())

// ---------- hotspot ----------

const hotspotToggle = $<HTMLButtonElement>('hotspot-toggle')
const hotspotPanel = $('hotspot-panel')
const hotspotQr = $<HTMLImageElement>('hotspot-qr')
const hotspotCreds = $('hotspot-creds')

async function initHotspot(): Promise<void> {
  const cap = await window.api.hotspotCapability()
  hotspotToggle.hidden = false
  if (!cap.available) {
    hotspotToggle.disabled = true
    hotspotToggle.textContent = cap.reason ?? 'Hotspot unavailable'
    return
  }
  hotspotToggle.addEventListener('click', async () => {
    hotspotToggle.disabled = true
    hotspotToggle.textContent = 'Starting hotspot…'
    try {
      const info = await window.api.hotspotStart()
      hotspotQr.src = info.wifiQrDataUrl
      hotspotCreds.textContent = `${info.ssid} / ${info.passphrase}`
      hotspotPanel.hidden = false
      hotspotToggle.hidden = true
    } catch (err) {
      hotspotToggle.textContent = `Hotspot failed: ${(err as Error).message}`
    }
  })
  $('hotspot-stop').addEventListener('click', async () => {
    await window.api.hotspotStop()
    hotspotPanel.hidden = true
    hotspotToggle.hidden = false
    hotspotToggle.disabled = false
    hotspotToggle.textContent = 'Host a hotspot instead'
  })
}

// ---------- settings ----------

async function initSettings(): Promise<void> {
  const s = await window.api.getSettings()
  bannerDismissed = s.vbcableBannerDismissed
  const closeToTray = $<HTMLInputElement>('set-close-to-tray')
  const autoLaunch = $<HTMLInputElement>('set-autolaunch')
  const startMin = $<HTMLInputElement>('set-startmin')
  closeToTray.checked = s.closeToTray
  autoLaunch.checked = s.autoLaunch
  startMin.checked = s.startMinimized
  latencySelect.value = String(s.jitterTargetMs)
  closeToTray.addEventListener('change', () =>
    window.api.setSettings({ closeToTray: closeToTray.checked })
  )
  autoLaunch.addEventListener('change', () =>
    window.api.setSettings({ autoLaunch: autoLaunch.checked })
  )
  startMin.addEventListener('change', () =>
    window.api.setSettings({ startMinimized: startMin.checked })
  )
  $('fix-firewall').addEventListener('click', async () => {
    const ok = await window.api.fixFirewall()
    $('fix-firewall').textContent = ok
      ? 'Firewall rule added ✓'
      : 'Could not add rule (UAC declined?)'
  })
}

// ---------- diagnostics ----------

function rendererDiagnostics(): string {
  return [
    `phase=${phase} vbCable=${vbCablePresent}`,
    `output=${outputSelect.selectedOptions[0]?.textContent ?? 'n/a'}`,
    `stats=${JSON.stringify(lastStats)}`,
    `pc=${session ? session.pc.connectionState : 'none'}`
  ].join('\n')
}

setInterval(() => {
  if (!$('diagnostics').hasAttribute('open')) return
  diagText.textContent = [
    rendererDiagnostics(),
    `served=${appState?.pairing.ip}:${appState?.pairing.port}`,
    `cert=${appState?.certFingerprint.slice(0, 29)}…`,
    `version=${appState?.appVersion}`
  ].join('\n')
}, 1000)

$('copy-diagnostics').addEventListener('click', async () => {
  await window.api.copyDiagnostics(rendererDiagnostics())
  $('copy-diagnostics').textContent = 'Copied ✓'
  setTimeout(() => ($('copy-diagnostics').textContent = 'Copy diagnostics'), 1500)
})

// ---------- e2e hooks ----------

declare global {
  interface Window {
    __e2e?: {
      phase: () => string
      stats: () => ReceiverStats | null
      remoteSdp: () => string
    }
  }
}

// ---------- boot ----------

async function boot(): Promise<void> {
  const state = await window.api.getState()
  renderPairing(state)
  setPhase('waiting')
  await initSettings()
  await refreshOutputs()
  if (state.platform === 'win32') void initHotspot()

  window.api.onSignal((m) => void handleSignal(m))
  window.api.onPhoneConnected((ua) => {
    log('info', `phone connected: ${ua}`)
    setPhase('phone-connected')
  })
  window.api.onPhoneDisconnected((reason) => {
    if (reason !== 'replaced') teardown(`phone disconnected (${reason})`)
  })
  window.api.onStateChanged(renderPairing)
  navigator.mediaDevices.addEventListener('devicechange', () => void refreshOutputs())

  if (state.e2e) {
    window.__e2e = {
      phase: () => phase,
      stats: () => lastStats,
      remoteSdp: () => session?.pc.remoteDescription?.sdp ?? ''
    }
  }
}

void boot()
