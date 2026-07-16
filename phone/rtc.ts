import { msg, type AnswerMsg, type CandidateMsg } from '@shared/protocol'
import type { SignalingClient } from './signaling'

export interface MicSession {
  pc: RTCPeerConnection
  stream: MediaStream
  close(): void
  setMuted(muted: boolean): void
  readonly muted: boolean
}

/**
 * Voice-tuned Opus SDP munging: DTX (battery), 32kbps ceiling, 20ms frames,
 * in-band FEC for lossy Wi-Fi. Applied to our offer before setLocalDescription.
 */
export function mungeOpusSdp(sdp: string): string {
  const lines = sdp.split('\r\n')
  const opusPayloads = lines
    .filter((l) => /^a=rtpmap:\d+ opus\//i.test(l))
    .map((l) => l.match(/^a=rtpmap:(\d+)/)?.[1])
    .filter((p): p is string => !!p)
  if (opusPayloads.length === 0) return sdp

  const extras = 'usedtx=1;maxaveragebitrate=32000;ptime=20;useinbandfec=1'
  const out: string[] = []
  const seenFmtp = new Set<string>()
  for (const line of lines) {
    const m = line.match(/^a=fmtp:(\d+) (.*)$/)
    if (m && opusPayloads.includes(m[1]!)) {
      seenFmtp.add(m[1]!)
      // merge: our params win over duplicates
      const existing = m[2]!
        .split(';')
        .map((kv) => kv.trim())
        .filter((kv) => !/^(usedtx|maxaveragebitrate|ptime|useinbandfec)=/.test(kv))
      out.push(`a=fmtp:${m[1]} ${[...existing, ...extras.split(';')].join(';')}`)
    } else {
      out.push(line)
    }
  }
  // add fmtp lines for opus payloads that had none
  const result: string[] = []
  for (const line of out) {
    result.push(line)
    const m = line.match(/^a=rtpmap:(\d+) opus\//i)
    if (m && !seenFmtp.has(m[1]!)) {
      result.push(`a=fmtp:${m[1]} ${extras}`)
    }
  }
  return result.join('\r\n')
}

export async function captureMic(): Promise<MediaStream> {
  // Full voice processing on by default: gaming rooms have speakers blaring.
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1
    },
    video: false
  })
}

/**
 * Create the sending peer. The phone always offers (it owns the mic track);
 * LAN-only, so no STUN/TURN — host candidates suffice.
 */
export async function startMicSession(
  signaling: SignalingClient,
  stream: MediaStream,
  onConnectionState: (state: RTCPeerConnectionState) => void
): Promise<MicSession> {
  const pc = new RTCPeerConnection({ iceServers: [] })
  let muted = false

  for (const track of stream.getAudioTracks()) {
    pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] })
  }

  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      signaling.send(msg({ type: 'candidate', candidate: ev.candidate.toJSON() }))
    }
  }
  pc.onconnectionstatechange = () => onConnectionState(pc.connectionState)

  const offer = await pc.createOffer()
  await pc.setLocalDescription({ type: 'offer', sdp: mungeOpusSdp(offer.sdp ?? '') })
  signaling.send(msg({ type: 'offer', sdp: pc.localDescription?.sdp ?? '' }))

  return {
    pc,
    stream,
    close() {
      pc.close()
      stream.getTracks().forEach((t) => t.stop())
    },
    setMuted(next: boolean) {
      muted = next
      stream.getAudioTracks().forEach((t) => (t.enabled = !next))
      signaling.send(msg({ type: 'mic-state', muted: next }))
    },
    get muted() {
      return muted
    }
  }
}

export async function applyAnswer(session: MicSession, answer: AnswerMsg): Promise<void> {
  await session.pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp })
}

export async function applyCandidate(session: MicSession, cand: CandidateMsg): Promise<void> {
  try {
    await session.pc.addIceCandidate(cand.candidate as RTCIceCandidateInit)
  } catch {
    // stale candidate after renegotiation — safe to ignore
  }
}
