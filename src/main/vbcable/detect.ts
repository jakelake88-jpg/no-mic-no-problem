import { execFile } from 'node:child_process'
import log from 'electron-log'

const vbLog = log.scope('vbcable')

/**
 * Secondary detection signal: is the VB-CABLE driver present in the registry?
 * The primary signal is the renderer's enumerateDevices() finding "CABLE Input"
 * (that tests what we actually need); this distinguishes "driver not installed"
 * from "driver installed but the endpoint is disabled" for better wizard copy.
 */
export function registryHasVbCable(
  runner: (
    cmd: string,
    args: string[],
    cb: (err: Error | null, stdout: string) => void
  ) => void = execFileRunner
): Promise<boolean> {
  return new Promise((resolve) => {
    runner('reg.exe', ['query', 'HKLM\\SOFTWARE\\VB-Audio', '/s'], (err, stdout) => {
      if (err) {
        // Key absent (exit 1) or not on Windows — either way, not detected.
        resolve(false)
        return
      }
      resolve(/VB-Audio|VBCABLE|Virtual Cable/i.test(stdout))
    })
  })
}

function execFileRunner(
  cmd: string,
  args: string[],
  cb: (err: Error | null, stdout: string) => void
): void {
  execFile(cmd, args, { windowsHide: true, timeout: 10_000 }, (err, stdout) => {
    if (err) vbLog.debug(`reg query failed: ${err.message}`)
    cb(err, stdout ?? '')
  })
}
