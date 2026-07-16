# No Mic? No Problem.

Use your phone as a **wireless gaming microphone** for your Windows PC.

- **Nothing to install on the phone** — scan a QR code, the mic runs in your phone's browser.
- **No cables, no cloud** — audio travels only across your own Wi-Fi network via WebRTC (Opus, ~50–150 ms).
- **Games see a real microphone** — routed through the free VB-CABLE virtual audio device.
- **One-click hotspot mode** — no shared Wi-Fi? The app can host a Windows Mobile Hotspot and show a Wi-Fi join QR.

```
Phone browser ──getUserMedia──▶ WebRTC (Opus over your LAN)
        │  scans QR: https://<your-pc>:43110/?token=…
        ▼
Desktop app (Electron)
  • local HTTPS + WebSocket signaling (self-signed cert, token-gated)
  • receives the audio, plays it into "CABLE Input"
        ▼
VB-CABLE virtual device ──▶ your game selects "CABLE Output" as its mic
```

## Install

1. Grab `NoMicNoProblem-Setup-<version>.exe` from Releases (or the CI artifact) and run it.
   _The installer is currently unsigned — Windows SmartScreen will warn; click **More info → Run anyway**._
2. Launch the app. When Windows asks to allow it on **Private networks**, click **Allow** (that's the local server your phone connects to).
3. If the yellow banner appears, click **Set up VB-CABLE** — a guided, one-click download of the free virtual mic driver from [VB-Audio](https://vb-audio.com/Cable/) (donationware, closed-source, so we can't bundle it). One UAC prompt, done.

## Use

1. Make sure phone and PC are on the same Wi-Fi (or click **Host a hotspot instead**).
2. Scan the QR code with your phone camera and open the link.
3. Your phone warns the connection is _not private_ — that's expected: it's encrypted with your **PC's own local certificate** and never leaves your network. Tap **Advanced → Proceed**.
4. Tap the big mic button, allow microphone access.
5. In your game / Discord / OBS, pick **CABLE Output (VB-Audio Virtual Cable)** as the microphone. Done — you're live.

Keep the phone page open; locking the screen stops the mic (a platform limit — the app keeps the screen awake while streaming).

## Latency

Defaults target ~80 ms mouth-to-game. The **Latency** selector trades stability for speed (20/40/80 ms jitter buffer); live RTT/jitter/loss stats are shown while streaming.

## Troubleshooting

| Symptom                                | Fix                                                                                                                                                  |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phone can't load the page              | Same network? Click **Fix firewall** in Settings if you clicked _Deny_ earlier. Pick a different IP in the **Network** dropdown (multi-adapter PCs). |
| "Pairing code expired"                 | Click **New code** on the desktop and re-scan.                                                                                                       |
| Connects but no audio in game          | Output must be **CABLE Input** (auto-selected when present); game mic must be **CABLE Output**.                                                      |
| Connection failed on guest/hotel Wi-Fi | Client isolation blocks device-to-device traffic — use **Host a hotspot instead**.                                                                   |
| Certificate warning every time         | The cert regenerates when your PC's IP changes (DHCP); accepting again is normal.                                                                    |

Detailed diagnostics: open the **Diagnostics** panel and hit **Copy diagnostics** for a redacted report; logs live in `%APPDATA%/no-mic-no-problem/logs/`.

## Development

```bash
npm ci
npm run dev        # electron-vite dev (builds phone page first)
npm test           # unit + browser integration tests
npm run test:e2e   # full loop: Electron app + fake-phone Chromium (xvfb on headless)
npm run dist:win   # NSIS installer -> dist/
```

TypeScript everywhere, strict; `npm run lint` + `npm run typecheck` gate CI. See [docs/MANUAL_TESTING.md](docs/MANUAL_TESTING.md) for the real-hardware checklist (phone browsers, VB-CABLE routing, UAC/firewall flows).

## Credits & prior art

Built on the shoulders of open source: the browser-mic-over-self-signed-HTTPS approach follows [russelltg/web-mic](https://github.com/russelltg/web-mic) (Linux/PulseAudio), and the Windows phone-mic UX + VB-CABLE routing pattern follows [teamclouday/AndroidMic](https://github.com/teamclouday/AndroidMic). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

MIT licensed. VB-CABLE is © VB-Audio Software (donationware) and is downloaded from vb-audio.com, never redistributed.
