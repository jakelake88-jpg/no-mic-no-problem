# Privacy Policy — No Mic? No Problem

_Last updated: 2026-07-16_

**Short version: everything stays on your devices. We collect nothing.**

- **Audio** captured by your phone is streamed directly to your own PC over your local
  network (Wi-Fi, USB tether, hotspot, or Bluetooth). It is never sent to us or to any
  third-party server, never stored, and never analyzed.
- **No accounts, no telemetry, no analytics, no ads.** The app has no backend. It makes
  no network requests outside your local network, with one exception: if you use the
  optional VB-CABLE setup helper, the app (non-Store builds) downloads the driver
  package directly from the vendor, VB-Audio Software (vb-audio.com). Their privacy
  policy governs that download.
- **Diagnostics** (logs, connection stats) are written only to your own disk
  (`%APPDATA%/no-mic-no-problem/logs/`) and are shared only if you copy them yourself.
- **Pairing security**: connections between phone and PC are encrypted (TLS/DTLS) with
  a certificate generated on your PC, and gated by a random per-launch pairing code.

Questions: open an issue at https://github.com/jakelake88-jpg/no-mic-no-problem/issues
