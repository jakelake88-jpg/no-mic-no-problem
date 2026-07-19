# No Mic? No Problem.

Use your phone as a **wireless gaming microphone** for your Windows PC.

- **Nothing to install on the phone** — scan a QR code, the mic runs in your phone's browser.
- **No cables, no cloud** — audio travels only across your own Wi-Fi network via WebRTC (Opus, ~50–150 ms).
- **Games see a real microphone** — routed through the free VB-CABLE virtual audio device.
- **One-click hotspot mode** — no shared Wi-Fi? The app can host a Windows Mobile Hotspot and show a Wi-Fi join QR.
- **USB cable mode** — plug the phone in and use the OS's built-in tethering; the most reliable, lowest-latency link. Still nothing to install on the phone.
- **Bluetooth mode (experimental)** — the PC acts as a Bluetooth speaker (A2DP sink) and the phone streams the mic to it. Works with zero network at all, but Bluetooth adds ~0.1–0.25 s delay.

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

## USB cable mode (most reliable)

Wi-Fi flaky, firewalled, or isolated? Plug the phone into the PC and use the phone OS's built-in tethering — no app needed on the phone:

- **Android**: connect the USB cable → Settings → Network & internet → **Hotspot & tethering** → turn on **USB tethering**. Works even without mobile data on most phones.
- **iPhone**: connect the cable → Settings → **Personal Hotspot** → Allow Others to Join. Windows needs the Apple USB driver (installed with iTunes or "Apple Devices" from the Microsoft Store).

The app detects the tether link automatically, prefers it in the **Network** dropdown ("via USB cable"), and regenerates the QR. Scan and stream as usual — the audio now travels over the cable with the lowest possible latency, immune to router/firewall quirks.

## Bluetooth mode (experimental)

For when there's no usable network and a cable across the living room isn't happening. The PC becomes an A2DP sink (Windows 10 2004+ built-in, via the `AudioPlaybackConnection` API) and the phone streams its mic over Bluetooth like music:

1. Pair the phone with the PC (Windows Settings → Bluetooth).
2. In the app, open **Bluetooth mode (experimental)** → pick the phone → **Connect**.
3. One-time routing: the card's _Sound settings_ link opens App volume preferences — set **Windows PowerShell** (the connection helper) output to **CABLE Input**. Windows remembers this.
4. On the phone, open the mic web page as usual (scan the QR — the network is only needed to _load_ the page; the audio then travels over Bluetooth), tap **Bluetooth mode** under the mic, then the mic button.

> Note: no phone Bluetooth setting can send the raw mic on its own — the greyed-out "calls" (HFP) toggle is expected, and "media audio" (A2DP) only carries what an app/page plays. That's why the mic page stays part of the flow: it captures your mic and plays it into the media stream.

Know the trade-offs (they're physics, not bugs): Bluetooth A2DP buffers ~100–250 ms end-to-end — fine for casual chat, noticeable for competitive play; and **everything the phone plays goes into the mic** (enable Do Not Disturb). The app already squeezes what it can: raw capture with no processing delay, an `interactive`-latency audio path, and phones pick the best codec the PC supports (AAC on Windows 11). Prefer Wi-Fi (~80 ms) or USB (best) when available.

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

## Publishing to the Microsoft Store

The Store re-signs packages after certification, so **no code-signing certificate is needed**:

1. Create a free developer account at [Partner Center](https://partner.microsoft.com/dashboard) and reserve the app name.
2. In Partner Center → your app → Product management → **Product identity**, copy the three values into the `appx:` section of `electron-builder.yml` (`identityName`, `publisher`, `publisherDisplayName`).
3. `npm run dist:msix` (on Windows) → upload `dist/*.appx` in your Store submission. CI also builds this package as the `NoMicNoProblem-MSIX` artifact.
4. Submission needs: pricing/markets, the IARC age-rating questionnaire, screenshots, and a privacy policy URL — point it at [PRIVACY.md](PRIVACY.md).

Store builds automatically disable the VB-CABLE auto-download (Store policy) — the wizard links users to vb-audio.com instead. Everything else is identical.

## Credits & prior art

Built on the shoulders of open source: the browser-mic-over-self-signed-HTTPS approach follows [russelltg/web-mic](https://github.com/russelltg/web-mic) (Linux/PulseAudio), and the Windows phone-mic UX + VB-CABLE routing pattern follows [teamclouday/AndroidMic](https://github.com/teamclouday/AndroidMic). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

MIT licensed. VB-CABLE is © VB-Audio Software (donationware) and is downloaded from vb-audio.com, never redistributed.
