import os from 'node:os'
import type { LanCandidate } from '@shared/types'

export type { LanCandidate }

const VIRTUAL_NAME_HINTS = [
  'vethernet',
  'virtualbox',
  'vmware',
  'vmnet',
  'hyper-v',
  'wsl',
  'tailscale',
  'zerotier',
  'docker',
  'veth',
  'loopback'
]

function isRfc1918(ip: string): boolean {
  if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true
  if (ip.startsWith('172.')) {
    const second = Number(ip.split('.')[1])
    return second >= 16 && second <= 31
  }
  return false
}

/**
 * USB-tether links (built into the phone OS — no phone app needed):
 * Android RNDIS/NCM tethering hands the PC an address on 192.168.42.0/24
 * (some ROMs use .43/.44); iPhone Personal Hotspot over USB uses 172.20.10.0/28.
 */
function isUsbTetherSubnet(address: string): boolean {
  return (
    address.startsWith('192.168.42.') ||
    address.startsWith('192.168.43.') ||
    address.startsWith('192.168.44.') ||
    address.startsWith('172.20.10.')
  )
}

const USB_TETHER_NAME_HINTS = ['rndis', 'remote ndis', 'apple mobile device']

export function classifyInterface(name: string, address: string): LanCandidate['kind'] {
  const lower = name.toLowerCase()
  // Windows Mobile Hotspot hosts its clients on 192.168.137.0/24 by default.
  if (address.startsWith('192.168.137.')) return 'windows-hotspot'
  if (isUsbTetherSubnet(address) || USB_TETHER_NAME_HINTS.some((h) => lower.includes(h))) {
    return 'usb-tether'
  }
  if (VIRTUAL_NAME_HINTS.some((h) => lower.includes(h))) return 'virtual'
  return isRfc1918(address) ? 'ethernet-or-wifi' : 'other'
}

export function scoreCandidate(kind: LanCandidate['kind'], address: string): number {
  let score = 0
  switch (kind) {
    case 'usb-tether':
      score = 95 // a cable plugged in for this purpose beats everything
      break
    case 'windows-hotspot':
      score = 90 // if the user turned the hotspot on, it is almost certainly the intended path
      break
    case 'ethernet-or-wifi':
      score = 80
      break
    case 'other':
      score = 40
      break
    case 'virtual':
      score = 10
      break
  }
  if (!isRfc1918(address)) score -= 20
  return score
}

export type InterfaceMap = Record<string, { address: string; family: string; internal: boolean }[]>

/**
 * Enumerate candidate IPv4 addresses the phone could reach, ranked best-first.
 * Pure logic is factored out so tests can inject a fake interface map.
 */
export function rankCandidates(interfaces: InterfaceMap): LanCandidate[] {
  const out: LanCandidate[] = []
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs ?? []) {
      if (addr.internal) continue
      if (addr.family !== 'IPv4') continue
      if (addr.address.startsWith('169.254.')) continue // link-local: unreachable by phones
      const kind = classifyInterface(name, addr.address)
      out.push({
        address: addr.address,
        interfaceName: name,
        kind,
        score: scoreCandidate(kind, addr.address)
      })
    }
  }
  return out.sort((a, b) => b.score - a.score || a.address.localeCompare(b.address))
}

export function getLanCandidates(): LanCandidate[] {
  const raw = os.networkInterfaces()
  const map: InterfaceMap = {}
  for (const [name, addrs] of Object.entries(raw)) {
    if (!addrs) continue
    map[name] = addrs.map((a) => ({
      address: a.address,
      family: String(a.family),
      internal: a.internal
    }))
  }
  return rankCandidates(map)
}
