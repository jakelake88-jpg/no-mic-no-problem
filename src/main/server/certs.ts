import { generate } from 'selfsigned'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { X509Certificate } from 'node:crypto'
import log from 'electron-log'

export interface CertPair {
  cert: string
  key: string
  fingerprint256: string
  notAfter: Date
  sanIps: string[]
}

const CERT_FILE = 'cert.pem'
const KEY_FILE = 'key.pem'
const MIN_REMAINING_DAYS = 30
const VALIDITY_DAYS = 1095 // 3 years

function parseSanIps(cert: X509Certificate): string[] {
  // subjectAltName looks like: 'DNS:localhost, IP Address:127.0.0.1, IP Address:192.168.1.5'
  const san = cert.subjectAltName ?? ''
  return san
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('IP Address:'))
    .map((s) => s.slice('IP Address:'.length))
}

export function inspectPem(certPem: string): {
  fingerprint256: string
  notAfter: Date
  sanIps: string[]
} {
  const x509 = new X509Certificate(certPem)
  return {
    fingerprint256: x509.fingerprint256,
    notAfter: new Date(x509.validTo),
    sanIps: parseSanIps(x509)
  }
}

/** Decide whether the stored cert is still usable for the given LAN IPs. */
export function certNeedsRegen(
  info: { notAfter: Date; sanIps: string[] },
  requiredIps: string[],
  now: Date = new Date()
): boolean {
  const remainingMs = info.notAfter.getTime() - now.getTime()
  if (remainingMs < MIN_REMAINING_DAYS * 24 * 3600 * 1000) return true
  return requiredIps.some((ip) => !info.sanIps.includes(ip))
}

function generatePair(lanIps: string[]): { cert: string; key: string } {
  const attrs = [{ name: 'commonName', value: 'No Mic No Problem' }]
  const altNames: Array<{ type: number; value?: string; ip?: string }> = [
    { type: 2, value: 'localhost' }, // DNS
    { type: 7, ip: '127.0.0.1' } // IP
  ]
  for (const ip of lanIps) {
    if (ip !== '127.0.0.1') altNames.push({ type: 7, ip })
  }
  const pems = generate(attrs, {
    keySize: 2048,
    days: VALIDITY_DAYS,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames }
    ]
  })
  return { cert: pems.cert, key: pems.private }
}

/**
 * Load the persisted self-signed cert from `dir`, regenerating when missing,
 * near expiry, or when any of `lanIps` is not covered by its SANs.
 */
export function loadOrCreateCert(dir: string, lanIps: string[]): CertPair {
  fs.mkdirSync(dir, { recursive: true })
  const certPath = path.join(dir, CERT_FILE)
  const keyPath = path.join(dir, KEY_FILE)

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    try {
      const cert = fs.readFileSync(certPath, 'utf8')
      const key = fs.readFileSync(keyPath, 'utf8')
      const info = inspectPem(cert)
      if (!certNeedsRegen(info, lanIps)) {
        log.scope('certs').info(`reusing cert ${info.fingerprint256.slice(0, 23)}…`)
        return { cert, key, ...info }
      }
      log.scope('certs').info('stored cert stale (expiry or missing SAN); regenerating')
    } catch (err) {
      log.scope('certs').warn('stored cert unreadable; regenerating', err)
    }
  }

  const pair = generatePair(lanIps)
  // 0600-equivalent for the private key; best effort on Windows.
  fs.writeFileSync(certPath, pair.cert)
  fs.writeFileSync(keyPath, pair.key, { mode: 0o600 })
  const info = inspectPem(pair.cert)
  log
    .scope('certs')
    .info(`generated cert ${info.fingerprint256.slice(0, 23)}… SANs=[${info.sanIps.join(', ')}]`)
  return { ...pair, ...info }
}

export function newSessionToken(): string {
  return crypto.randomBytes(16).toString('base64url')
}

/** Constant-time token comparison; length mismatch handled without early exit on content. */
export function tokenMatches(expected: string, provided: string | null): boolean {
  if (!provided) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(provided)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}
