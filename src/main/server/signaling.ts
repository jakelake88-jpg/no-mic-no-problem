import { WebSocketServer, WebSocket } from 'ws'
import type https from 'node:https'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import log from 'electron-log'
import {
  CLOSE_BAD_TOKEN,
  CLOSE_REPLACED,
  DesktopToPhone,
  PhoneToDesktop,
  parsePhoneMessage
} from '@shared/protocol'
import { tokenMatches } from './certs'

const sigLog = log.scope('signaling')

const HEARTBEAT_INTERVAL_MS = 5_000
const MAX_MISSED_PONGS = 2
const MAX_FRAME_BYTES = 256 * 1024 // an SDP is a few KB; anything huge is garbage

export interface SignalingEvents {
  /** A phone authenticated and said hello. */
  onPhoneConnected(ua: string): void
  /** The phone socket closed for any reason. */
  onPhoneDisconnected(reason: string): void
  /** A validated protocol message from the phone (offer/candidate/mic-state/log/bye). */
  onPhoneMessage(message: PhoneToDesktop): void
}

/**
 * Token-gated single-client WebSocket signaling endpoint mounted on the
 * app's HTTPS server at /ws. A new authenticated phone replaces the old one.
 */
export class SignalingServer {
  private wss: WebSocketServer
  private phone: WebSocket | null = null
  private missedPongs = 0
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private token: string
  private events: SignalingEvents
  private appVersion: string

  constructor(server: https.Server, token: string, appVersion: string, events: SignalingEvents) {
    this.token = token
    this.appVersion = appVersion
    this.events = events
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })

    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? '/', 'https://local')
      if (url.pathname !== '/ws') {
        socket.destroy()
        return
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, url))
    })
  }

  /** Rotate the pairing token (invalidates the QR currently displayed). */
  setToken(token: string): void {
    this.token = token
  }

  get phoneConnected(): boolean {
    return this.phone?.readyState === WebSocket.OPEN
  }

  sendToPhone(message: DesktopToPhone): void {
    if (this.phoneConnected) {
      this.phone!.send(JSON.stringify(message))
    } else {
      sigLog.warn(`dropping ${message.type}: no phone connected`)
    }
  }

  private accept(ws: WebSocket, url: URL): void {
    if (!tokenMatches(this.token, url.searchParams.get('token'))) {
      sigLog.warn('rejected connection: bad token')
      ws.send(
        JSON.stringify({
          v: 1,
          type: 'error',
          code: 'bad-token',
          message: 'Invalid pairing code. Re-scan the QR code on the desktop app.'
        })
      )
      ws.close(CLOSE_BAD_TOKEN, 'bad token')
      return
    }

    if (this.phone && this.phone.readyState === WebSocket.OPEN) {
      sigLog.info('new phone connected; kicking previous session')
      this.phone.send(JSON.stringify({ v: 1, type: 'kicked', reason: 'replaced' }))
      this.phone.close(CLOSE_REPLACED, 'replaced')
    }
    this.attach(ws)
  }

  private attach(ws: WebSocket): void {
    this.phone = ws
    this.missedPongs = 0

    ws.on('pong', () => {
      this.missedPongs = 0
    })

    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return
      if (this.missedPongs >= MAX_MISSED_PONGS) {
        sigLog.warn('phone missed heartbeats; terminating')
        ws.terminate()
        return
      }
      this.missedPongs++
      ws.ping()
    }, HEARTBEAT_INTERVAL_MS)

    ws.on('message', (data, isBinary) => {
      if (isBinary) return
      const parsed = parsePhoneMessage(data.toString())
      if (!parsed) {
        sigLog.warn('ignoring malformed frame')
        return
      }
      if (parsed.type === 'hello') {
        sigLog.info(`phone hello: ${parsed.ua}`)
        ws.send(JSON.stringify({ v: 1, type: 'hello-ack', appVersion: this.appVersion }))
        this.events.onPhoneConnected(parsed.ua)
        return
      }
      if (parsed.type === 'log') {
        log.scope('phone')[parsed.level](parsed.message)
        return
      }
      this.events.onPhoneMessage(parsed)
    })

    ws.on('close', (code, reason) => {
      if (this.phone === ws) {
        this.phone = null
        if (this.heartbeat) {
          clearInterval(this.heartbeat)
          this.heartbeat = null
        }
        // A kicked socket closing must not tear down its replacement's session.
        sigLog.info(`phone disconnected (${code} ${reason.toString() || 'no reason'})`)
        this.events.onPhoneDisconnected(code === CLOSE_REPLACED ? 'replaced' : 'closed')
      }
    })

    ws.on('error', (err) => sigLog.warn('phone socket error', err))
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.phone?.close(1001, 'server shutting down')
    this.wss.close()
  }
}
