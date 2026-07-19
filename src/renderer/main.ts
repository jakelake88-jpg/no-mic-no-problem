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
  if (appState?.windowsStore) {
    // Store build: hand off to the vendor page instead of auto-installing.
    window.api.openExternal(VBCABLE_HOMEPAGE)
    wizardStep.textContent =
      'Download and run the VB-CABLE installer from the page we just opened, then click Re-check.'
    wizardRecheck.hidden = false
    return
  }
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

// ---------- Bluetooth mode (experimental) ----------

async function initBluetooth(): Promise<void> {
  if (!(await window.api.btSupported())) return
  const card = $('bluetooth')
  const deviceSelect = $<HTMLSelectElement>('bt-device-select')
  const connectBtn = $<HTMLButtonElement>('bt-connect')
  const status = $('bt-status')
  card.hidden = false
  let connected = false

  const refresh = async (): Promise<void> => {
    const devices = await window.api.btListDevices()
    deviceSelect.replaceChildren(
      ...devices.map((d) => {
        const opt = document.createElement('option')
        opt.value = d.id
        opt.textContent = d.name
        return opt
      })
    )
    if (devices.length === 0) {
      const opt = document.createElement('option')
      opt.value = ''
      opt.textContent = 'No paired phones found — pair in Windows Bluetooth settings'
      deviceSelect.replaceChildren(opt)
    }
  }

  $('bt-refresh').addEventListener('click', () => void refresh())
  $('bt-sound-settings').addEventListener('click', (e) => {
    e.preventDefault()
    window.api.openSoundSettings()
  })

  connectBtn.addEventListener('click', () => {
    if (connected) {
      window.api.btDisconnect()
      connected = false
      connectBtn.textContent = 'Connect'
      status.textContent = 'Not connected'
      return
    }
    if (!deviceSelect.value) return
    window.api.btConnect(deviceSelect.value)
  })

  window.api.onBtState((e) => {
    if (e.routing) {
      if (!connected) return // routing result arrived after a disconnect
      status.textContent =
        e.routing === 'auto'
          ? `Connected — audio routed to the virtual mic (${e.detail || 'CABLE Input'}) ✓ Start Bluetooth mode on the phone page; your game hears it on CABLE Output.`
          : `Connected, but auto-routing failed (${e.detail || 'unknown'}). One-time manual fix: open Sound settings above and set "Windows PowerShell" output to CABLE Input.`
      return
    }
    if (!e.state) return
    connected = e.state === 'connected'
    connectBtn.textContent = connected ? 'Disconnect' : 'Connect'
    status.textContent =
      e.state === 'connected'
        ? 'Connected — routing phone audio to the virtual mic…'
        : e.state === 'connecting'
          ? 'Connecting… (accept any prompt on the phone)'
          : e.state === 'error'
            ? `Failed: ${e.detail ?? 'unknown error'}. Is the phone paired and in range?`
            : 'Not connected'
  })

  // card opens -> populate the list
  card.addEventListener('toggle', () => {
    if (card.hasAttribute('open')) void refresh()
  })

  // ---- calls (hands-free) link test ----
  const hfpBtn = $<HTMLButtonElement>('hfp-connect')
  const hfpStatus = $('hfp-status')
  const hfpTrace = $<HTMLPreElement>('hfp-trace')
  let hfpConnected = false
  const traceLines: string[] = []

  hfpBtn.addEventListener('click', () => {
    if (hfpConnected) {
      window.api.hfpDisconnect()
      hfpConnected = false
      hfpBtn.textContent = 'Connect calls link'
      hfpStatus.textContent = 'Calls link: not connected'
      return
    }
    const name = deviceSelect.selectedOptions[0]?.textContent
    if (!name || !deviceSelect.value) return
    traceLines.length = 0
    hfpTrace.hidden = false
    hfpTrace.textContent = ''
    window.api.hfpConnect(name)
  })

  window.api.onHfpState((e) => {
    if (e.trace) {
      traceLines.push(e.trace.replace(/^HFP_(AT|EVENT|INFO)\s*/, ''))
      if (traceLines.length > 40) traceLines.shift()
      hfpTrace.textContent = traceLines.join('\n')
      return
    }
    hfpConnected = e.state === 'connected'
    hfpBtn.textContent = hfpConnected ? 'Disconnect calls link' : 'Connect calls link'
    hfpStatus.textContent =
      e.state === 'connected'
        ? 'Calls link: CONNECTED — check your phone: the calls toggle should now show active. Talk and watch the trace: no mic audio will arrive outside a real phone call.'
        : e.state === 'connecting'
          ? 'Calls link: connecting…'
          : e.state === 'error'
            ? `Calls link failed: ${e.detail ?? 'unknown'} (is the phone paired and in range?)`
            : 'Calls link: not connected'
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

  // connection doctor: diagnose the silent-timeout causes in one click
  const doctorBtn = $<HTMLButtonElement>('doctor-run')
  const doctorResult = $('doctor-result')
  doctorBtn.addEventListener('click', async () => {
    doctorBtn.disabled = true
    doctorBtn.textContent = 'Testing…'
    const report = await window.api.doctorRun()
    doctorResult.hidden = false
    doctorResult.replaceChildren()

    const addLine = (text: string, ok: boolean): HTMLParagraphElement => {
      const p = document.createElement('p')
      p.className = 'hint'
      p.textContent = `${ok ? '✓' : '⚠'} ${text}`
      p.style.color = ok ? 'var(--live)' : 'var(--amber)'
      doctorResult.append(p)
      return p
    }

    let anyProblem = false
    for (const prof of report.profiles) {
      const isOk = prof.category === 'private' || prof.category === 'domain'
      const line = addLine(
        `Network "${prof.alias}": ${prof.category}` +
          (isOk ? '' : ' — Windows silently blocks incoming connections on Public networks'),
        isOk
      )
      if (!isOk) {
        anyProblem = true
        const fix = document.createElement('button')
        fix.textContent = `Make "${prof.alias}" Private`
        fix.addEventListener('click', async () => {
          fix.disabled = true
          const ok = await window.api.doctorMakePrivate(prof.alias)
          fix.textContent = ok ? 'Done — re-scan the QR ✓' : 'Failed (UAC declined?)'
        })
        line.after(fix)
      }
    }
    addLine(
      report.ruleExists
        ? 'Firewall rule for this app is present'
        : 'Firewall rule missing — click Fix firewall',
      report.ruleExists
    )
    if (!report.ruleExists) anyProblem = true
    if (!anyProblem) {
      addLine(
        'PC side looks good. If the phone still times out, it is on a different network (compare the phone’s Wi‑Fi IP with the Network dropdown) or the router isolates devices — USB tethering bypasses both.',
        true
      )
    }
    doctorBtn.disabled = false
    doctorBtn.textContent = 'Test connection'
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
  if (state.platform === 'win32') {
    void initHotspot()
    void initBluetooth()
  }

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
