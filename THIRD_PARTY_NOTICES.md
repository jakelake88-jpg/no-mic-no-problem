# Third-party notices

## Design inspiration (no code copied)

- **[russelltg/web-mic](https://github.com/russelltg/web-mic)** (Apache-2.0) — pioneered the
  "phone browser mic over self-signed local HTTPS" approach this app follows.
- **[teamclouday/AndroidMic](https://github.com/teamclouday/AndroidMic)** (MIT) — established the
  Windows phone-as-mic UX and the VB-CABLE virtual-device routing pattern.

## Runtime dependencies (bundled)

| Package                       | License                              | Purpose                            |
| ----------------------------- | ------------------------------------ | ---------------------------------- |
| Electron / Chromium / Node.js | MIT / BSD-style                      | app shell, WebRTC stack            |
| ws                            | MIT                                  | WebSocket signaling server         |
| selfsigned (node-forge)       | MIT / (BSD-3-Clause or GPL-2.0 dual) | local TLS certificate generation   |
| qrcode                        | MIT                                  | pairing QR codes                   |
| extract-zip                   | BSD-2-Clause                         | unpacking the VB-CABLE driver pack |
| electron-log                  | MIT                                  | structured rotating logs           |

## Not bundled, downloaded on demand by the user

- **VB-CABLE Virtual Audio Device** — © VB-Audio Software, donationware.
  Downloaded directly from <https://vb-audio.com/Cable/> with the user's consent; never
  redistributed with this application. Please consider donating to VB-Audio.
