import { app, BrowserWindow, clipboard, dialog, ipcMain, session, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import QRCode from 'qrcode'
import log from 'electron-log'
import { APP_NAME, DEFAULT_PORT } from '@shared/constants'
import { IPC, type AppState, type PairingInfo } from '@shared/ipc'
import type { DesktopToPhone } from '@shared/protocol'
import { getLanCandidates } from './net/lanIp'
import { HotspotManager, wifiQrPayload } from './net/hotspot'
import { BluetoothAudio } from './net/bluetooth'
import { HfpLink } from './net/hfp'
import { loadOrCreateCert, newSessionToken, type CertPair } from './server/certs'
import { startHttpsServer, type RunningServer } from './server/httpsServer'
import { SignalingServer } from './server/signaling'
import { SettingsStore } from './settings'
import { registryHasVbCable } from './vbcable/detect'
import { installVbCable } from './vbcable/installer'
import { addFirewallRule } from './firewall'
import { makeNetworkPrivate, runConnectivityReport } from './net/doctor'
import { createTray, type TrayController } from './tray'

const IS_E2E = process.argv.includes('--e2e')
const VERBOSE = process.argv.includes('--verbose')

log.transports.file.maxSize = 5 * 1024 * 1024
log.transports.console.level = VERBOSE ? 'debug' : 'info'
log.transports.file.level = 'debug'
log.initialize()
const mainLog = log.scope('main')

process.on('uncaughtException', (err) => {
  mainLog.error('uncaughtException', err)
  if (!IS_E2E) dialog.showErrorBox(APP_NAME, `Unexpected error:\n${err.message}`)
})
process.on('unhandledRejection', (reason) => {
  mainLog.error('unhandledRejection', reason)
})

interface Runtime {
  win: BrowserWindow | null
  server: RunningServer | null
  signaling: SignalingServer | null
  cert: CertPair | null
  token: string
  tray: TrayController | null
  quitting: boolean
}

const runtime: Runtime = {
  win: null,
  server: null,
  signaling: null,
  cert: null,
  token: newSessionToken(),
  tray: null,
  quitting: false
}

const settings = () => new SettingsStore(app.getPath('userData'))
let settingsStore: SettingsStore
const hotspot = new HotspotManager()
const bluetooth = new BluetoothAudio()
const hfp = new HfpLink()

function chooseIp(): string {
  const candidates = getLanCandidates()
  const chosen = settingsStore.get().chosenIp
  if (chosen && candidates.some((c) => c.address === chosen)) return chosen
  return candidates[0]?.address ?? '127.0.0.1'
}

async function buildPairing(): Promise<PairingInfo> {
  const ip = chooseIp()
  const port = runtime.server?.port ?? settingsStore.get().port
  const url = `https://${ip}:${port}/?token=${runtime.token}`
  const qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 320 })
  return { url, qrDataUrl, ip, port, token: runtime.token }
}

async function buildState(): Promise<AppState> {
  return {
    pairing: await buildPairing(),
    lanCandidates: getLanCandidates(),
    certFingerprint: runtime.cert?.fingerprint256 ?? '',
    certNotAfter: runtime.cert?.notAfter.toISOString() ?? '',
    appVersion: app.getVersion(),
    platform: process.platform,
    windowsStore: process.windowsStore === true,
    e2e: IS_E2E
  }
}

async function broadcastState(): Promise<void> {
  if (runtime.win && !runtime.win.isDestroyed()) {
    runtime.win.webContents.send(IPC.stateChanged, await buildState())
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.getState, () => buildState())

  ipcMain.handle(IPC.setLanIp, async (_e, ip: string | null) => {
    settingsStore.set({ chosenIp: ip })
    await restartServerIfNeeded()
    return buildState()
  })

  ipcMain.handle(IPC.rotateToken, async () => {
    runtime.token = newSessionToken()
    runtime.signaling?.setToken(runtime.token)
    mainLog.info('pairing token rotated')
    return buildState()
  })

  ipcMain.handle(IPC.getSettings, () => settingsStore.get())

  ipcMain.handle(IPC.setSettings, (_e, patch) => {
    const next = settingsStore.set(patch)
    if ('autoLaunch' in patch && process.platform === 'win32') {
      app.setLoginItemSettings({ openAtLogin: next.autoLaunch, args: ['--hidden'] })
    }
    return next
  })

  ipcMain.on(IPC.sendSignal, (_e, message: DesktopToPhone) => {
    runtime.signaling?.sendToPhone(message)
  })

  ipcMain.on(IPC.logFromRenderer, (_e, level: 'info' | 'warn' | 'error', message: string) => {
    log.scope('renderer')[level](message)
  })

  ipcMain.on(IPC.vbcableDetectHint, (_e, present: boolean) => {
    mainLog.info(`renderer VB-CABLE detection: ${present ? 'present' : 'absent'}`)
  })

  ipcMain.handle(IPC.vbcableRegistryCheck, () => registryHasVbCable())

  ipcMain.handle(IPC.vbcableInstall, async () => {
    if (process.windowsStore) {
      // Store policy: no third-party installer downloads from a Store build.
      // The renderer routes users to vb-audio.com instead of calling this.
      throw new Error('driver auto-install is disabled in the Microsoft Store build')
    }
    const workDir = path.join(app.getPath('userData'), 'vbcable')
    await installVbCable(workDir, (p) => {
      runtime.win?.webContents.send(IPC.vbcableProgress, p)
    })
  })

  ipcMain.handle(IPC.hotspotCapability, () => hotspot.capability())

  ipcMain.handle(IPC.hotspotStart, async () => {
    const info = await hotspot.start()
    // Hotspot adapter appears asynchronously; regenerate pairing state so the
    // served IP can switch to 192.168.137.1 (rankCandidates scores it highest).
    setTimeout(() => void restartServerIfNeeded().then(broadcastState), 2_000)
    const wifiQrDataUrl = await QRCode.toDataURL(wifiQrPayload(info.ssid, info.passphrase), {
      margin: 1,
      width: 320
    })
    return { ssid: info.ssid, passphrase: info.passphrase, wifiQrDataUrl }
  })

  ipcMain.handle(IPC.hotspotStop, async () => {
    await hotspot.stop()
    await broadcastState()
  })

  ipcMain.handle(IPC.btSupported, () => bluetooth.supported)

  ipcMain.handle(IPC.btListDevices, () => bluetooth.listDevices())

  ipcMain.on(IPC.btConnect, (_e, deviceId: string) => {
    bluetooth.connect(deviceId, (event) => {
      runtime.win?.webContents.send(IPC.btState, event)
    })
  })

  ipcMain.on(IPC.btDisconnect, () => bluetooth.disconnect())

  ipcMain.on(IPC.hfpConnect, (_e, deviceName: string) => {
    hfp.connect(deviceName, (event) => {
      runtime.win?.webContents.send(IPC.hfpState, event)
    })
  })

  ipcMain.on(IPC.hfpDisconnect, () => hfp.disconnect())

  ipcMain.on(IPC.openSoundSettings, () => {
    // App volume & device preferences: where the user routes the Bluetooth
    // helper's output to CABLE Input (one-time; Windows remembers it).
    void shell.openExternal('ms-settings:apps-volume')
  })

  ipcMain.handle(IPC.fixFirewall, () => addFirewallRule(process.execPath))

  ipcMain.handle(IPC.doctorRun, () => runConnectivityReport())

  ipcMain.handle(IPC.doctorMakePrivate, (_e, alias: string) => makeNetworkPrivate(alias))

  ipcMain.handle(IPC.copyDiagnostics, async (_e, rendererBlob: string) => {
    const state = await buildState()
    const blob = [
      `${APP_NAME} diagnostics — ${new Date().toISOString()}`,
      `version=${state.appVersion} platform=${state.platform}`,
      `served=${state.pairing.ip}:${state.pairing.port}`,
      `cert=${state.certFingerprint} notAfter=${state.certNotAfter}`,
      `lanCandidates=${JSON.stringify(state.lanCandidates)}`,
      '--- renderer ---',
      rendererBlob,
      '--- recent log ---',
      readLogTail()
    ].join('\n')
    clipboard.writeText(blob) // token deliberately excluded
  })

  ipcMain.on(IPC.openExternal, (_e, url: string) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
  })
}

function readLogTail(): string {
  try {
    const file = log.transports.file.getFile().path
    const content = fs.readFileSync(file, 'utf8')
    return content.split('\n').slice(-100).join('\n')
  } catch {
    return '(log unavailable)'
  }
}

async function startServer(): Promise<void> {
  const candidates = getLanCandidates().map((c) => c.address)
  runtime.cert = loadOrCreateCert(app.getPath('userData'), candidates)

  const phoneDistDir = path.join(__dirname, '../phone')
  const { cert, key } = runtime.cert
  runtime.server = await startHttpsServer({
    cert,
    key,
    phoneDistDir,
    preferredPort: IS_E2E ? 0 : (settingsStore.get().port ?? DEFAULT_PORT)
  })

  runtime.signaling = new SignalingServer(runtime.server.server, runtime.token, app.getVersion(), {
    onPhoneConnected: (ua) => {
      runtime.tray?.setStatus('phone connected')
      runtime.win?.webContents.send(IPC.phoneConnected, ua)
    },
    onPhoneDisconnected: (reason) => {
      runtime.tray?.setStatus('waiting for phone')
      runtime.win?.webContents.send(IPC.phoneDisconnected, reason)
    },
    onPhoneMessage: (message) => {
      runtime.win?.webContents.send(IPC.signalFromPhone, message)
    }
  })

  if (IS_E2E) {
    // Machine-readable readiness line consumed by tests/e2e.
    console.log(`E2E_READY ${JSON.stringify({ port: runtime.server.port, token: runtime.token })}`)
  }
}

async function restartServerIfNeeded(): Promise<void> {
  // Cheap approach: cert SAN revalidation + rebind. Called on IP choice change
  // and periodic interface polling. Skips work when nothing changed.
  const candidates = getLanCandidates().map((c) => c.address)
  const currentFp = runtime.cert?.fingerprint256
  const cert = loadOrCreateCert(app.getPath('userData'), candidates)
  if (cert.fingerprint256 !== currentFp) {
    mainLog.info('certificate changed; restarting HTTPS server')
    runtime.signaling?.close()
    await new Promise<void>((r) => runtime.server?.server.close(() => r()))
    runtime.cert = cert
    await startServer()
  }
  await broadcastState()
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 520,
    height: 680,
    minWidth: 420,
    minHeight: 560,
    show: !settingsStore.get().startMinimized && !process.argv.includes('--hidden'),
    autoHideMenuBar: true,
    title: APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })
  runtime.win = win

  // Security: never navigate away from our bundled UI, never open windows.
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  win.on('close', (e) => {
    if (settingsStore.get().closeToTray && !runtime.quitting && !IS_E2E) {
      e.preventDefault()
      win.hide()
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    runtime.win?.show()
    runtime.win?.focus()
  })

  void app.whenReady().then(async () => {
    settingsStore = settings()

    // Grant media (device enumeration/playout) to our own renderer only;
    // deny everything else. Required for enumerateDevices labels + setSinkId.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
      cb(permission === 'media')
    })

    registerIpc()
    await startServer()
    createWindow()

    if (!IS_E2E) {
      runtime.tray = createTray(runtime.win!, () => {
        runtime.quitting = true
      })
      runtime.tray.setStatus('waiting for phone')
    }

    // React to DHCP/interface changes (new Wi-Fi, hotspot up/down, cable pulled).
    setInterval(() => void restartServerIfNeeded(), 30_000)
  })

  app.on('before-quit', () => {
    runtime.quitting = true
  })

  app.on('will-quit', (e) => {
    e.preventDefault()
    bluetooth.disconnect()
    hfp.disconnect()
    void hotspot.cleanup().finally(() => {
      runtime.signaling?.close()
      runtime.server?.server.close()
      app.exit(0)
    })
  })

  app.on('window-all-closed', () => {
    // Tray keeps us alive on Windows unless the user chose Quit.
    if (runtime.quitting || IS_E2E || process.platform !== 'win32') app.quit()
  })
}
