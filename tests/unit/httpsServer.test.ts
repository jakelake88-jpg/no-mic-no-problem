import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import { loadOrCreateCert } from '../../src/main/server/certs'
import { startHttpsServer, type RunningServer } from '../../src/main/server/httpsServer'

let dir: string
let running: RunningServer

function get(port: number, urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      { host: '127.0.0.1', port, path: urlPath, rejectUnauthorized: false },
      (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      }
    )
    req.on('error', reject)
  })
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nmnp-http-'))
  const phoneDir = path.join(dir, 'phone')
  fs.mkdirSync(phoneDir, { recursive: true })
  fs.writeFileSync(path.join(phoneDir, 'index.html'), '<!doctype html><h1>phone</h1>')
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'outside-root')
  const cert = loadOrCreateCert(dir, ['127.0.0.1'])
  running = await startHttpsServer({
    cert: cert.cert,
    key: cert.key,
    phoneDistDir: phoneDir,
    preferredPort: 0
  })
})

afterAll(async () => {
  await new Promise<void>((r) => running.server.close(() => r()))
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('httpsServer', () => {
  it('serves the phone page at / with no-store', async () => {
    const res = await get(running.port, '/')
    expect(res.status).toBe(200)
    expect(res.body).toContain('phone')
  })

  it('responds to /healthz', async () => {
    const res = await get(running.port, '/healthz')
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true })
  })

  it('404s unknown files', async () => {
    expect((await get(running.port, '/nope.js')).status).toBe(404)
  })

  it('blocks path traversal out of the phone dir', async () => {
    const res = await get(running.port, '/..%2Fsecret.txt')
    expect([403, 404]).toContain(res.status)
    expect(res.body).not.toContain('outside-root')
    const res2 = await get(running.port, '/%2e%2e/secret.txt')
    expect([403, 404]).toContain(res2.status)
    expect(res2.body).not.toContain('outside-root')
  })

  it('falls back to an ephemeral port when the preferred one is taken', async () => {
    const phoneDir = path.join(dir, 'phone')
    const cert = loadOrCreateCert(dir, ['127.0.0.1'])
    const second = await startHttpsServer({
      cert: cert.cert,
      key: cert.key,
      phoneDistDir: phoneDir,
      preferredPort: running.port // taken
    })
    expect(second.port).not.toBe(running.port)
    await new Promise<void>((r) => second.server.close(() => r()))
  })
})
