import { VBCABLE_INPUT_LABEL } from '@shared/constants'

export interface OutputDevice {
  deviceId: string
  label: string
  isVbCable: boolean
}

interface SinkableAudio extends HTMLAudioElement {
  setSinkId(id: string): Promise<void>
}

/**
 * Playout + routing. The remote stream plays through an <audio> element
 * because setSinkId on media elements is the reliable way to pick the output
 * device (VB-CABLE's "CABLE Input"). The AnalyserNode taps the stream for the
 * level meter without touching the playout path.
 */
export class AudioOut {
  private audio: SinkableAudio
  private ctx: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private meterBuf: Uint8Array<ArrayBuffer> | null = null

  constructor() {
    this.audio = new Audio() as SinkableAudio
    this.audio.autoplay = true
  }

  async listOutputs(): Promise<OutputDevice[]> {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices
      .filter((d) => d.kind === 'audiooutput')
      .map((d) => ({
        deviceId: d.deviceId,
        label: d.label || `Output ${d.deviceId.slice(0, 6)}`,
        isVbCable: d.label.includes(VBCABLE_INPUT_LABEL)
      }))
  }

  /** Pick the output: explicit user choice > CABLE Input > system default. */
  async autoSelect(preferredId: string | null): Promise<OutputDevice | null> {
    const outputs = await this.listOutputs()
    const preferred = preferredId ? outputs.find((o) => o.deviceId === preferredId) : undefined
    const cable = outputs.find((o) => o.isVbCable)
    const chosen = preferred ?? cable ?? outputs.find((o) => o.deviceId === 'default') ?? outputs[0]
    if (chosen) await this.setSink(chosen.deviceId)
    return chosen ?? null
  }

  async setSink(deviceId: string): Promise<void> {
    await this.audio.setSinkId(deviceId)
  }

  attach(stream: MediaStream): void {
    this.audio.srcObject = stream
    void this.audio.play().catch(() => {
      // Electron renderer is allowed to autoplay; a failure here means the
      // stream ended between attach and play — the next offer re-attaches.
    })
    this.ctx = new AudioContext()
    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = 512
    this.ctx.createMediaStreamSource(stream).connect(this.analyser)
    this.meterBuf = new Uint8Array(this.analyser.frequencyBinCount)
  }

  detach(): void {
    this.audio.srcObject = null
    void this.ctx?.close()
    this.ctx = null
    this.analyser = null
  }

  set muted(m: boolean) {
    this.audio.muted = m
  }
  get muted(): boolean {
    return this.audio.muted
  }

  /** 0..1 peak level for the meter; 0 when no stream attached. */
  level(): number {
    if (!this.analyser || !this.meterBuf) return 0
    this.analyser.getByteTimeDomainData(this.meterBuf)
    let peak = 0
    for (const v of this.meterBuf) peak = Math.max(peak, Math.abs(v - 128) / 128)
    return peak
  }
}
