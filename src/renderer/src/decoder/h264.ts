// Annex-B / AVCC helpers and the WebCodecs H.264 video player.

export function splitNALs(data: Uint8Array): Uint8Array[] {
  const nals: Uint8Array[] = []
  const len = data.length
  let i = 0
  while (i + 2 < len) {
    // locate start code
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      i += 3
    } else if (i + 3 < len && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) {
      i += 4
    } else {
      i++
      continue
    }
    const nalStart = i
    let nalEnd = len
    for (let j = i; j < len - 1; j++) {
      if (data[j] === 0 && data[j + 1] === 0) {
        if (j + 2 < len && data[j + 2] === 1) {
          nalEnd = j
          break
        }
        if (j + 3 < len && data[j + 2] === 0 && data[j + 3] === 1) {
          nalEnd = j
          break
        }
      }
    }
    const nal = data.subarray(nalStart, nalEnd)
    if (nal.length > 0) nals.push(nal)
    i = nalEnd
  }
  return nals
}

export function nalType(nal: Uint8Array): number {
  return nal[0] & 0x1f
}

/** Build an AVCDecoderConfigurationRecord (avcC) from SPS + PPS NAL units. */
export function buildAvcC(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const out: number[] = []
  out.push(0x01) // configurationVersion
  out.push(sps[1], sps[2], sps[3]) // profile, compatibility, level
  out.push(0xff) // lengthSizeMinusOne = 3
  out.push(0xe1) // numOfSequenceParameterSets (1) | reserved
  out.push((sps.length >> 8) & 0xff, sps.length & 0xff)
  out.push(...sps)
  out.push(0x01) // numOfPictureParameterSets
  out.push((pps.length >> 8) & 0xff, pps.length & 0xff)
  out.push(...pps)
  return new Uint8Array(out)
}

/** Convert a set of NAL units to length-prefixed AVCC format. */
export function toAvcc(nals: Uint8Array[]): Uint8Array {
  let total = 0
  for (const n of nals) total += 4 + n.length
  const out = new Uint8Array(total)
  let o = 0
  for (const n of nals) {
    out[o] = (n.length >>> 24) & 0xff
    out[o + 1] = (n.length >>> 16) & 0xff
    out[o + 2] = (n.length >>> 8) & 0xff
    out[o + 3] = n.length & 0xff
    out.set(n, o + 4)
    o += 4 + n.length
  }
  return out
}

function codecString(sps: Uint8Array): string {
  const hex = (b: number): string => b.toString(16).padStart(2, '0')
  return `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function bytesEqual(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export type RenderSink = (frame: VideoFrame) => void

/** Hardware-acceleration strategy for the WebCodecs decoder. */
export type DecoderAcceleration = 'auto' | 'hardware' | 'software'

/**
 * Decodes a raw scrcpy H.264 stream (config packets + media packets, Annex B)
 * and renders to a canvas. Implements the same config/frame merge the scrcpy
 * C client performs (packet_merger).
 */
export class H264Player {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D | null
  private decoder: VideoDecoder | null = null
  private configured = false
  private configuring = false
  private pendingConfig: Uint8Array | null = null
  private pendingFrames: { data: Uint8Array; isKey: boolean }[] = []
  private sps: Uint8Array | null = null
  private pps: Uint8Array | null = null
  private lastTimestamp = 0
  private disposed = false
  private acceleration: DecoderAcceleration

  onSink?: RenderSink

  constructor(canvas: HTMLCanvasElement, opts?: { acceleration?: DecoderAcceleration }) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.acceleration = opts?.acceleration ?? 'auto'
  }

  feed(data: Uint8Array, isConfig: boolean, isKey: boolean): void {
    if (this.disposed) return

    if (isConfig) {
      const prevSps = this.sps
      const prevPps = this.pps
      this.extractSpsPps(data)
      // 设备旋转（竖屏↔横屏）会让设备端重建编码器并下发新的 SPS/PPS（分辨率变了）。
      // 已配置的解码器仍按旧分辨率工作，直接喂新尺寸帧会输出 corrupt frame（绿/白/黑）。
      // 检测到 SPS/PPS 变化时重建解码器，让 WebCodecs 按新分辨率重新 configure。
      if (this.configured && (!bytesEqual(prevSps, this.sps) || !bytesEqual(prevPps, this.pps))) {
        this.resetDecoder()
      }
      if (!this.configured) void this.configureDecoder()
      return
    }

    // merge config packet into the following media packet (mirrors scrcpy)
    if (this.pendingConfig) {
      data = concat(this.pendingConfig, data)
      this.pendingConfig = null
    }

    if (!this.configured) {
      // Decoder not ready yet — buffer frames instead of dropping them, so the
      // first keyframe is still decoded once the decoder becomes available.
      this.pendingFrames.push({ data, isKey })
      if (this.sps && this.pps) void this.configureDecoder()
      return
    }

    this.decodeFrame(data, isKey)
  }

  private decodeFrame(data: Uint8Array, isKey: boolean): void {
    if (!this.decoder || this.decoder.state !== 'configured') return

    const nals = splitNALs(data)
    const chunk = new EncodedVideoChunk({
      type: isKey ? 'key' : 'delta',
      timestamp: this.nextTimestamp(),
      data: toAvcc(nals)
    })
    try {
      this.decoder.decode(chunk)
    } catch {
      // decoder may be flushing; drop this frame
    }
  }

  resize(width: number, height: number): void {
    if (this.canvas.width === width && this.canvas.height === height) return
    this.canvas.width = width
    this.canvas.height = height
    // 同步 CSS 渲染比例，max-width/max-height 缩放时保持 frame 物理宽高比
    this.canvas.style.aspectRatio = `${width} / ${height}`
  }

  private extractSpsPps(data: Uint8Array): void {
    for (const nal of splitNALs(data)) {
      const t = nalType(nal)
      if (t === 7) this.sps = nal
      else if (t === 8) this.pps = nal
    }
  }

  private nextTimestamp(): number {
    // monotonic microsecond clock
    const now = Math.floor(performance.now() * 1000)
    if (now <= this.lastTimestamp) this.lastTimestamp += 1
    else this.lastTimestamp = now
    return this.lastTimestamp
  }

  private async configureDecoder(): Promise<void> {
    if (this.configuring || this.configured) return
    const sps = this.sps
    const pps = this.pps
    if (!sps || !pps) return
    this.configuring = true

    try {
      const description = buildAvcC(sps, pps)
      const codec = codecString(sps)

      const config: VideoDecoderConfig = {
        codec,
        description: description.buffer as ArrayBuffer,
        optimizeForLatency: true
      }

      // 三档硬件加速策略（用户可在设置里选择）：
      //  - software：强制软件解码。规避 AMD Radeon 等驱动不稳的 GPU 上硬件 H.264 解码
      //    输出 corrupt frame 导致的"绿屏"（本机 AMD RX 9070 GRE 复现）。
      //  - hardware：优先硬件解码（性能最好），失败则回退软件避免完全黑屏。
      //  - auto（默认）：no-preference 让 Chromium 自适应，失败再软件兜底。
      let supports: VideoDecoderSupport | null = null
      const check = async (hw: 'no-preference' | 'prefer-hardware' | 'prefer-software'): Promise<VideoDecoderSupport | null> => {
        try {
          return await VideoDecoder.isConfigSupported({ ...config, hardwareAcceleration: hw })
        } catch {
          return null
        }
      }

      if (this.acceleration === 'software') {
        supports = await check('prefer-software')
      } else if (this.acceleration === 'hardware') {
        supports = await check('prefer-hardware')
        if (!supports?.supported) supports = await check('prefer-software')
      } else {
        supports = await check('no-preference')
        if (!supports?.supported) supports = await check('prefer-software')
      }

      if (this.disposed) return

      if (!supports || !supports.supported) {
        this.onError?.('当前系统无法解码 H.264 视频流')
        return
      }

      this.decoder?.close()
      this.decoder = new VideoDecoder({
        output: (frame) => this.render(frame),
        error: (e) => this.onError?.(e.message || '解码错误')
      })
      this.decoder.configure(config)
      this.configured = true

      // flush buffered frames now that the decoder is ready (preserves the first keyframe)
      const queued = this.pendingFrames
      this.pendingFrames = []
      for (const f of queued) this.decodeFrame(f.data, f.isKey)
    } finally {
      this.configuring = false
    }
  }

  onError?: (message: string) => void

  private render(frame: VideoFrame): void {
    if (this.disposed) {
      frame.close()
      return
    }
    if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
      this.canvas.width = frame.displayWidth
      this.canvas.height = frame.displayHeight
      // 同步 CSS 渲染比例：max-width/max-height 缩放时保持 frame 物理宽高比
      // （否则竖屏设备在横向窗口里会被 max-height 裁掉底部，max-width 拉出左右黑边）
      this.canvas.style.aspectRatio = `${frame.displayWidth} / ${frame.displayHeight}`
    }
    // 先清屏再绘制：避免上一帧或 GPU 未初始化 buffer 残留（硬件 H.264 解码出 corrupt
    // frame 时，残留区会显示 GPU 默认色 = 绿色，导致"大面积纯绿 + 顶部少量内容"）。
    this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height)
    this.ctx?.drawImage(frame, 0, 0)
    frame.close()
  }

  /** 关闭旧解码器并清空待解码缓冲，用于设备旋转导致分辨率/SPS 变化时重建解码器。 */
  private resetDecoder(): void {
    if (this.decoder && this.decoder.state !== 'closed') {
      try {
        this.decoder.close()
      } catch {
        /* ignore */
      }
    }
    this.decoder = null
    this.configured = false
    // 旧分辨率下缓冲的帧已无意义（尺寸不匹配），丢弃；后续新关键帧会在 configure
    // 完成后经 pendingFrames 重新缓冲。
    this.pendingFrames = []
  }

  dispose(): void {
    this.disposed = true
    if (this.decoder && this.decoder.state !== 'closed') {
      try {
        this.decoder.close()
      } catch {
        /* ignore */
      }
    }
    this.decoder = null
    this.configured = false
  }
}
