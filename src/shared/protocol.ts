/**
 * Signaling protocol shared by the phone page, the Electron main process
 * (WebSocket relay) and the desktop renderer (WebRTC answerer).
 *
 * Envelope: every frame is JSON `{ v: 1, type: string, ...payload }`.
 * Unknown message types MUST be ignored by receivers (forward compatibility).
 */

export const PROTOCOL_VERSION = 1 as const

/**
 * Structural copy of the DOM's IceCandidateInit so this module also compiles
 * in the Node (main-process) tsconfig, which has no DOM lib.
 */
export interface IceCandidateInit {
  candidate?: string
  sdpMid?: string | null
  sdpMLineIndex?: number | null
  usernameFragment?: string | null
}

// ---------- Phone -> Desktop ----------

export interface HelloMsg {
  v: typeof PROTOCOL_VERSION
  type: 'hello'
  /** navigator.userAgent, for diagnostics only */
  ua: string
}

export interface OfferMsg {
  v: typeof PROTOCOL_VERSION
  type: 'offer'
  sdp: string
}

export interface CandidateMsg {
  v: typeof PROTOCOL_VERSION
  type: 'candidate'
  candidate: IceCandidateInit
}

export interface MicStateMsg {
  v: typeof PROTOCOL_VERSION
  type: 'mic-state'
  muted: boolean
}

export interface ByeMsg {
  v: typeof PROTOCOL_VERSION
  type: 'bye'
}

/** Phone-side log line forwarded to the desktop so failures on the phone are debuggable. */
export interface LogMsg {
  v: typeof PROTOCOL_VERSION
  type: 'log'
  level: 'info' | 'warn' | 'error'
  message: string
}

export type PhoneToDesktop = HelloMsg | OfferMsg | CandidateMsg | MicStateMsg | ByeMsg | LogMsg

// ---------- Desktop -> Phone ----------

export interface HelloAckMsg {
  v: typeof PROTOCOL_VERSION
  type: 'hello-ack'
  appVersion: string
}

export interface AnswerMsg {
  v: typeof PROTOCOL_VERSION
  type: 'answer'
  sdp: string
}

export interface KickedMsg {
  v: typeof PROTOCOL_VERSION
  type: 'kicked'
  reason: 'replaced'
}

export interface ErrorMsg {
  v: typeof PROTOCOL_VERSION
  type: 'error'
  code: string
  message: string
}

export type DesktopToPhone = HelloAckMsg | AnswerMsg | CandidateMsg | KickedMsg | ErrorMsg

export type SignalMessage = PhoneToDesktop | DesktopToPhone

// WebSocket close codes (4000-4999 are application-defined)
export const CLOSE_REPLACED = 4001
export const CLOSE_BAD_TOKEN = 4003

// ---------- Runtime guards ----------

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null
}

function hasEnvelope(x: Record<string, unknown>): boolean {
  return x.v === PROTOCOL_VERSION && typeof x.type === 'string'
}

function isCandidateInit(x: unknown): x is IceCandidateInit {
  if (!isRecord(x)) return false
  return x.candidate === undefined || typeof x.candidate === 'string'
}

/**
 * Parse a raw wire frame into a phone->desktop message.
 * Returns null for malformed frames; returns undefined-type-safe messages only.
 */
export function parsePhoneMessage(raw: string): PhoneToDesktop | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(data) || !hasEnvelope(data)) return null
  switch (data.type) {
    case 'hello':
      return typeof data.ua === 'string' ? (data as unknown as HelloMsg) : null
    case 'offer':
      return typeof data.sdp === 'string' ? (data as unknown as OfferMsg) : null
    case 'candidate':
      return isCandidateInit(data.candidate) ? (data as unknown as CandidateMsg) : null
    case 'mic-state':
      return typeof data.muted === 'boolean' ? (data as unknown as MicStateMsg) : null
    case 'bye':
      return data as unknown as ByeMsg
    case 'log':
      return typeof data.message === 'string' &&
        (data.level === 'info' || data.level === 'warn' || data.level === 'error')
        ? (data as unknown as LogMsg)
        : null
    default:
      return null // unknown types ignored by caller
  }
}

/** Parse a raw wire frame into a desktop->phone message (used by the phone page). */
export function parseDesktopMessage(raw: string): DesktopToPhone | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(data) || !hasEnvelope(data)) return null
  switch (data.type) {
    case 'hello-ack':
      return typeof data.appVersion === 'string' ? (data as unknown as HelloAckMsg) : null
    case 'answer':
      return typeof data.sdp === 'string' ? (data as unknown as AnswerMsg) : null
    case 'candidate':
      return isCandidateInit(data.candidate) ? (data as unknown as CandidateMsg) : null
    case 'kicked':
      return data as unknown as KickedMsg
    case 'error':
      return typeof data.code === 'string' && typeof data.message === 'string'
        ? (data as unknown as ErrorMsg)
        : null
    default:
      return null
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** Stamp the protocol version onto a message body, preserving its narrow type. */
export function msg<M extends DistributiveOmit<SignalMessage, 'v'>>(
  m: M
): Extract<SignalMessage, { type: M['type'] }> {
  return { v: PROTOCOL_VERSION, ...m } as unknown as Extract<SignalMessage, { type: M['type'] }>
}
