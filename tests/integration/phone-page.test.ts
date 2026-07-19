/**
 * Integration: real Chromium "fake phone" against the real HTTPS + signaling
 * server, exercising the built phone page (WS auth, getUserMedia, munged Opus
 * offer, trickle ICE). The Electron receiver side is covered by the full e2e
 * (tests/e2e/fake-phone.mjs); this test runs wherever a Chromium is available
 * and skips itself otherwise.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Browser } from 'playwright'
import { loadOrCreateCert } from '../../src/main/server/certs'
import { startHttpsServer, type RunningServer } from '../../src/main/server/httpsServer'
import { SignalingServer } from '../../src/main/server/signaling'
import type { PhoneToDesktop } from '../../src/shared/protocol'

const PHONE_DIST = path.resolve(__dirname, '../../out/phone')
const TOKEN = 'integration-token-123'

async function launchChromium(): Promise<Browser | null> {
  const args = [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--ignore-certificate-errors',
    '--no-sandbox'
  ]
  try {
    return await chromium.launch({ args })
  } catch {
    const fallback = '/opt/pw-browsers/chromium'
    if (fs.existsSync(fallback)) {
      return chromium.launch({ executablePath: fallback, args })
    }
    return null
  }
}

const phonePageBuilt = fs.existsSync(path.join(PHONE_DIST, 'index.html'))

describe.skipIf(!phonePageBuilt)('phone page against real server', () => {
  let dir: string
  let running: RunningServer
  let signaling: SignalingServer
  let browser: Browser | null
  const received: PhoneToDesktop[] = []
  let connectedUa = ''

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nmnp-int-'))
    const cert = loadOrCreateCert(dir, ['127.0.0.1'])
    running = await startHttpsServer({
      cert: cert.cert,
      key: cert.key,
      phoneDistDir: PHONE_DIST,
      preferredPort: 0
    })
    signaling = new SignalingServer(running.server, TOKEN, '0.0.0-int', {
      onPhoneConnected: (ua) => {
        connectedUa = ua
      },
      onPhoneDisconnected: () => undefined,
      onPhoneMessage: (m) => {
        received.push(m)
      }
    })
    browser = await launchChromium()
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    signaling?.close()
    await new Promise<void>((r) => running?.server.close(() => r()))
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('streams a munged Opus offer after one tap', async (ctx) => {
    if (!browser) return ctx.skip()
    const page = await browser.newPage()
    await page.goto(`https://127.0.0.1:${running.port}/?token=${TOKEN}`)
    await page.click('#mic-button')

    await expect
      .poll(() => received.some((m) => m.type === 'offer'), { timeout: 15_000 })
      .toBe(true)

    expect(connectedUa).not.toBe('')
    const offer = received.find((m) => m.type === 'offer')
    expect(offer && 'sdp' in offer ? offer.sdp : '').toMatch(/usedtx=1/)
    expect(offer && 'sdp' in offer ? offer.sdp : '').toMatch(/useinbandfec=1/)
    expect(offer && 'sdp' in offer ? offer.sdp : '').toMatch(/maxaveragebitrate=32000/)

    // trickle ICE host candidates should follow
    await expect
      .poll(() => received.some((m) => m.type === 'candidate'), { timeout: 10_000 })
      .toBe(true)

    // page reflects "connecting" until an answer arrives (no receiver here)
    expect(await page.getAttribute('body', 'data-state')).toMatch(/connecting|reconnecting/)
    await page.close()
  }, 40_000)

  it('shows bad-token state for a wrong token', async (ctx) => {
    if (!browser) return ctx.skip()
    const page = await browser.newPage()
    await page.goto(`https://127.0.0.1:${running.port}/?token=nope`)
    await page.click('#mic-button')
    await expect
      .poll(() => page.getAttribute('body', 'data-state'), { timeout: 10_000 })
      .toBe('bad-token')
    await page.close()
  }, 30_000)
})
