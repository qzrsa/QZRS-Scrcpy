import net from 'node:net'
import type { Socket } from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import type { AdbClient } from './adb'
import { findFreePort, randomScid, socketNameFor, sleep } from './util'
import { encodeControlCommand } from './protocol'
import type { AudioCodec, AudioMeta, ControlCommand, SessionOptions, StreamMeta } from '@shared/types'

const DEVICE_NAME_LENGTH = 64
const PACKET_FLAG_CONFIG = 1n << 62n
const PACKET_FLAG_KEY_FRAME = 1n << 61n
const PTS_MASK = (1n << 61n) - 1n

/** 音频流头 4 字节 codecId（scrcpy AudioCodec 枚举的 ASCII 值） */
const AUDIO_CODEC_IDS: Record<number, AudioCodec> = {
  0x6f707573: 'opus', // 'opus'
  0x00616163: 'aac', // '\0aac'
  0x666c6163: 'flac', // 'flac'
  0x00726177: 'raw' // '\0raw'
}

/** 服务端写死的音频参数（AudioConfig：48000 Hz / 2 声道），流头里不带，只能按常量处理 */
const AUDIO_SAMPLE_RATE = 48000
const AUDIO_CHANNELS = 2

type Phase = 'codec' | 'session' | 'frame-header' | 'frame-payload'
/** 音频没有 session meta（分辨率那 12 字节），所以少一个相位 */
type AudioPhase = 'codec' | 'frame-header' | 'frame-payload'

export interface SessionCallbacks {
  onStarted(info: { sessionId: string; deviceName: string; width: number; height: number; codec: string }): void
  onFrame(sessionId: string, data: Uint8Array, pts: number, isKey: boolean, isConfig: boolean): void
  onStreamMeta(meta: StreamMeta): void
  /** 音频流头解析成功（可以开始 configure 解码器） */
  onAudioMeta(meta: AudioMeta): void
  onAudioFrame(sessionId: string, data: Uint8Array, pts: number, isConfig: boolean): void
  /** 服务端明确禁用音频（Android < 11 / 采集失败 / 配置错误）；视频不受影响 */
  onAudioDisabled(sessionId: string, reason: string): void
  onStopped(sessionId: string): void
  onError(sessionId: string, message: string): void
  onClipboard(sessionId: string, text: string): void
  onLog(sessionId: string, line: string): void
}

export class ScrcpySession {
  readonly sessionId: string
  private adb: AdbClient
  private serial: string
  private opts: SessionOptions
  private serverPath: string
  private cbs: SessionCallbacks

  private localPort = 0
  private scid: number
  private videoSocket: Socket | null = null
  private audioSocket: Socket | null = null
  private controlSocket: Socket | null = null
  private serverProc: ChildProcess | null = null
  private stopped = false
  private disposed = false

  private buffer: Buffer = Buffer.alloc(0)
  private phase: Phase = 'codec'
  private pendingFrame: { size: number; isConfig: boolean; isKey: boolean; pts: number } | null = null
  private codec = 'h264'
  private videoSize = { width: 0, height: 0 }

  // ---- 音频流（独立 socket，独立解析状态机）----
  private audioEnabled = false
  private audioBuffer: Buffer = Buffer.alloc(0)
  private audioPhase: AudioPhase = 'codec'
  private audioCodec: AudioCodec | null = null
  private audioPending: { size: number; isConfig: boolean; pts: number } | null = null
  private audioBytesReceived = 0

  // 实时统计：字节数（累计，采样算网速），帧数/pts（窗口值，采样后 reset 算帧率）
  private bytesReceived = 0
  private statFrames = 0
  private statPtsStart = 0
  private statPtsEnd = 0

  constructor(
    sessionId: string,
    adb: AdbClient,
    serial: string,
    opts: SessionOptions,
    serverPath: string,
    cbs: SessionCallbacks
  ) {
    this.sessionId = sessionId
    this.adb = adb
    this.serial = serial
    this.opts = opts
    this.serverPath = serverPath
    this.cbs = cbs
    this.scid = randomScid()
  }

  async start(): Promise<void> {
    // 音频开关在建立 socket 之前就要定下来：它决定服务端 accept 几路、我们连几路
    this.audioEnabled = this.opts.audio
    try {
      await this.adb.startServer()

      // 1. push the server binary
      const pushed = await this.adb.push(this.serial, this.serverPath, '/data/local/tmp/scrcpy-server.jar')
      if (pushed.code !== 0) {
        throw new Error('无法推送 scrcpy-server：' + (pushed.stderr || pushed.stdout || `exit ${pushed.code}`))
      }

      // 2. open the forward tunnel
      this.localPort = await findFreePort()
      const socketName = socketNameFor(this.scid)
      const fwd = await this.adb.forward(this.serial, this.localPort, socketName)
      if (fwd.code !== 0) {
        throw new Error('无法建立 adb forward：' + (fwd.stderr || fwd.stdout || `exit ${fwd.code}`))
      }

      // 3. launch the server
      this.serverProc = spawn(this.adb.path, this.buildServerArgs(), {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      this.serverProc.stdout?.on('data', (d) => this.cbs.onLog(this.sessionId, d.toString().trim()))
      this.serverProc.stderr?.on('data', (d) => this.cbs.onLog(this.sessionId, d.toString().trim()))

      // 4. connect the video socket (read 1 dummy byte to confirm a live link)
      this.videoSocket = await this.connectVideo()

      // 5. connect the audio socket — 必须在 video 与 control **之间**：
      //    服务端 DesktopConnection.open() 按 video→audio→control 顺序阻塞 accept()，
      //    顺序错了会死锁。dummy byte 只由第一路（video）读，这里不要再读。
      if (this.audioEnabled) {
        this.audioSocket = await this.connectAudio()
      }

      // 6. connect the control socket (server only writes the device name after
      //    ALL enabled sockets are accepted, so control must be connected here)
      this.controlSocket = await this.connectControl()

      // 7. read the 64-byte device name from the video socket
      const deviceName = await this.readDeviceName(this.videoSocket)

      // 8. wire up streaming (sockets start paused; resume after listeners attached)
      this.videoSocket.on('data', (chunk) => this.handleVideoData(chunk))
      this.videoSocket.on('error', () => this.handleDisconnect())
      this.videoSocket.on('close', () => this.handleDisconnect())
      this.controlSocket.on('data', (chunk) => this.handleControlData(chunk))
      this.controlSocket.on('error', () => this.handleDisconnect())
      this.controlSocket.on('close', () => this.handleDisconnect())
      this.videoSocket.resume()
      this.controlSocket.resume()
      if (this.audioSocket) {
        this.audioSocket.on('data', (chunk) => this.handleAudioData(chunk))
        // 音频 socket 掉线只影响声音，不该把整个会话拆掉。
        // 会话正常收尾（stop/视频先断）时 disposed 已经为 true，这里不再重复上报。
        this.audioSocket.on('error', () => {
          if (!this.disposed) this.disableAudio('音频通道错误')
        })
        this.audioSocket.on('close', () => {
          if (!this.disposed) this.disableAudio('音频通道已关闭')
        })
        this.audioSocket.resume()
      }

      this.cbs.onStarted({
        sessionId: this.sessionId,
        deviceName,
        width: this.videoSize.width,
        height: this.videoSize.height,
        codec: this.codec
      })
    } catch (err) {
      this.cbs.onError(this.sessionId, err instanceof Error ? err.message : String(err))
      void this.stop()
    }
  }

  private buildServerArgs(): string[] {
    const o = this.opts
    const args = [
      '-s', this.serial, 'shell',
      'CLASSPATH=/data/local/tmp/scrcpy-server.jar',
      'app_process', '/', 'com.genymobile.scrcpy.Server',
      '4.1',
      `scid=${this.scid.toString(16).padStart(8, '0')}`,
      'log_level=info',
      `video_codec=${o.codec}`,
      `audio=${o.audio}`,
      'send_dummy_byte=true'
    ]
    if (o.bitRate) args.push(`video_bit_rate=${o.bitRate}`)
    if (o.maxFps) args.push(`max_fps=${o.maxFps}`)
    if (o.maxSize) args.push(`max_size=${o.maxSize}`)
    if (o.videoEncoder) args.push(`video_encoder=${o.videoEncoder}`)
    // 音频参数只在开启时下发。audio_source=output 会让服务端把设备端外放静音，
    // 这是 scrcpy 的既定语义（不是 bug），设置页已有说明。
    if (o.audio) {
      args.push(`audio_codec=${o.audioCodec}`)
      args.push(`audio_source=${o.audioSource}`)
      if (o.audioBitRate) args.push(`audio_bit_rate=${o.audioBitRate}`)
    }
    if (!o.control) args.push('control=false')
    if (o.stayAwake) args.push('stay_awake=true')
    if (o.showTouches) args.push('show_touches=true')
    if (o.powerOffOnClose) args.push('power_off_on_close=true')
    if (!o.clipboardAutosync) args.push('clipboard_autosync=false')
    args.push('tunnel_forward=true')
    return args
  }

  /** Connect the video socket; read 1 dummy byte to confirm the server is listening. Returns the paused socket. */
  private async connectVideo(): Promise<Socket> {
    let lastErr: Error | null = null
    for (let i = 0; i < 100; i++) {
      if (this.disposed) throw new Error('已停止')
      const socket = net.connect(this.localPort, '127.0.0.1')
      try {
        await this.readBytes(socket, 1, 4000)
        socket.pause()
        return socket
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err))
        socket.destroy()
        await sleep(100)
      }
    }
    throw new Error('连接 scrcpy-server 超时：' + (lastErr?.message ?? '设备端未响应'))
  }

  /**
   * Connect the audio socket.
   * 与 video 不同，这里**不能**读 dummy byte —— 服务端只给第一路（video）写。
   * 与 control 一样，靠 TCP 'connect' 事件确认即可。
   */
  private async connectAudio(): Promise<Socket> {
    let lastErr: Error | null = null
    for (let i = 0; i < 20; i++) {
      if (this.disposed) throw new Error('已停止')
      const socket = net.connect(this.localPort, '127.0.0.1')
      try {
        await new Promise<void>((resolve, reject) => {
          socket.once('connect', () => resolve())
          socket.once('error', (e: Error) => reject(e))
        })
        socket.pause()
        return socket
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err))
        socket.destroy()
        await sleep(100)
      }
    }
    throw new Error('连接音频通道失败：' + (lastErr?.message ?? ''))
  }

  /** Read the 64-byte device name (server writes it after every enabled socket is accepted). */
  private async readDeviceName(socket: Socket): Promise<string> {
    const bytes = await this.readBytes(socket, DEVICE_NAME_LENGTH, 4000)
    return bytes.toString('utf8').replace(/\0+$/, '')
  }

  private async connectControl(): Promise<Socket> {
    let lastErr: Error | null = null
    for (let i = 0; i < 20; i++) {
      if (this.disposed) throw new Error('已停止')
      const socket = net.connect(this.localPort, '127.0.0.1')
      try {
        await new Promise<void>((resolve, reject) => {
          socket.once('connect', () => resolve())
          socket.once('error', (e: Error) => reject(e))
        })
        socket.pause()
        return socket
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err))
        socket.destroy()
        await sleep(100)
      }
    }
    throw new Error('连接控制通道失败：' + (lastErr?.message ?? ''))
  }

  /** Read exactly n bytes from a paused socket using the readable event. */
  private readBytes(socket: Socket, n: number, timeoutMs: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let received = 0
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('读取超时'))
      }, timeoutMs)

      const onReadable = (): void => {
        while (received < n) {
          const need = n - received
          const chunk = socket.read(need) as Buffer | null
          if (!chunk) break
          received += chunk.length
          chunks.push(chunk)
          if (received >= n) {
            cleanup()
            resolve(Buffer.concat(chunks).subarray(0, n))
            return
          }
        }
      }
      const onError = (): void => {
        cleanup()
        reject(new Error('socket 错误'))
      }
      const onClose = (): void => {
        cleanup()
        reject(new Error('socket 关闭'))
      }
      const cleanup = (): void => {
        clearTimeout(timer)
        socket.removeListener('readable', onReadable)
        socket.removeListener('error', onError)
        socket.removeListener('close', onClose)
      }

      socket.on('readable', onReadable)
      socket.once('error', onError)
      socket.once('close', onClose)
    })
  }

  private handleVideoData(chunk: Buffer | string): void {
    if (this.disposed) return
    const buf: Buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    this.bytesReceived += buf.length
    this.buffer = this.buffer.length === 0 ? buf : Buffer.concat([this.buffer, buf])
    this.processBuffer()
  }

  private processBuffer(): void {
    let offset = 0
    const buf = this.buffer
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (this.phase === 'codec') {
        if (buf.length - offset < 4) break
        const codecId = buf.readUInt32BE(offset)
        offset += 4
        if (codecId === 0) {
          this.cbs.onError(this.sessionId, '设备端视频流被禁用')
          this.disposed = true
          break
        }
        if (codecId === 1) {
          this.cbs.onError(this.sessionId, '设备端视频流配置错误')
          this.disposed = true
          break
        }
        this.codec = codecIdToString(codecId)
        this.phase = 'session'
        continue
      }

      if (this.phase === 'session') {
        if (buf.length - offset < 12) break
        const first = buf[offset]
        if (!(first & 0x80)) {
          this.cbs.onError(this.sessionId, '协议错误：期望 session 头')
          this.disposed = true
          break
        }
        const width = buf.readUInt32BE(offset + 4)
        const height = buf.readUInt32BE(offset + 8)
        offset += 12
        this.applyVideoSize(width, height)
        this.phase = 'frame-header'
        continue
      }

      if (this.phase === 'frame-header') {
        if (buf.length - offset < 12) break
        const first = buf[offset]
        if (first & 0x80) {
          const width = buf.readUInt32BE(offset + 4)
          const height = buf.readUInt32BE(offset + 8)
          offset += 12
          this.applyVideoSize(width, height)
          continue
        }
        const ptsFlags = buf.readBigUInt64BE(offset)
        const size = buf.readUInt32BE(offset + 8)
        if (size <= 0) {
          this.cbs.onError(this.sessionId, '协议错误：无效帧长度')
          this.disposed = true
          break
        }
        const isConfig = (ptsFlags & PACKET_FLAG_CONFIG) !== 0n
        const isKey = (ptsFlags & PACKET_FLAG_KEY_FRAME) !== 0n
        const pts = Number(ptsFlags & PTS_MASK)
        offset += 12
        if (buf.length - offset < size) {
          this.pendingFrame = { size, isConfig, isKey, pts }
          this.phase = 'frame-payload'
          break
        }
        const data = buf.subarray(offset, offset + size)
        offset += size
        this.emitFrame(new Uint8Array(data), pts, isKey, isConfig)
        continue
      }

      if (this.phase === 'frame-payload') {
        const p = this.pendingFrame
        if (!p) {
          this.phase = 'frame-header'
          continue
        }
        if (buf.length - offset < p.size) break
        const data = buf.subarray(offset, offset + p.size)
        offset += p.size
        this.emitFrame(new Uint8Array(data), p.pts, p.isKey, p.isConfig)
        this.pendingFrame = null
        this.phase = 'frame-header'
        continue
      }
    }
    this.buffer = offset === 0 ? buf : buf.subarray(offset)
  }

  /** 统一帧出口：累计帧数/pts 用于采样帧率，再转发给上层。 */
  private emitFrame(data: Uint8Array, pts: number, isKey: boolean, isConfig: boolean): void {
    if (!isConfig) {
      if (this.statFrames === 0) this.statPtsStart = pts
      this.statPtsEnd = pts
      this.statFrames++
    }
    this.cbs.onFrame(this.sessionId, data, pts, isKey, isConfig)
  }

  private applyVideoSize(width: number, height: number): void {
    if (width === this.videoSize.width && height === this.videoSize.height) return
    this.videoSize = { width, height }
    this.cbs.onStreamMeta({ sessionId: this.sessionId, codec: this.codec as StreamMeta['codec'], width, height })
  }

  // ---- 音频流 ----
  // 线上格式： [4B codecId][包...]，每个包 = 12B 帧头（8B ptsAndFlags + 4B size）+ 负载。
  // 与视频**唯一的区别**是音频没有 12B 的 session meta（那东西带分辨率，音频不需要）。

  private handleAudioData(chunk: Buffer | string): void {
    if (this.disposed || !this.audioEnabled) return
    const buf: Buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    this.audioBytesReceived += buf.length
    this.audioBuffer = this.audioBuffer.length === 0 ? buf : Buffer.concat([this.audioBuffer, buf])
    this.processAudioBuffer()
  }

  private processAudioBuffer(): void {
    let offset = 0
    const buf = this.audioBuffer
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (this.audioPhase === 'codec') {
        if (buf.length - offset < 4) break
        const codecId = buf.readUInt32BE(offset)
        offset += 4
        // 服务端 writeDisableStream()：0 = 主动禁用（如 Android < 11 或采集失败），
        // 1 = 配置错误。两者都只影响音频——视频继续，不拆会话。
        if (codecId === 0) {
          this.disableAudio('设备端未开启音频（Android 11 以下或采集被占用）')
          break
        }
        if (codecId === 1) {
          this.disableAudio('设备端音频配置错误')
          break
        }
        const codec = AUDIO_CODEC_IDS[codecId]
        if (!codec) {
          this.disableAudio(`未知音频编码 id=0x${codecId.toString(16)}`)
          break
        }
        this.audioCodec = codec
        this.audioPhase = 'frame-header'
        this.cbs.onAudioMeta({
          sessionId: this.sessionId,
          codec,
          sampleRate: AUDIO_SAMPLE_RATE,
          channels: AUDIO_CHANNELS
        })
        continue
      }

      if (this.audioPhase === 'frame-header') {
        if (buf.length - offset < 12) break
        const ptsFlags = buf.readBigUInt64BE(offset)
        const size = buf.readUInt32BE(offset + 8)
        if (size <= 0) {
          // 音频流里出现非法长度，说明已经不同步了，直接放弃音频（不影响视频）
          this.disableAudio('音频流解析错误：无效包长度')
          break
        }
        const isConfig = (ptsFlags & PACKET_FLAG_CONFIG) !== 0n
        const pts = Number(ptsFlags & PTS_MASK)
        offset += 12
        if (buf.length - offset < size) {
          this.audioPending = { size, isConfig, pts }
          this.audioPhase = 'frame-payload'
          break
        }
        const data = buf.subarray(offset, offset + size)
        offset += size
        this.cbs.onAudioFrame(this.sessionId, new Uint8Array(data), pts, isConfig)
        continue
      }

      if (this.audioPhase === 'frame-payload') {
        const p = this.audioPending
        if (!p) {
          this.audioPhase = 'frame-header'
          continue
        }
        if (buf.length - offset < p.size) break
        const data = buf.subarray(offset, offset + p.size)
        offset += p.size
        this.cbs.onAudioFrame(this.sessionId, new Uint8Array(data), p.pts, p.isConfig)
        this.audioPending = null
        this.audioPhase = 'frame-header'
        continue
      }
    }
    this.audioBuffer = offset === 0 ? buf : buf.subarray(offset)
  }

  /** 关闭音频（只影响声音，视频与控制在跑就继续跑）。重复调用安全。 */
  private disableAudio(reason: string): void {
    if (!this.audioEnabled) return
    this.audioEnabled = false
    this.audioBuffer = Buffer.alloc(0)
    this.audioPending = null
    if (this.audioSocket) {
      try {
        this.audioSocket.destroy()
      } catch {
        /* ignore */
      }
      this.audioSocket = null
    }
    this.cbs.onAudioDisabled(this.sessionId, reason)
  }

  private handleControlData(chunk: Buffer | string): void {
    const buf: Buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    let offset = 0
    while (offset < buf.length) {
      const type = buf[offset]
      if (type === 0) {
        if (buf.length - offset < 5) break
        const len = buf.readUInt32BE(offset + 1)
        if (buf.length - offset < 5 + len) break
        const text = buf.subarray(offset + 5, offset + 5 + len).toString('utf8')
        this.cbs.onClipboard(this.sessionId, text)
        offset += 5 + len
      } else if (type === 1) {
        if (buf.length - offset < 9) break
        offset += 9
      } else {
        break
      }
    }
  }

  private handleDisconnect(): void {
    if (this.disposed) return
    this.disposed = true
    this.cbs.onStopped(this.sessionId)
    void this.stop()
  }

  sendControl(cmd: ControlCommand): void {
    if (!this.controlSocket || this.controlSocket.destroyed || this.disposed) return
    try {
      this.controlSocket.write(encodeControlCommand(cmd))
    } catch {
      // ignore; disconnect handler cleans up
    }
  }

  /** 返回当前统计窗口的累计值（bytes 累计不 reset；frames/pts 采样后 reset）。 */
  getStats(): { bytes: number; frames: number; ptsStart: number; ptsEnd: number } {
    return { bytes: this.bytesReceived, frames: this.statFrames, ptsStart: this.statPtsStart, ptsEnd: this.statPtsEnd }
  }

  /** 清空帧统计窗口（每采样周期调用一次）。 */
  resetStats(): void {
    this.statFrames = 0
    this.statPtsStart = 0
    this.statPtsEnd = 0
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.disposed = true

    for (const s of [this.videoSocket, this.audioSocket, this.controlSocket]) {
      if (s) {
        try {
          s.destroy()
        } catch {
          /* ignore */
        }
      }
    }
    this.videoSocket = null
    this.audioSocket = null
    this.controlSocket = null

    if (this.serverProc && !this.serverProc.killed) {
      try {
        this.serverProc.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }
    this.serverProc = null

    if (this.localPort) {
      await this.adb.removeForward(this.serial, this.localPort).catch(() => undefined)
    }
  }
}

function codecIdToString(id: number): string {
  switch (id) {
    case 0x68323634:
      return 'h264'
    case 0x68323635:
      return 'h265'
    case 0x00617631:
      return 'av1'
    case 0x00767038:
      return 'vp8'
    case 0x00767039:
      return 'vp9'
    default:
      return 'h264'
  }
}
