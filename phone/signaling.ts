import {
  CLOSE_BAD_TOKEN,
  CLOSE_REPLACED,
  msg,
  parseDesktopMessage,
  type DesktopToPhone,
  type PhoneToDesktop
} from '@shared/protocol'

export type SignalingState = 'connecting' | 'open' | 'closed' | 'kicked' | 'bad-token'

export interface SignalingCallbacks {
  onState(state: SignalingState): void
  onMessage(message: DesktopToPhone): void
}

const BACKOFF_MIN_MS = 500
const BACKOFF_MAX_MS = 8_000

/**
 * WebSocket signaling client with indefinite exponential-backoff reconnect.
 * Reconnection stays on while `active` (mic toggle) is true and stops for
 * terminal conditions (kicked / bad token).
 */
export class SignalingClient {
  private ws: WebSocket | null = null
  private backoff = BACKOFF_MIN_MS
  private active = false
  private reconnectTimer: number | null = null

  constructor(
    private url: string,
    private cb: SignalingCallbacks
  ) {}

  start(): void {
    this.active = true
    this.backoff = BACKOFF_MIN_MS
    this.connect()
  }

  stop(): void {
    this.active = false
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.ws?.close(1000, 'user stopped')
    this.ws = null
  }

  send(message: PhoneToDesktop): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message))
    }
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  private connect(): void {
    this.cb.onState('connecting')
    const ws = new WebSocket(this.url)
    this.ws = ws

    ws.onopen = () => {
      this.backoff = BACKOFF_MIN_MS
      this.send(msg({ type: 'hello', ua: navigator.userAgent }))
      this.cb.onState('open')
    }

    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return
      const parsed = parseDesktopMessage(ev.data)
      if (parsed) this.cb.onMessage(parsed)
    }

    ws.onclose = (ev) => {
      this.ws = null
      if (ev.code === CLOSE_BAD_TOKEN) {
        this.active = false
        this.cb.onState('bad-token')
        return
      }
      if (ev.code === CLOSE_REPLACED) {
        this.active = false
        this.cb.onState('kicked')
        return
      }
      this.cb.onState('closed')
      if (this.active) {
        this.reconnectTimer = window.setTimeout(() => this.connect(), this.backoff)
        this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS)
      }
    }

    ws.onerror = () => {
      // onclose always follows; reconnect logic lives there
    }
  }
}
