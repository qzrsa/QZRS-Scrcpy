// scrcpy 音频流 → WebCodecs 解码 → WebAudio 排程播放。
//
// 输入格式（主进程已拆包）：每个包 = 裸编码数据，config 包（OpusHead / fLaC extradata）
// 单独带 isConfig 标记。这与视频不同——音频没有 12B session meta，采样率/声道数由
// 服务端写死（AudioConfig：48000 Hz / 2 声道）。

/** scrcpy 音频编码名 → WebCodecs codec string。raw(PCM) 无 WebCodecs 解码器。 */
const CODEC_STRING: Record<string, string> = {
  opus: 'opus',
  aac: 'mp4a.40.2',
  flac: 'flac'
}

/** 起播缓冲：攒够这么多音频再开始播，避免开头就断断续续。 */
const TARGET_LATENCY = 0.08
/** 排程不允许落到"现在"之前；落后到这个裕度就前移时间轴。 */
const MIN_AHEAD = 0.02
/** 时间轴领先超过这个量说明积压了（卡顿后狂追），直接重置回收延迟。 */
const MAX_AHEAD = 0.35
/** 解码队列积压上限：超过就丢包追实时（音频宁可丢一点也不能越播越延迟）。 */
const MAX_DECODE_QUEUE = 60

export class AudioPlayer {
  readonly sessionId: string

  private ctx: AudioContext | null = null
  private gain: GainNode | null = null
  private decoder: AudioDecoder | null = null
  private description: ArrayBuffer | null = null
  private codec: string | null = null
  private sampleRate = 48000
  private channels = 2

  /** 下一帧应该播出的 AudioContext 时刻（秒），0 = 尚未起播。 */
  private nextTime = 0
  private sources = new Set<AudioBufferSourceNode>()
  private disposed = false
  private warned = false

  onError?: (message: string) => void

  constructor(sessionId: string) {
    this.sessionId = sessionId
  }

  /** 收到流头（4B codecId）时调用，拿到编码与采样参数。 */
  configure(codec: string, sampleRate: number, channels: number): void {
    if (this.disposed) return
    this.codec = codec
    this.sampleRate = sampleRate || 48000
    this.channels = channels || 2
    // 编码换了要重建解码器（description 也会随之更新）。
    this.resetDecoder()
  }

  /**
   * 喂一包数据。isConfig 的包用来 configure 解码器（不送 decode）。
   * pts 是服务端微秒时间戳，仅用于调试；排程走本地时钟（见 schedule）。
   */
  feed(data: Uint8Array, isConfig: boolean, pts: number): void {
    if (this.disposed || data.length === 0) return

    if (isConfig) {
      // opus/flac 的 config 包已被服务端裁剪成纯 extradata（OpusHead / fLaC），
      // 可直接作为 WebCodecs 的 description。
      const copy = new Uint8Array(data.length)
      copy.set(data)
      this.description = copy.buffer
      this.resetDecoder()
      return
    }

    const decoder = this.ensureDecoder()
    if (!decoder) return

    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume()

    // 解码跟不上就丢包，保证声音贴着实时而不是无限滞后。
    if (decoder.decodeQueueSize > MAX_DECODE_QUEUE) return

    const copy = new Uint8Array(data.length)
    copy.set(data)
    try {
      decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: pts, data: copy.buffer }))
    } catch {
      // 解码器可能在 flush/close 中，丢掉这一包
    }
  }

  stop(): void {
    this.disposed = true
    this.resetDecoder()
    for (const s of this.sources) {
      try {
        s.stop()
      } catch {
        /* ignore */
      }
    }
    this.sources.clear()
    this.gain?.disconnect()
    this.gain = null
    const ctx = this.ctx
    this.ctx = null
    if (ctx) void ctx.close().catch(() => undefined)
  }

  // ---- 内部 ----

  private ensureDecoder(): AudioDecoder | null {
    if (this.decoder && this.decoder.state === 'configured') return this.decoder
    if (!this.codec) return null

    const codecString = CODEC_STRING[this.codec]
    if (!codecString) {
      this.warn(`内置播放器暂不支持 ${this.codec} 音频`)
      return null
    }

    try {
      const decoder = new AudioDecoder({
        output: (d) => this.schedule(d),
        error: (e) => this.warn(e.message || '音频解码错误')
      })
      decoder.configure({
        codec: codecString,
        sampleRate: this.sampleRate,
        numberOfChannels: this.channels,
        ...(this.description ? { description: this.description } : {})
      })
      this.decoder = decoder
      return decoder
    } catch (e) {
      this.warn(`音频解码器初始化失败：${e instanceof Error ? e.message : String(e)}`)
      return null
    }
  }

  private resetDecoder(): void {
    if (this.decoder && this.decoder.state !== 'closed') {
      try {
        this.decoder.close()
      } catch {
        /* ignore */
      }
    }
    this.decoder = null
  }

  /** 把解码出的 PCM 走 WebAudio 时间轴排队播出，并按漂移量做校正。 */
  private schedule(data: AudioData): void {
    if (this.disposed) {
      data.close()
      return
    }
    const frames = data.numberOfFrames
    if (frames === 0) {
      data.close()
      return
    }

    const ctx = this.ensureContext()
    if (!ctx) {
      data.close()
      return
    }

    const rate = data.sampleRate
    const chans = data.numberOfChannels < 1 ? 1 : data.numberOfChannels
    const buffer = ctx.createBuffer(chans, frames, rate)
    try {
      for (let ch = 0; ch < chans; ch++) {
        const plane = new Float32Array(frames)
        data.copyTo(plane, { planeIndex: ch, format: 'f32-planar' })
        buffer.copyToChannel(plane, ch)
      }
    } catch {
      // 个别格式不允许 f32-planar 转换时放弃这一帧
      data.close()
      return
    }
    data.close()

    const now = ctx.currentTime
    if (this.nextTime === 0) this.nextTime = now + TARGET_LATENCY
    // 落后：时间轴已被现实抛下，前移到最小裕度（不追求补齐，只求不爆音）。
    if (this.nextTime < now + MIN_AHEAD) this.nextTime = now + MIN_AHEAD
    // 领先过多：说明中间卡顿过，重新攒缓冲，避免延迟越积越大。
    else if (this.nextTime > now + MAX_AHEAD) this.nextTime = now + TARGET_LATENCY

    const when = this.nextTime
    this.nextTime += frames / rate

    const src = ctx.createBufferSource()
    src.buffer = buffer
    if (this.gain) src.connect(this.gain)
    src.onended = () => {
      src.disconnect()
      this.sources.delete(src)
    }
    this.sources.add(src)
    try {
      src.start(when)
    } catch {
      this.sources.delete(src)
    }
  }

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx
    try {
      // 固定 48kHz：与 scrcpy 的 AudioConfig 一致，交给 Chromium 重采样到设备实际采样率
      // （避免我们自己按设备采样率解释 48k 数据导致的变调）。
      const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })
      const gain = ctx.createGain()
      gain.gain.value = 1
      gain.connect(ctx.destination)
      this.ctx = ctx
      this.gain = gain
      void ctx.resume().catch(() => undefined)
      return ctx
    } catch (e) {
      this.warn(`音频输出初始化失败：${e instanceof Error ? e.message : String(e)}`)
      return null
    }
  }

  private warn(message: string): void {
    if (this.warned) return
    this.warned = true
    this.onError?.(message)
  }
}

// ---- 按会话管理播放器实例 ----

const players = new Map<string, AudioPlayer>()

export function playerFor(sessionId: string): AudioPlayer {
  let p = players.get(sessionId)
  if (!p) {
    p = new AudioPlayer(sessionId)
    p.onError = (msg) => console.warn(`[音频 ${sessionId}] ${msg}`)
    players.set(sessionId, p)
  }
  return p
}

export function disposePlayer(sessionId: string): void {
  const p = players.get(sessionId)
  if (!p) return
  players.delete(sessionId)
  p.stop()
}

export function disposeAllPlayers(): void {
  for (const [id, p] of [...players]) {
    players.delete(id)
    p.stop()
  }
}
