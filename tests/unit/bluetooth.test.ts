import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import {
  BluetoothAudio,
  parseConnectLine,
  parseDeviceList,
  type BtStateEvent
} from '../../src/main/net/bluetooth'

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed = false
  kill(): boolean {
    this.killed = true
    return true
  }
}

describe('parseDeviceList', () => {
  it('parses a JSON array of devices', () => {
    expect(
      parseDeviceList('[{"id":"BT#1","name":"Pixel 8"},{"id":"BT#2","name":"iPhone"}]')
    ).toEqual([
      { id: 'BT#1', name: 'Pixel 8' },
      { id: 'BT#2', name: 'iPhone' }
    ])
  })

  it('wraps the single-object form PowerShell 5.1 emits for one device', () => {
    expect(parseDeviceList('{"id":"BT#1","name":"Pixel 8"}')).toEqual([
      { id: 'BT#1', name: 'Pixel 8' }
    ])
  })

  it('handles empty output and empty arrays', () => {
    expect(parseDeviceList('')).toEqual([])
    expect(parseDeviceList('[]')).toEqual([])
  })
})

describe('parseConnectLine', () => {
  it('maps helper output lines to states', () => {
    expect(parseConnectLine('BT_CONNECTED')).toEqual({ state: 'connected' })
    expect(parseConnectLine('BT_CLOSED')).toEqual({ state: 'disconnected', detail: 'closed' })
    expect(parseConnectLine('BT_ERROR open-failed DeniedBySystem')).toEqual({
      state: 'error',
      detail: 'open-failed DeniedBySystem'
    })
    expect(parseConnectLine('random noise')).toBeNull()
  })
})

describe('BluetoothAudio', () => {
  it('is unsupported off Windows and lists nothing', async () => {
    const listRunner = vi.fn()
    const bt = new BluetoothAudio(listRunner, undefined as never, 'linux')
    expect(bt.supported).toBe(false)
    expect(await bt.listDevices()).toEqual([])
    expect(listRunner).not.toHaveBeenCalled()
  })

  it('lists devices via PowerShell on Windows', async () => {
    const listRunner = vi.fn().mockResolvedValue('[{"id":"BT#1","name":"Pixel 8"}]')
    const bt = new BluetoothAudio(listRunner, undefined as never, 'win32')
    expect(await bt.listDevices()).toEqual([{ id: 'BT#1', name: 'Pixel 8' }])
  })

  it('connect emits connecting, then states from helper stdout; disconnect kills silently', () => {
    const child = new FakeChild()
    const spawnFn = vi.fn().mockReturnValue(child as unknown as ChildProcess)
    const bt = new BluetoothAudio(vi.fn(), spawnFn, 'win32')
    const events: BtStateEvent[] = []

    bt.connect("BT#dev'1", (e) => events.push(e))
    expect(events).toEqual([{ state: 'connecting' }])
    // device id single quotes must be PowerShell-escaped in the script
    expect(spawnFn.mock.calls[0]?.[0]).toContain("BT#dev''1")

    child.stdout.emit('data', Buffer.from('BT_CONNECTED\n'))
    expect(events[1]).toEqual({ state: 'connected' })

    bt.disconnect()
    expect(child.killed).toBe(true)
    child.emit('exit', null)
    // no extra event after an intentional disconnect
    expect(events).toHaveLength(2)
  })

  it('reports an error when the helper dies unexpectedly', () => {
    const child = new FakeChild()
    const bt = new BluetoothAudio(
      vi.fn(),
      vi.fn().mockReturnValue(child as unknown as ChildProcess),
      'win32'
    )
    const events: BtStateEvent[] = []
    bt.connect('BT#1', (e) => events.push(e))
    child.emit('exit', 1)
    expect(events[1]).toEqual({ state: 'error', detail: 'helper exited (1)' })
  })

  it('handles chunked stdout lines', () => {
    const child = new FakeChild()
    const bt = new BluetoothAudio(
      vi.fn(),
      vi.fn().mockReturnValue(child as unknown as ChildProcess),
      'win32'
    )
    const events: BtStateEvent[] = []
    bt.connect('BT#1', (e) => events.push(e))
    child.stdout.emit('data', Buffer.from('BT_CON'))
    child.stdout.emit('data', Buffer.from('NECTED\nBT_CLOSED\n'))
    expect(events.slice(1)).toEqual([
      { state: 'connected' },
      { state: 'disconnected', detail: 'closed' }
    ])
  })
})
