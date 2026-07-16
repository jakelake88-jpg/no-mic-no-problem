import { describe, expect, it } from 'vitest'
import {
  msg,
  parseDesktopMessage,
  parsePhoneMessage,
  PROTOCOL_VERSION
} from '../../src/shared/protocol'

describe('parsePhoneMessage', () => {
  it('parses a valid hello', () => {
    const m = parsePhoneMessage(JSON.stringify({ v: 1, type: 'hello', ua: 'TestUA' }))
    expect(m).toEqual({ v: 1, type: 'hello', ua: 'TestUA' })
  })

  it('parses offer / candidate / mic-state / bye / log', () => {
    expect(parsePhoneMessage(JSON.stringify({ v: 1, type: 'offer', sdp: 'v=0' }))).toMatchObject({
      type: 'offer'
    })
    expect(
      parsePhoneMessage(
        JSON.stringify({ v: 1, type: 'candidate', candidate: { candidate: 'candidate:1' } })
      )
    ).toMatchObject({ type: 'candidate' })
    expect(
      parsePhoneMessage(JSON.stringify({ v: 1, type: 'mic-state', muted: true }))
    ).toMatchObject({ muted: true })
    expect(parsePhoneMessage(JSON.stringify({ v: 1, type: 'bye' }))).toMatchObject({ type: 'bye' })
    expect(
      parsePhoneMessage(JSON.stringify({ v: 1, type: 'log', level: 'warn', message: 'hi' }))
    ).toMatchObject({ type: 'log', level: 'warn' })
  })

  it('rejects malformed frames', () => {
    expect(parsePhoneMessage('not json')).toBeNull()
    expect(parsePhoneMessage(JSON.stringify({ type: 'hello', ua: 'x' }))).toBeNull() // no version
    expect(parsePhoneMessage(JSON.stringify({ v: 2, type: 'hello', ua: 'x' }))).toBeNull()
    expect(parsePhoneMessage(JSON.stringify({ v: 1, type: 'offer' }))).toBeNull() // missing sdp
    expect(parsePhoneMessage(JSON.stringify({ v: 1, type: 'hello', ua: 42 }))).toBeNull()
    expect(
      parsePhoneMessage(JSON.stringify({ v: 1, type: 'log', level: 'debug', message: 'x' }))
    ).toBeNull()
  })

  it('ignores unknown types (forward compatibility)', () => {
    expect(parsePhoneMessage(JSON.stringify({ v: 1, type: 'future-thing' }))).toBeNull()
  })
})

describe('parseDesktopMessage', () => {
  it('parses answer / hello-ack / kicked / error', () => {
    expect(parseDesktopMessage(JSON.stringify({ v: 1, type: 'answer', sdp: 'v=0' }))).toMatchObject(
      { type: 'answer' }
    )
    expect(
      parseDesktopMessage(JSON.stringify({ v: 1, type: 'hello-ack', appVersion: '1.0' }))
    ).toMatchObject({ type: 'hello-ack' })
    expect(
      parseDesktopMessage(JSON.stringify({ v: 1, type: 'kicked', reason: 'replaced' }))
    ).toMatchObject({ type: 'kicked' })
    expect(
      parseDesktopMessage(JSON.stringify({ v: 1, type: 'error', code: 'bad-token', message: 'x' }))
    ).toMatchObject({ code: 'bad-token' })
  })
})

describe('msg helper', () => {
  it('stamps the protocol version', () => {
    expect(msg({ type: 'bye' })).toEqual({ v: PROTOCOL_VERSION, type: 'bye' })
  })
})
