import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type RendererApi } from '@shared/ipc'

function subscribe<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as T))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: RendererApi = {
  getState: () => ipcRenderer.invoke(IPC.getState),
  setLanIp: (ip) => ipcRenderer.invoke(IPC.setLanIp, ip),
  rotateToken: () => ipcRenderer.invoke(IPC.rotateToken),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  setSettings: (patch) => ipcRenderer.invoke(IPC.setSettings, patch),
  sendSignal: (message) => ipcRenderer.send(IPC.sendSignal, message),
  onSignal: (cb) => subscribe(IPC.signalFromPhone, cb),
  onPhoneConnected: (cb) => subscribe(IPC.phoneConnected, cb),
  onPhoneDisconnected: (cb) => subscribe(IPC.phoneDisconnected, cb),
  onStateChanged: (cb) => subscribe(IPC.stateChanged, cb),
  reportVbCableDetected: (present) => ipcRenderer.send(IPC.vbcableDetectHint, present),
  vbcableRegistryCheck: () => ipcRenderer.invoke(IPC.vbcableRegistryCheck),
  vbcableInstall: () => ipcRenderer.invoke(IPC.vbcableInstall),
  onVbCableProgress: (cb) => subscribe(IPC.vbcableProgress, cb),
  hotspotCapability: () => ipcRenderer.invoke(IPC.hotspotCapability),
  hotspotStart: () => ipcRenderer.invoke(IPC.hotspotStart),
  hotspotStop: () => ipcRenderer.invoke(IPC.hotspotStop),
  btSupported: () => ipcRenderer.invoke(IPC.btSupported),
  btListDevices: () => ipcRenderer.invoke(IPC.btListDevices),
  btConnect: (deviceId) => ipcRenderer.send(IPC.btConnect, deviceId),
  btDisconnect: () => ipcRenderer.send(IPC.btDisconnect),
  onBtState: (cb) => subscribe(IPC.btState, cb),
  openSoundSettings: () => ipcRenderer.send(IPC.openSoundSettings),
  fixFirewall: () => ipcRenderer.invoke(IPC.fixFirewall),
  copyDiagnostics: (blob) => ipcRenderer.invoke(IPC.copyDiagnostics, blob),
  openExternal: (url) => ipcRenderer.send(IPC.openExternal, url),
  log: (level, message) => ipcRenderer.send(IPC.logFromRenderer, level, message)
}

contextBridge.exposeInMainWorld('api', api)
