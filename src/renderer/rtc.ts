import { msg, type DesktopToPhone, type OfferMsg, type CandidateMsg } from '@shared/protocol'

export interface ReceiverStats {
  packetsReceived: number
  packetsLost: number
  jitterMs: number
  rttMs: number | null
  audioLevel: number
  jitterBufferMs: number | null
  codec: string
}

export interface ReceiverSession {
  pc: RTCPeerConnection
  stream: MediaStream
  setJitterTarget(ms: number): void
  getStats(): Promise<ReceiverStats>
  close(): void
}

/**
 * Desktop side of the loop: answers the phone's offer and hands the remote
 * audio stream to the caller for playout. LAN-only -> no ICE servers.
 */
export async function answerOffer(
  offer: OfferMsg,
  sendSignal: (m: DesktopToPhone) => void,
  onTrack: (stream: MediaStream) => void,
  onConnectionState: (state: RTCPeerConnectionState) => void,
  jitterTargetMs: number
): Promise<ReceiverSession> {
  const pc = new RTCPeerConnection({ iceServers: [] })
  let remoteStream = new MediaStream()
  let currentJitterTarget = jitterTargetMs

  pc.ontrack = (ev) => {
    remoteStream = ev.streams[0] ?? new MediaStream([ev.track])
    applyJitterTarget(pc, currentJitterTarget)
    onTrack(remoteStream)
  }
  pc.onicecandidate = (ev) => {
    if (ev.candidate) sendSignal(msg({ type: 'candidate', candidate: ev.candidate.toJSON() }))
  }
  pc.onconnectionstatechange = () => onConnectionState(pc.connectionState)

  await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp })
  const answer = await pc.createAnswer()
  await pc.setLocalDescription(answer)
  sendSignal(msg({ type: 'answer', sdp: pc.localDescription?.sdp ?? '' }))

  return {
    pc,
    get stream() {
      return remoteStream
    },
    setJitterTarget(ms: number) {
      currentJitterTarget = ms
      applyJitterTarget(pc, ms)
    },
    getStats: () => collectStats(pc),
    close: () => pc.close()
  }
}

/** jitterBufferTarget is the supported Chromium knob (playoutDelayHint is deprecated). */
function applyJitterTarget(pc: RTCPeerConnection, ms: number): void {
  for (const receiver of pc.getReceivers()) {
    if (receiver.track.kind === 'audio') {
      try {
        ;(receiver as RTCRtpReceiver & { jitterBufferTarget: number | null }).jitterBufferTarget =
          ms
      } catch {
        // older runtimes: harmless, we just keep the default buffer
      }
    }
  }
}

export async function addCandidate(session: ReceiverSession, cand: CandidateMsg): Promise<void> {
  try {
    await session.pc.addIceCandidate(cand.candidate as RTCIceCandidateInit)
  } catch {
    // candidate for a torn-down session — ignore
  }
}

async function collectStats(pc: RTCPeerConnection): Promise<ReceiverStats> {
  const stats = await pc.getStats()
  const out: ReceiverStats = {
    packetsReceived: 0,
    packetsLost: 0,
    jitterMs: 0,
    rttMs: null,
    audioLevel: 0,
    jitterBufferMs: null,
    codec: ''
  }
  const codecs = new Map<string, string>()
  stats.forEach((report) => {
    if (report.type === 'codec') {
      codecs.set(report.id, String(report.mimeType ?? ''))
    }
  })
  stats.forEach((report) => {
    if (report.type === 'inbound-rtp' && report.kind === 'audio') {
      out.packetsReceived = Number(report.packetsReceived ?? 0)
      out.packetsLost = Number(report.packetsLost ?? 0)
      out.jitterMs = Math.round(Number(report.jitter ?? 0) * 1000)
      out.audioLevel = Number(report.audioLevel ?? 0)
      if (report.codecId && codecs.has(String(report.codecId))) {
        out.codec = codecs.get(String(report.codecId)) ?? ''
      }
      const emitted = Number(report.jitterBufferEmittedCount ?? 0)
      if (emitted > 0) {
        out.jitterBufferMs = Math.round((Number(report.jitterBufferDelay ?? 0) / emitted) * 1000)
      }
    }
    if (report.type === 'remote-inbound-rtp' && report.kind === 'audio') {
      if (report.roundTripTime !== undefined) {
        out.rttMs = Math.round(Number(report.roundTripTime) * 1000)
      }
    }
  })
  return out
}
