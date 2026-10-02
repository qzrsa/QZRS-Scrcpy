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

// ---- HEVC (H.265) 支持 ----

export function hevcNalType(nal: Uint8Array): number {
  // HEVC NAL header 第 1 字节：forbidden_zero_bit(1) + nal_unit_type(6) + nuh_layer_id(1)
  return (nal[0] >> 1) & 0x3f
}

/** 通过 config 数据的 NAL 类型判断是 H.264 还是 HEVC（HEVC 的 VPS/SPS/PPS = 32/33/34）。 */
function detectCodecType(data: Uint8Array): 'h264' | 'hevc' {
  for (const nal of splitNALs(data)) {
    if (nal.length === 0) continue
    const t = (nal[0] >> 1) & 0x3f
    if (t === 32 || t === 33 || t === 34) return 'hevc'
  }
  return 'h264'
}

interface HevcSpsInfo {
  profileSpace: number
  tierFlag: number
  profileIdc: number
  compatFlags: number[]
  constraintFlags: number[]
  levelIdc: number
  chromaFormatIdc: number
  bitDepthLumaMinus8: number
  bitDepthChromaMinus8: number
  width: number
  height: number
}

class BitReader {
  private data: Uint8Array
  private pos = 0
  constructor(data: Uint8Array) {
    this.data = data
  }
  readBit(): number {
    if (this.pos >= this.data.length * 8) return 0
    const bit = (this.data[this.pos >> 3] >> (7 - (this.pos & 7))) & 1
    this.pos++
    return bit
  }
  readBits(n: number): number {
    let v = 0
    for (let i = 0; i < n; i++) v = (v << 1) | this.readBit()
    return v
  }
  readUe(): number {
    let zeros = 0
    while (this.readBit() === 0) zeros++
    if (zeros === 0) return 0
    return (1 << zeros) - 1 + this.readBits(zeros)
  }
  skipBits(n: number): void {
    this.pos += n
  }
}

/** 解析 HEVC SPS，提取构建 hvcC / codec string 所需的 profile、level、chroma、bitdepth。 */
function parseHevcSps(sps: Uint8Array): HevcSpsInfo {
  const r = new BitReader(sps)
  r.skipBits(16) // 跳过 2 字节 NAL header
  r.readBits(4) // sps_video_parameter_set_id
  const maxSubLayersMinus1 = r.readBits(3)
  r.readBits(1) // sps_temporal_id_nesting_flag

  // profile_tier_level general 部分
  const profileSpace = r.readBits(2)
  const tierFlag = r.readBits(1)
  const profileIdc = r.readBits(5)
  const compatFlags = [r.readBits(8), r.readBits(8), r.readBits(8), r.readBits(8)]
  const constraintFlags: number[] = []
  for (let i = 0; i < 6; i++) constraintFlags.push(r.readBits(8))
  const levelIdc = r.readBits(8)

  // 跳过 sub-layer 的 profile/level 信息
  const subProfilePresent: boolean[] = []
  const subLevelPresent: boolean[] = []
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    subProfilePresent.push(r.readBit() === 1)
    subLevelPresent.push(r.readBit() === 1)
  }
  if (maxSubLayersMinus1 > 0) {
    for (let i = maxSubLayersMinus1; i < 8; i++) r.readBits(2)
  }
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    if (subProfilePresent[i]) r.skipBits(88)
    if (subLevelPresent[i]) r.readBits(8)
  }

  r.readUe() // sps_seq_parameter_set_id
  const chromaFormatIdc = r.readUe()
  if (chromaFormatIdc === 3) r.readBits(1) // separate_colour_plane_flag
  const width = r.readUe() // pic_width_in_luma_samples
  const height = r.readUe() // pic_height_in_luma_samples
  const conformanceWindowFlag = r.readBit()
  if (conformanceWindowFlag) {
    r.readUe()
    r.readUe()
    r.readUe()
    r.readUe()
  }
  const bitDepthLumaMinus8 = r.readUe()
  const bitDepthChromaMinus8 = r.readUe()

  return {
    profileSpace,
    tierFlag,
    profileIdc,
    compatFlags,
    constraintFlags,
    levelIdc,
    chromaFormatIdc,
    bitDepthLumaMinus8,
    bitDepthChromaMinus8,
    width,
    height
  }
}

/** 构建 HEVCDecoderConfigurationRecord (hvcC)。 */
function buildHvcC(vps: Uint8Array, sps: Uint8Array, pps: Uint8Array, info: HevcSpsInfo): Uint8Array {
  const out: number[] = []
  out.push(0x01) // configurationVersion
  out.push((info.profileSpace << 6) | (info.tierFlag << 5) | info.profileIdc)
  out.push(...info.compatFlags) // general_profile_compatibility_flags (4)
  out.push(...info.constraintFlags) // general_constraint_indicator_flags (6)
  out.push(info.levelIdc) // general_level_idc
  out.push(0xf0, 0x00) // reserved(4) + min_spatial_segmentation_idc(12)
  out.push(0xfc) // reserved(6) + parallelismType(2)
  out.push(0xfc | info.chromaFormatIdc) // reserved(6) + chromaFormat(2)
  out.push(0xf8 | info.bitDepthLumaMinus8) // reserved(5) + bitDepthLumaMinus8(3)
  out.push(0xf8 | info.bitDepthChromaMinus8) // reserved(5) + bitDepthChromaMinus8(3)
  out.push(0x00, 0x00) // avgFrameRate (16)
  out.push(0x0f) // constantFrameRate(2)+numTemporalLayers(3)+temporalIdNested(1)+lengthSizeMinusOne(2)=3
  out.push(0x03) // numOfArrays = 3 (VPS/SPS/PPS)

  // VPS array
  out.push(0xa0) // array_completeness(1)+reserved(1)+NAL_unit_type(6) = 0x80 | 32
  out.push(0x00, 0x01) // numNalus = 1
  out.push((vps.length >> 8) & 0xff, vps.length & 0xff)
  out.push(...vps)
  // SPS array
  out.push(0xa1) // 0x80 | 33
  out.push(0x00, 0x01)
  out.push((sps.length >> 8) & 0xff, sps.length & 0xff)
  out.push(...sps)
  // PPS array
  out.push(0xa2) // 0x80 | 34
  out.push(0x00, 0x01)
  out.push((pps.length >> 8) & 0xff, pps.length & 0xff)
  out.push(...pps)
  return new Uint8Array(out)
}

/** 生成 HEVC codec string，如 hvc1.1.6.L93.B0（Main, level 3.1）。 */
function hevcCodecString(info: HevcSpsInfo): string {
  const compat32 =
    ((info.compatFlags[0] << 24) | (info.compatFlags[1] << 16) | (info.compatFlags[2] << 8) | info.compatFlags[3]) >>> 0
  let compatHex = compat32.toString(16).replace(/0+$/, '')
  if (compatHex === '') compatHex = '0'
  const tier = info.tierFlag ? 'H' : 'L'
  return `hvc1.${info.profileIdc}.${compatHex}.${tier}${info.levelIdc}.B0`
}

export type RenderSink = (frame: VideoFrame) => void

/** Hardware-acceleration strategy for the WebCodecs decoder. */
export type DecoderAcceleration = 'auto' | 'hardware' | 'software'

/**
 * Decodes a raw scrcpy video stream (H.264 or HEVC/H.265, config packets +
 * media packets, Annex B) and renders to a canvas. Implements the same
 * config/frame merge the scrcpy C client performs (packet_merger).
 */
export class H264Player {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D | null
  private decoder: VideoDecoder | null = null
  private configured = false
  private configuring = false
  private pendingConfig: Uint8Array | null = null
  private pendingFrames: { data: Uint8Array; isKey: boolean }[] = []
  private codecType: 'h264' | 'hevc' | null = null
  private vps: Uint8Array | null = null
  private sps: Uint8Array | null = null
  private pps: Uint8Array | null = null
  private lastTimestamp = 0
  private disposed = false
  private acceleration: DecoderAcceleration
  private renderFrames = 0
  private hardware = false
  private statsTimer: number | null = null

  onSink?: RenderSink
  onStats?: (s: { renderFps: number; hardware: boolean }) => void

  constructor(canvas: HTMLCanvasElement, opts?: { acceleration?: DecoderAcceleration }) {
    this.canvas = canvas
    // alpha:false：视频画布不需要透明通道，跳过合成可省一次混合；
    // desynchronized:true：提示浏览器走低延迟呈现路径（允许跳过 vsync 队列）。
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })
    this.acceleration = opts?.acceleration ?? 'auto'
  }

  feed(data: Uint8Array, isConfig: boolean, isKey: boolean): void {
    if (this.disposed) return

    if (isConfig) {
      if (this.codecType === null) this.codecType = detectCodecType(data)
      const prevSps = this.sps
      const prevPps = this.pps
      const prevVps = this.vps
      if (this.codecType === 'hevc') this.extractHevcConfig(data)
      else this.extractSpsPps(data)
      // 设备旋转（竖屏↔横屏）会让设备端重建编码器并下发新的 VPS/SPS/PPS（分辨率变了）。
      // 已配置的解码器仍按旧分辨率工作，直接喂新尺寸帧会输出 corrupt frame（绿/白/黑）。
      // 检测到参数集变化时重建解码器，让 WebCodecs 按新分辨率重新 configure。
      if (this.configured && (!bytesEqual(prevSps, this.sps) || !bytesEqual(prevPps, this.pps) || !bytesEqual(prevVps, this.vps))) {
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
    this.onVideoSize?.(width, height)
  }

  private extractSpsPps(data: Uint8Array): void {
    for (const nal of splitNALs(data)) {
      const t = nalType(nal)
      if (t === 7) this.sps = nal
      else if (t === 8) this.pps = nal
    }
  }

  private extractHevcConfig(data: Uint8Array): void {
    for (const nal of splitNALs(data)) {
      const t = hevcNalType(nal)
      if (t === 32) this.vps = nal
      else if (t === 33) this.sps = nal
      else if (t === 34) this.pps = nal
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
    if (this.codecType === 'hevc' && !this.vps) return
    this.configuring = true

    try {
      let config: VideoDecoderConfig
      let label: string
      if (this.codecType === 'hevc') {
        const info = parseHevcSps(sps)
        config = {
          codec: hevcCodecString(info),
          description: buildHvcC(this.vps as Uint8Array, sps, pps, info).buffer as ArrayBuffer,
          optimizeForLatency: true
        }
        label = 'H.265'
      } else {
        config = {
          codec: codecString(sps),
          description: buildAvcC(sps, pps).buffer as ArrayBuffer,
          optimizeForLatency: true
        }
        label = 'H.264'
      }

      const supported = await this.checkSupport(config)

      if (this.disposed) return

      if (!supported.supported) {
        this.onError?.(`当前系统无法解码 ${label} 视频流`)
        return
      }

      this.hardware = supported.hardware
      this.decoder?.close()
      this.decoder = new VideoDecoder({
        output: (frame) => this.render(frame),
        error: (e) => this.onError?.(e.message || '解码错误')
      })
      this.decoder.configure(config)
      this.configured = true

      this.startStats()

      // flush buffered frames now that the decoder is ready (preserves the first keyframe)
      const queued = this.pendingFrames
      this.pendingFrames = []
      for (const f of queued) this.decodeFrame(f.data, f.isKey)
    } finally {
      this.configuring = false
    }
  }

  /**
   * 三档硬件加速策略（用户可在设置里选择）：
   *  - software：强制软件解码。规避 AMD Radeon 等驱动不稳的 GPU 上硬件 H.264 解码
   *    输出 corrupt frame 导致的"绿屏"（本机 AMD RX 9070 GRE 复现）。
   *    注：HEVC 无软件解码（Chromium 不含），选 software 时 HEVC 会判定为不支持。
   *  - hardware：优先硬件解码（性能最好），失败则回退软件避免完全黑屏。
   *  - auto（默认）：no-preference 让 Chromium 自适应，失败再软件兜底。
   */
  private async checkSupport(config: VideoDecoderConfig): Promise<{ supported: boolean; hardware: boolean }> {
    const check = async (hw: 'no-preference' | 'prefer-hardware' | 'prefer-software'): Promise<VideoDecoderSupport | null> => {
      try {
        return await VideoDecoder.isConfigSupported({ ...config, hardwareAcceleration: hw })
      } catch {
        return null
      }
    }

    let supports: VideoDecoderSupport | null = null
    if (this.acceleration === 'software') {
      supports = await check('prefer-software')
    } else if (this.acceleration === 'hardware') {
      supports = await check('prefer-hardware')
      if (!supports?.supported) supports = await check('prefer-software')
    } else {
      supports = await check('no-preference')
      if (!supports?.supported) supports = await check('prefer-software')
    }
    const supported = supports?.supported ?? false
    const actualHw = supports?.config?.hardwareAcceleration ?? ''
    const hardware = actualHw === 'prefer-hardware' || (actualHw === '' && this.acceleration === 'hardware')
    return { supported, hardware }
  }

  /** 每秒上报渲染帧率 + 解码方式。 */
  private startStats(): void {
    if (this.statsTimer) return
    this.statsTimer = window.setInterval(() => {
      const fps = this.renderFrames
      this.renderFrames = 0
      this.onStats?.({ renderFps: fps, hardware: this.hardware })
    }, 1000)
  }

  onError?: (message: string) => void

  /**
   * 解码缓冲尺寸发生变化时回调（首帧、设备旋转、切会话换分辨率）。
   * 画布的 CSS 显示尺寸由调用方按这个尺寸重算 —— 见 `videoFit.ts`：
   * `width/height: auto` 以这个尺寸为基准，窗口变大时画布不会跟着放大。
   */
  onVideoSize?: (width: number, height: number) => void

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
      this.onVideoSize?.(frame.displayWidth, frame.displayHeight)
    }
    // 先清屏再绘制：避免上一帧或 GPU 未初始化 buffer 残留（硬件 H.264 解码出 corrupt
    // frame 时，残留区会显示 GPU 默认色 = 绿色，导致"大面积纯绿 + 顶部少量内容"）。
    this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height)
    this.ctx?.drawImage(frame, 0, 0)
    this.renderFrames++
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
    if (this.statsTimer) {
      clearInterval(this.statsTimer)
      this.statsTimer = null
    }
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
