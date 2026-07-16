# Manual testing checklist (real hardware)

CI proves the WebRTC loop with a fake phone on Linux. These items need a real
Windows PC and real phones, and must pass before a release is tagged.

## Setup

- [ ] Fresh Windows 10 and Windows 11 x64 VMs/machines, no VB-CABLE preinstalled
- [ ] Android phone (Chrome) and iPhone (Safari 16.4+) on the same Wi-Fi

## Installer

- [ ] `NoMicNoProblem-Setup-*.exe` installs per-user without UAC
- [ ] SmartScreen "More info → Run anyway" copy in README matches reality
- [ ] Desktop + Start Menu shortcuts created; uninstall works cleanly
- [ ] First launch: Windows Firewall prompt appears once; **Allow on private networks** lets the phone connect
- [ ] Clicking **Deny** on the firewall prompt, then Settings → **Fix firewall** (UAC) repairs connectivity

## VB-CABLE wizard

- [ ] Banner shows when VB-CABLE is absent
- [ ] Wizard downloads, unzips, elevates `VBCABLE_Setup_x64.exe` (one UAC prompt)
- [ ] After VB-Audio's "Install Driver" + Re-check: CABLE Input auto-selected, banner gone (reboot fallback message if needed)
- [ ] "Use another output instead" dismissal persists across restarts

## Pairing & streaming — Android Chrome

- [ ] Camera scan opens `https://<ip>:<port>/?token=…`; cert interstitial "Advanced → Proceed" works
- [ ] Mic tap → permission prompt → phone shows **Live**, desktop shows **Live**
- [ ] getUserMedia works over the accepted self-signed cert (expected: yes)
- [ ] Speak into phone → level meters move on both ends → audio arrives in Discord/game via **CABLE Output**
- [ ] Round-trip check: latency selector Low/Balanced/Stable audibly changes buffering; stats line shows sane RTT (<20 ms on LAN)
- [ ] Screen lock stops audio; unlock + tap resumes; wake lock keeps screen on while streaming
- [ ] Walk out of Wi-Fi range and back: phone reconnects automatically (backoff), stream resumes

## Pairing & streaming — iOS Safari

- [ ] Cert interstitial can be accepted; page loads
- [ ] **Known risk:** WSS to a host with an untrusted cert may be refused even after the page loads.
      If the connection dies at "Connecting…", capture Safari remote-inspector logs.
      → If confirmed, implement the long-polling signaling fallback (`POST /signal` / `GET /signal?wait=1`, same message schema) designed in the plan.
- [ ] getUserMedia prompt appears after the mic tap (user gesture requirement)
- [ ] Audio flows; wake lock (16.4+) holds the screen

## Multi-network / hotspot

- [ ] Multi-NIC PC (Ethernet + Wi-Fi + WSL/VPN adapters): Network dropdown lists candidates, virtual adapters deprioritized, switching regenerates the QR
- [ ] DHCP change (reconnect router): within 30 s the app rebinds, banner/QR update, phone re-pairs after one new cert acceptance
- [ ] **Host a hotspot instead**: hotspot starts (no UAC), Wi-Fi QR joins the phone, mic QR then pairs; hotspot stops on app quit only if the app started it
- [ ] PC without Wi-Fi adapter: hotspot button greyed with explanation
- [ ] Guest Wi-Fi with client isolation: connection fails with the targeted help text

## Session hardening

- [ ] Second phone scanning the same QR kicks the first ("Another phone took over")
- [ ] **New code** invalidates the old QR (old page shows "Pairing code expired")
- [ ] Wrong/missing token cannot open signaling (check with `wscat`)

## Desktop app behavior

- [ ] Close → hides to tray (setting on); tray Show/Quit work; second launch focuses the window
- [ ] Start with Windows + Start minimized respected
- [ ] Diagnostics panel live-updates; **Copy diagnostics** blob contains no token
- [ ] Logs rotate in `%APPDATA%/no-mic-no-problem/logs/`
