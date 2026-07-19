import { describe, expect, it } from 'vitest'
import { classifyInterface, rankCandidates } from '../../src/main/net/lanIp'

const iface = (address: string, internal = false, family = 'IPv4') => ({
  address,
  family,
  internal
})

describe('rankCandidates', () => {
  it('prefers physical RFC1918 over virtual adapters', () => {
    const ranked = rankCandidates({
      'vEthernet (WSL)': [iface('172.20.0.1')],
      'Wi-Fi': [iface('192.168.1.23')],
      'VirtualBox Host-Only Network': [iface('192.168.56.1')]
    })
    expect(ranked[0]?.address).toBe('192.168.1.23')
    expect(ranked[0]?.kind).toBe('ethernet-or-wifi')
    expect(ranked.find((c) => c.interfaceName.includes('WSL'))?.kind).toBe('virtual')
  })

  it('ranks the Windows Mobile Hotspot adapter highest', () => {
    const ranked = rankCandidates({
      'Wi-Fi': [iface('192.168.1.23')],
      'Local Area Connection* 2': [iface('192.168.137.1')]
    })
    expect(ranked[0]?.address).toBe('192.168.137.1')
    expect(ranked[0]?.kind).toBe('windows-hotspot')
  })

  it('drops internal, IPv6 and link-local addresses', () => {
    const ranked = rankCandidates({
      lo: [iface('127.0.0.1', true)],
      'Wi-Fi': [iface('fe80::1', false, 'IPv6'), iface('169.254.10.10'), iface('10.0.0.5')]
    })
    expect(ranked.map((c) => c.address)).toEqual(['10.0.0.5'])
  })

  it('classifies non-private addresses as other and deprioritizes them', () => {
    const ranked = rankCandidates({
      eth0: [iface('100.100.1.5')],
      eth1: [iface('192.168.0.9')]
    })
    expect(ranked[0]?.address).toBe('192.168.0.9')
    expect(classifyInterface('eth0', '100.100.1.5')).toBe('other')
  })

  it('treats 172.16-31 as private but not 172.32+', () => {
    expect(classifyInterface('eth0', '172.16.0.1')).toBe('ethernet-or-wifi')
    expect(classifyInterface('eth0', '172.32.0.1')).toBe('other')
  })

  it('detects USB tether links by subnet and by adapter name', () => {
    // Android RNDIS default subnet
    expect(classifyInterface('Ethernet 3', '192.168.42.100')).toBe('usb-tether')
    // iPhone Personal Hotspot over USB
    expect(classifyInterface('Ethernet 4', '172.20.10.2')).toBe('usb-tether')
    // adapter-name hint even on a nonstandard subnet
    expect(classifyInterface('Remote NDIS based Internet Sharing Device', '10.42.0.5')).toBe(
      'usb-tether'
    )
  })

  it('ranks a USB tether above everything else', () => {
    const ranked = rankCandidates({
      'Wi-Fi': [iface('192.168.1.23')],
      'Local Area Connection* 2': [iface('192.168.137.1')],
      'Ethernet 3': [iface('192.168.42.100')]
    })
    expect(ranked[0]?.address).toBe('192.168.42.100')
    expect(ranked[0]?.kind).toBe('usb-tether')
    expect(ranked[1]?.kind).toBe('windows-hotspot')
  })
})
