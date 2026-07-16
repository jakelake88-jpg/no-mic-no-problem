import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { execFile } from 'node:child_process'
import extract from 'extract-zip'
import log from 'electron-log'
import { VBCABLE_DOWNLOAD_URL, VBCABLE_SETUP_EXE } from '@shared/constants'
import type { VbCableProgress } from '@shared/ipc'

const vbLog = log.scope('vbcable')

export type ProgressSink = (p: VbCableProgress) => void

const MAX_REDIRECTS = 3
const MAX_ZIP_BYTES = 50 * 1024 * 1024 // driver pack is ~1MB; refuse anything absurd

export function downloadFile(
  url: string,
  dest: string,
  onProgress: (received: number, total: number | null) => void,
  redirects = 0
): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        if (redirects >= MAX_REDIRECTS) {
          reject(new Error('too many redirects'))
          return
        }
        downloadFile(
          new URL(res.headers.location, url).toString(),
          dest,
          onProgress,
          redirects + 1
        ).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      const total = res.headers['content-length'] ? Number(res.headers['content-length']) : null
      if (total !== null && total > MAX_ZIP_BYTES) {
        res.destroy()
        reject(new Error('download unexpectedly large'))
        return
      }
      const out = fs.createWriteStream(dest)
      let received = 0
      res.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (received > MAX_ZIP_BYTES) {
          req.destroy(new Error('download unexpectedly large'))
          return
        }
        onProgress(received, total)
      })
      res.pipe(out)
      out.on('finish', () => out.close(() => resolve()))
      out.on('error', reject)
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(60_000, () => req.destroy(new Error('download timed out')))
  })
}

/** Launch the VB-Audio setup exe elevated (UAC) and wait for it to exit. */
export function runElevated(
  exePath: string,
  runner: (cmd: string, args: string[], cb: (err: Error | null) => void) => void = powershellRunner
): Promise<void> {
  return new Promise((resolve, reject) => {
    // -Verb RunAs triggers UAC; -Wait resolves when the installer window closes.
    const psArgs = [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Start-Process -FilePath '${exePath.replace(/'/g, "''")}' -Verb RunAs -Wait`
    ]
    runner('powershell.exe', psArgs, (err) => (err ? reject(err) : resolve()))
  })
}

function powershellRunner(cmd: string, args: string[], cb: (err: Error | null) => void): void {
  execFile(cmd, args, { windowsHide: true }, (err) => cb(err))
}

/**
 * Guided VB-CABLE install: download -> verify -> unzip -> elevated setup.
 * The user completes VB-Audio's own installer GUI; caller re-detects afterwards.
 */
export async function installVbCable(workDir: string, progress: ProgressSink): Promise<void> {
  try {
    fs.mkdirSync(workDir, { recursive: true })
    const zipPath = path.join(workDir, 'vbcable.zip')
    const extractDir = path.join(workDir, 'unpacked')

    vbLog.info(`downloading ${VBCABLE_DOWNLOAD_URL}`)
    progress({ step: 'downloading', receivedBytes: 0, totalBytes: null })
    await downloadFile(VBCABLE_DOWNLOAD_URL, zipPath, (receivedBytes, totalBytes) =>
      progress({ step: 'downloading', receivedBytes, totalBytes })
    )

    progress({ step: 'extracting' })
    fs.rmSync(extractDir, { recursive: true, force: true })
    await extract(zipPath, { dir: extractDir })

    const setupExe = path.join(extractDir, VBCABLE_SETUP_EXE)
    if (!fs.existsSync(setupExe)) {
      throw new Error(`${VBCABLE_SETUP_EXE} not found in downloaded pack`)
    }

    vbLog.info('launching elevated VB-CABLE setup')
    progress({ step: 'waiting-for-installer' })
    await runElevated(setupExe)
    progress({ step: 'done' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    vbLog.error(`install flow failed: ${message}`)
    progress({ step: 'failed', error: message })
    throw err
  }
}
