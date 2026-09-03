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

export type RenderSink = (frame: VideoFrame) => void

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

  onSink?: RenderSink

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
  }

  feed(data: Uint8Array, isConfig: boolean, isKey: boolean): void {
    if (this.disposed) return

    if (isConfig) {
      this.extractSpsPps(data)
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

      let supports: VideoDecoderSupport | null = null
      // 优先 no-preference：让 Chromium 根据当前 GPU 驱动自适应。AMD Radeon 等
      // 驱动不稳的 GPU 上会自动回退到软件 H.264 解码，避免硬件路径输出 corrupt frame
      // 导致"绿屏"（症状：canvas 显示纯绿 + 顶部少量像素残留，本机 AMD RX 9070 GRE 复现）。
      try {
        supports = await VideoDecoder.isConfigSupported({ ...config, hardwareAcceleration: 'no-preference' })
      } catch {
        supports = null
      }

      if (!supports || !supports.supported) {
        // 兜底：显式强制软件解码
        try {
          supports = await VideoDecoder.isConfigSupported({ ...config, hardwareAcceleration: 'prefer-software' })
        } catch {
          supports = null
        }
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
    }
    // 先清屏再绘制：避免上一帧或 GPU 未初始化 buffer 残留（硬件 H.264 解码出 corrupt
    // frame 时，残留区会显示 GPU 默认色 = 绿色，导致"大面积纯绿 + 顶部少量内容"）。
    this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height)
    this.ctx?.drawImage(frame, 0, 0)
    frame.close()
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
