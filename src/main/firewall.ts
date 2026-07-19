import { execFile } from 'node:child_process'
import log from 'electron-log'
import { APP_NAME } from '@shared/constants'

const fwLog = log.scope('firewall')

/**
 * Recovery path for users who clicked "Deny" on Windows' first-run firewall
 * prompt: add an allow rule for this executable on all network profiles (home networks are
 * frequently misclassified as Public, where inbound traffic is silently
 * dropped — the industry norm for LAN apps is an any-profile rule).
 * Runs netsh elevated (one UAC prompt).
 */
export function addFirewallRule(exePath: string): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(false)
  const rule = `netsh advfirewall firewall add rule name="${APP_NAME}" dir=in action=allow program="${exePath}" profile=any enable=yes`
  const psCommand = `Start-Process -FilePath 'netsh.exe' -ArgumentList 'advfirewall','firewall','add','rule','name="${APP_NAME}"','dir=in','action=allow','program="${exePath}"','profile=any','enable=yes' -Verb RunAs -Wait`
  fwLog.info(`requesting elevated firewall rule: ${rule}`)
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psCommand],
      { windowsHide: true, timeout: 120_000 },
      (err) => {
        if (err) {
          fwLog.warn(`firewall rule failed (user may have declined UAC): ${err.message}`)
          resolve(false)
        } else {
          fwLog.info('firewall rule added')
          resolve(true)
        }
      }
    )
  })
}
