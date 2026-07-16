import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { loadOrCreateCert } from '../../src/main/server/certs'
import { startHttpsServer, type RunningServer } from '../../src/main/server/httpsServer'
import { SignalingServer, type SignalingEvents } from '../../src/main/server/signaling'
import { CLOSE_BAD_TOKEN, CLOSE_REPLACED } from '../../src/shared/protocol'

const TOKEN = 'test-token-1234567890'

let dir: string
let running: RunningServer
let signaling: SignalingServer
let events: { [K in keyof SignalingEvents]: ReturnType<typeof vi.fn> }

function connect(token: string): WebSocket {
  return new WebSocket(`wss://127.0.0.1:${running.port}/ws?token=${token}`, {
    rejectUnauthorized: false
  })
}

function once<T>(ws: WebSocket, event: string): Promise<T> {
  return new Promise((resolve) =>
    ws.once(event, ((...args: unknown[]) => resolve(args as T)) as never)
  )
}

async function openAndHello(ws: WebSocket): Promise<void> {
  await once(ws, 'open')
  ws.send(JSON.stringify({ v: 1, type: 'hello', ua: 'vitest' }))
  await new Promise<void>((resolve) => {
    ws.on('message', (data) => {
      if (JSON.parse(data.toString()).type === 'hello-ack') resolve()
    })
  })
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nmnp-sig-'))
  const phoneDir = path.join(dir, 'phone')
  fs.mkdirSync(phoneDir)
  fs.writeFileSync(path.join(phoneDir, 'index.html'), 'ok')
  const cert = loadOrCreateCert(dir, ['127.0.0.1'])
  running = await startHttpsServer({
    cert: cert.cert,
    key: cert.key,
    phoneDistDir: phoneDir,
    preferredPort: 0
  })
  events = {
    onPhoneConnected: vi.fn(),
    onPhoneDisconnected: vi.fn(),
    onPhoneMessage: vi.fn()
  }
  signaling = new SignalingServer(running.server, TOKEN, '0.0.0-test', events)
})

afterEach(async () => {
  signaling.close()
  await new Promise<void>((r) => running.server.close(() => r()))
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('SignalingServer', () => {
  it('rejects a bad token with close code 4003', async () => {
    const ws = connect('wrong-token')
    const [code] = await once<[number]>(ws, 'close')
    expect(code).toBe(CLOSE_BAD_TOKEN)
    expect(events.onPhoneConnected).not.toHaveBeenCalled()
  })

  it('accepts the right token, acks hello, relays messages', async () => {
    const ws = connect(TOKEN)
    await openAndHello(ws)
    expect(events.onPhoneConnected).toHaveBeenCalledWith('vitest')

    ws.send(JSON.stringify({ v: 1, type: 'offer', sdp: 'v=0' }))
    await vi.waitFor(() =>
      expect(events.onPhoneMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'offer' }))
    )

    signaling.sendToPhone({ v: 1, type: 'answer', sdp: 'v=0-answer' })
    const answered = await new Promise<boolean>((resolve) => {
      ws.on('message', (d) => {
        if (JSON.parse(d.toString()).type === 'answer') resolve(true)
      })
    })
    expect(answered).toBe(true)
    ws.close()
  })

  it('kicks the previous phone when a new one connects', async () => {
    const first = connect(TOKEN)
    await openAndHello(first)

    const firstClose = once<[number]>(first, 'close')
    const second = connect(TOKEN)
    await openAndHello(second)

    const [code] = await firstClose
    expect(code).toBe(CLOSE_REPLACED)
    // the kicked socket closing must not mark the fresh session disconnected
    expect(events.onPhoneDisconnected).not.toHaveBeenCalledWith('closed')

    // relay still works for the replacement
    second.send(JSON.stringify({ v: 1, type: 'mic-state', muted: true }))
    await vi.waitFor(() =>
      expect(events.onPhoneMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'mic-state' })
      )
    )
    second.close()
  })

  it('ignores malformed frames without dropping the connection', async () => {
    const ws = connect(TOKEN)
    await openAndHello(ws)
    ws.send('garbage{{{')
    ws.send(JSON.stringify({ v: 1, type: 'bye' }))
    await vi.waitFor(() =>
      expect(events.onPhoneMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'bye' }))
    )
    ws.close()
  })

  it('rotating the token invalidates old QR codes', async () => {
    signaling.setToken('rotated-token-xyz')
    const ws = connect(TOKEN)
    const [code] = await once<[number]>(ws, 'close')
    expect(code).toBe(CLOSE_BAD_TOKEN)

    const ws2 = connect('rotated-token-xyz')
    await openAndHello(ws2)
    ws2.close()
  })
})
