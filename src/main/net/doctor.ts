import { execFile } from 'node:child_process'
import log from 'electron-log'
import { APP_NAME } from '@shared/constants'

const docLog = log.scope('doctor')

/**
 * Connection doctor: self-diagnose the two silent killers of LAN reachability
 * on Windows — a network classified as Public (inbound silently dropped) and
 * a missing firewall allow rule. Industry-standard UX for LAN apps: diagnose
 * in-app and offer a one-click elevated repair.
 */

const PS_REPORT = `
$ErrorActionPreference = 'SilentlyContinue'
$profiles = @(Get-NetConnectionProfile | Select-Object InterfaceAlias, NetworkCategory)
$rule = (netsh advfirewall firewall show rule name="${APP_NAME}" | Out-String)
[pscustomobject]@{
  profiles = $profiles
  ruleExists = ($rule -match 'Enabled')
} | ConvertTo-Json -Compress -Depth 3
`

export interface NetworkProfileInfo {
  alias: string
  /** 'public' networks silently drop unsolicited inbound traffic */
  category: 'public' | 'private' | 'domain' | 'unknown'
}

export interface ConnectivityReport {
  profiles: NetworkProfileInfo[]
  ruleExists: boolean
}

function mapCategory(raw: unknown): NetworkProfileInfo['category'] {
  // PS5 serializes the enum as a number: 0 Public, 1 Private, 2 DomainAuthenticated
  if (raw === 0 || raw === 'Public') return 'public'
  if (raw === 1 || raw === 'Private') return 'private'
  if (raw === 2 || raw === 'DomainAuthenticated') return 'domain'
  return 'unknown'
}

export function parseReport(stdout: string): ConnectivityReport {
  const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>
  const rawProfiles = parsed.profiles
  const arr = Array.isArray(rawProfiles) ? rawProfiles : rawProfiles ? [rawProfiles] : []
  return {
    profiles: arr
      .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
      .map((p) => ({
        alias: String(p.InterfaceAlias ?? 'unknown'),
        category: mapCategory(p.NetworkCategory)
      })),
    ruleExists: parsed.ruleExists === true
  }
}

type Runner = (script: string) => Promise<string>

const defaultRunner: Runner = (script) =>
  new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 30_000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.trim() || err.message))
        else resolve(stdout)
      }
    )
  })

export async function runConnectivityReport(
  runner: Runner = defaultRunner,
  platform: string = process.platform
): Promise<ConnectivityReport> {
  if (platform !== 'win32') return { profiles: [], ruleExists: false }
  try {
    return parseReport(await runner(PS_REPORT))
  } catch (err) {
    docLog.warn('connectivity report failed', err)
    return { profiles: [], ruleExists: false }
  }
}

/** Elevated one-click switch of a network to Private (stops the silent drops). */
export function makeNetworkPrivate(
  alias: string,
  runner: Runner = defaultRunner,
  platform: string = process.platform
): Promise<boolean> {
  if (platform !== 'win32') return Promise.resolve(false)
  const inner = `Set-NetConnectionProfile -InterfaceAlias '${alias.replace(/'/g, "''")}' -NetworkCategory Private`
  const script = `Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-Command',@'
${inner}
'@ -Verb RunAs -Wait`
  docLog.info(`requesting elevated: ${inner}`)
  return runner(script).then(
    () => true,
    (err) => {
      docLog.warn(`make-private failed (UAC declined?): ${err.message}`)
      return false
    }
  )
}
