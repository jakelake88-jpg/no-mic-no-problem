import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { HfpLink, parseHfpLine, type HfpEvent } from '../../src/main/net/hfp'

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed = false
  kill(): boolean {
    this.killed = true
    return true
  }
}

describe('parseHfpLine', () => {
  it('maps helper lines to states and traces', () => {
    expect(parseHfpLine('HFP_CONNECTED')).toEqual({ state: 'connected' })
    expect(parseHfpLine('HFP_CLOSED')).toEqual({ state: 'disconnected', detail: 'closed' })
    expect(parseHfpLine('HFP_ERROR find-service phone-offers-no-hfp')).toEqual({
      state: 'error',
      detail: 'find-service phone-offers-no-hfp'
    })
    expect(parseHfpLine('HFP_AT > AT+BRSF=0')).toEqual({ trace: 'HFP_AT > AT+BRSF=0' })
    expect(parseHfpLine('HFP_EVENT +CIEV: 1,1')).toEqual({ trace: 'HFP_EVENT +CIEV: 1,1' })
    expect(parseHfpLine('HFP_INFO stage=slc')).toEqual({ trace: 'HFP_INFO stage=slc' })
    expect(parseHfpLine('unrelated noise')).toBeNull()
  })
})

describe('HfpLink', () => {
  it('escapes single quotes in the device name for PowerShell', () => {
    const child = new FakeChild()
    const spawnFn = vi.fn().mockReturnValue(child as unknown as ChildProcess)
    const link = new HfpLink(spawnFn, 'win32')
    link.connect("Jake's Pixel", () => undefined)
    expect(spawnFn.mock.calls[0]?.[0]).toContain("Jake''s Pixel")
  })

  it('emits connecting, traces, connected; manual disconnect stays silent', () => {
    const child = new FakeChild()
    const link = new HfpLink(vi.fn().mockReturnValue(child as unknown as ChildProcess), 'win32')
    const events: HfpEvent[] = []
    link.connect('Pixel 8', (e) => events.push(e))
    expect(events[0]).toEqual({ state: 'connecting' })

    child.stdout.emit('data', Buffer.from('HFP_INFO stage=slc\nHFP_CONNECTED\n'))
    expect(events[1]).toEqual({ trace: 'HFP_INFO stage=slc' })
    expect(events[2]).toEqual({ state: 'connected' })

    link.disconnect()
    expect(child.killed).toBe(true)
    child.emit('exit', null)
    expect(events).toHaveLength(3)
  })

  it('reports unexpected helper death as an error', () => {
    const child = new FakeChild()
    const link = new HfpLink(vi.fn().mockReturnValue(child as unknown as ChildProcess), 'win32')
    const events: HfpEvent[] = []
    link.connect('Pixel 8', (e) => events.push(e))
    child.emit('exit', 1)
    expect(events[1]).toEqual({ state: 'error', detail: 'helper exited (1)' })
  })
})
