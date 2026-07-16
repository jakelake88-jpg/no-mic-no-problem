// End-to-end test: real Electron app + a Chromium "fake phone" streaming a
// generated tone over WebRTC. Verifies the full loop the way a user would use
// it, minus real hardware (VB-CABLE / phone browsers are covered by
// docs/MANUAL_TESTING.md).
//
// Run via tests/e2e/run-e2e.sh (needs xvfb on headless Linux).
import { _electron, chromium } from 'playwright'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'

const ROOT = new URL('../..', import.meta.url).pathname

function phoneBrowserArgs() {
  return [
    '--use-fake-device-for-media-stream', // synthesizes a loud tone as the mic
    '--use-fake-ui-for-media-stream', // auto-accept the mic permission prompt
    '--ignore-certificate-errors', // our self-signed cert
    '--autoplay-policy=no-user-gesture-required',
    '--no-sandbox'
  ]
}

async function waitFor(fn, what, timeoutMs = 15_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await fn()
    if (last) return last
    await sleep(intervalMs)
  }
  throw new Error(`timed out waiting for ${what} (last=${JSON.stringify(last)})`)
}

async function main() {
  console.log('[e2e] launching Electron app')
  const app = await _electron.launch({
    args: ['.', '--e2e', '--no-sandbox'],
    cwd: ROOT
  })

  // The app prints `E2E_READY {"port":...,"token":"..."}` once the HTTPS
  // server is bound; capture it from the main process stdout.
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no E2E_READY within 20s')), 20_000)
    app.process().stdout.on('data', (chunk) => {
      const m = String(chunk).match(/E2E_READY (\{.*\})/)
      if (m) {
        clearTimeout(timer)
        resolve(JSON.parse(m[1]))
      }
    })
  })
  console.log(`[e2e] app ready on port ${ready.port}`)

  const desktop = await app.firstWindow()
  await desktop.waitForFunction(() => window.__e2e !== undefined)

  const browser = await chromium.launch({ args: phoneBrowserArgs() })
  const phoneUrl = (token) => `https://127.0.0.1:${ready.port}/?token=${token}`

  // ---- negative: wrong token is rejected before any signaling ----
  console.log('[e2e] wrong token is rejected')
  const badPage = await browser.newPage()
  await badPage.goto(phoneUrl('wrong-token'))
  await badPage.click('#mic-button')
  await waitFor(
    async () => (await badPage.getAttribute('body', 'data-state')) === 'bad-token',
    'bad-token state on phone'
  )
  await badPage.close()

  // ---- happy path: stream a tone end to end ----
  console.log('[e2e] happy path: tone flows phone -> desktop')
  const phone = await browser.newPage()
  phone.on('console', (m) => console.log(`[phone] ${m.text()}`))
  await phone.goto(phoneUrl(ready.token))
  await phone.click('#mic-button')

  await waitFor(
    async () => (await phone.getAttribute('body', 'data-state')) === 'streaming',
    'phone streaming state',
    20_000
  )
  await waitFor(
    async () => (await desktop.evaluate(() => window.__e2e.phase())) === 'streaming',
    'desktop streaming phase'
  )

  const stats = await waitFor(
    async () => {
      const s = await desktop.evaluate(() => window.__e2e.stats())
      return s && s.packetsReceived > 50 && s.audioLevel > 0.01 ? s : null
    },
    'inbound audio packets with energy',
    20_000,
    500
  )
  console.log(`[e2e] stats: ${JSON.stringify(stats)}`)
  assert.match(stats.codec, /opus/i, 'negotiated codec should be Opus')

  const sdp = await desktop.evaluate(() => window.__e2e.remoteSdp())
  assert.match(sdp, /usedtx=1/, 'offer should carry DTX')
  assert.match(sdp, /useinbandfec=1/, 'offer should carry FEC')
  assert.match(sdp, /maxaveragebitrate=32000/, 'offer should cap bitrate')

  // ---- second phone kicks the first ----
  console.log('[e2e] second phone replaces the first')
  const phone2 = await browser.newPage()
  await phone2.goto(phoneUrl(ready.token))
  await phone2.click('#mic-button')
  await waitFor(
    async () => (await phone.getAttribute('body', 'data-state')) === 'kicked',
    'first phone kicked'
  )
  await waitFor(
    async () => (await phone2.getAttribute('body', 'data-state')) === 'streaming',
    'second phone streaming',
    20_000
  )

  // ---- abrupt phone death returns the desktop to waiting ----
  console.log('[e2e] abrupt disconnect -> desktop back to waiting')
  await phone2.close()
  await phone.close()
  await waitFor(
    async () => (await desktop.evaluate(() => window.__e2e.phase())) === 'waiting',
    'desktop waiting after disconnect',
    30_000 // heartbeat timeout is 2 missed pongs at 5s + slack
  )

  // ---- reconnect: a fresh page streams again ----
  console.log('[e2e] fresh page reconnects and streams')
  const phone3 = await browser.newPage()
  await phone3.goto(phoneUrl(ready.token))
  await phone3.click('#mic-button')
  await waitFor(
    async () => (await desktop.evaluate(() => window.__e2e.phase())) === 'streaming',
    'desktop streaming after reconnect',
    20_000
  )

  await browser.close()
  await app.close()
  console.log('[e2e] PASS')
}

main().catch((err) => {
  console.error('[e2e] FAIL:', err)
  process.exit(1)
})
