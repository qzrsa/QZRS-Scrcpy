import http from 'node:http'
import crypto from 'node:crypto'
import { resolveKeycode } from './scriptengine'
import type { ControlCommand } from '@shared/types'

/**
 * Python 外挂桥：一个只监听 127.0.0.1 的小型 HTTP 服务，
 * 让外部 Python 脚本（标准库 urllib 即可，零 pip 依赖）控制**当前投屏会话**。
 *
 * 设计与 ScriptEngine 同构：宿主注入 hooks（列会话 / 发控制指令 / 截屏），
 * 桥自己不碰 adb、不碰 ScrcpySession —— 设备操作全部复用与手动控制、
 * JS 脚本同一条 sendControl 链路（scrcpy 控制协议，<10ms 注入延迟）。
 *
 * 鉴权：Bearer Token（应用每次启动随机生成，设置面板可见）。
 * 坐标约定与 JS 引擎一致：视频像素坐标，桥按会话当前视频宽高换成协议参数。
 *
 * 端点（均为 JSON；错误返回 { "error": "..." } + 对应状态码）：
 * - GET  /api/v1/info                    会话列表（含 sessionId / serial / 视频宽高）
 * - POST /api/v1/tap                     { x, y, durationMs?, sessionId? }
 * - POST /api/v1/swipe                   { x1, y1, x2, y2, durationMs?, sessionId? }
 * - POST /api/v1/key                     { key, durationMs?, metastate?, sessionId? }
 * - POST /api/v1/text                    { text, sessionId? }
 * - POST /api/v1/touchdown              { finger?(0~9), x, y, sessionId? }   多指原语：按下，立即返回
 * - POST /api/v1/touchmove              { finger, x, y, sessionId? }         多指原语：拖动（须先 touchdown）
 * - POST /api/v1/touchup                { finger|'all', sessionId? }         多指原语：抬起（幂等；all 一次全抬）
 * - GET  /api/v1/screenshot?sessionId=   返回 PNG 二进制（adb screencap，设备原始分辨率）
 * - GET  /api/v1/frame?sessionId=        返回 PNG 二进制（投屏视频分辨率最近一帧，~10ms 级）
 *
 * screenshot 与 frame 的语义差异（模板/比色必须与所用通道同源）：
 * - screenshot = adb screencap，设备原始分辨率，300~500ms/次，适合采集模板/低频大图；
 * - frame      = 投屏视频流最近一帧（渲染层 canvas 直出），快一个量级，适合高频比色/OCR。
 * 两条通道独立（adb 隧道 vs 内存复制），互不影响；frame 需该会话的 MirrorView 已挂载。
 *
 * 多指原语与 tap/swipe 的本质区别：**tap/swipe 手势完成才返回**（防同 pointerId 交错）；
 * **touchdown/move/up 立即返回**，时序由 Python 侧控制 —— 因此"手指要抬起来"的铁律落在
 * 调用方头上，桥做两层兜底：touchup 幂等 + 会话消失时清理跟踪（控制 socket 已死，无需补发）。
 * finger 编号 0~9 = Android 触摸屏触点上限（协议层 pointerId 是 u64，这里主动收口防滥用）。
 *
 * sessionId 省略时：恰好一个会话就用它；零个或多个都要显式指定（避免误控）。
 */

/** 带 HTTP 状态码的业务错误（路由层统一转成 JSON 响应） */
export class BridgeHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'BridgeHttpError'
  }
}

export interface BridgeSessionInfo {
  sessionId: string
  serial: string
  /** 当前视频宽高；<=0 表示视频流尚未就绪 */
  width: number
  height: number
}

export interface PythonBridgeHooks {
  appVersion(): string
  listSessions(): BridgeSessionInfo[]
  sendControl(sessionId: string, cmd: ControlCommand): void
  /** adb screencap（设备原始分辨率 PNG，含多屏告警前缀清洗） */
  screenshot(serial: string): Promise<Buffer>
  /** 投屏视频流最近一帧（视频分辨率 PNG；由渲染层 MirrorView 提供该会话的帧） */
  frame(sessionId: string): Promise<{ png: Buffer; width: number; height: number }>
}

/** 与 ScriptEngine 一致的 swipe MOVE 插值步长（ms/步） */
const SWIPE_STEP_MS = 16
/** 请求体上限（JSON 都很小，1MB 纯属防呆） */
const MAX_BODY_BYTES = 1024 * 1024
/** tap 默认按住时长（与 JS 引擎 tapImpl 相同） */
const TAP_DEFAULT_MS = 60
/** key 默认按住时长（与 JS 引擎 keyImpl 相同） */
const KEY_DEFAULT_MS = 30

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)))

export class PythonBridge {
  private server: http.Server | null = null
  private token = ''
  private port = 0
  /** 多指跟踪：sessionId -> (finger -> 最后按下的坐标)；供 touchup 取坐标 + 会话消失时清理 */
  private activePointers = new Map<string, Map<number, { x: number; y: number }>>()

  constructor(private readonly hooks: PythonBridgeHooks) {}

  get running(): boolean {
    return this.server !== null
  }

  /** 当前状态（设置面板展示用）；未运行时 token 为空串 */
  info(): { running: boolean; port: number; token: string } {
    return { running: this.running, port: this.port, token: this.running ? this.token : '' }
  }

  /** 启动（已运行则先停再按新端口起）。Token 保持本次应用运行期间稳定。 */
  async start(port: number): Promise<void> {
    await this.stop()
    const p = Math.trunc(port)
    if (!Number.isFinite(p) || p < 1024 || p > 65535) {
      throw new BridgeHttpError(400, `端口越界：${port}（允许 1024~65535）`)
    }
    if (!this.token) {
      this.token = crypto.randomBytes(24).toString('base64url')
    }
    const server = http.createServer((req, res) => {
      void this.handle(req, res)
    })
    // keep-alive 超时收紧：脚本端异常退出不至于占着连接
    server.keepAliveTimeout = 5000
    await new Promise<void>((resolve, reject) => {
      const onErr = (err: Error): void => reject(err)
      server.once('error', onErr)
      server.listen(p, '127.0.0.1', () => {
        server.off('error', onErr)
        resolve()
      })
    })
    this.server = server
    this.port = p
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = null
    this.port = 0
    this.activePointers.clear()
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      // 挂着的 keep-alive 连接不等了（close 回调要等所有连接断开才触发）
      server.closeAllConnections?.()
    })
  }

  // ---- request handling ----

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown): void => {
      if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }
    try {
      this.auth(req)
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname.replace(/\/+$/, '') || '/'
      if (req.method === 'GET' && path === '/api/v1/info') {
        reply(200, { app: 'qzrs-scrcpy', version: this.hooks.appVersion(), sessions: this.hooks.listSessions() })
        return
      }
      if (req.method === 'GET' && path === '/api/v1/screenshot') {
        const png = await this.screenshot(url.searchParams.get('sessionId'))
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length })
        res.end(png)
        return
      }
      if (req.method === 'GET' && path === '/api/v1/frame') {
        const f = await this.frame(url.searchParams.get('sessionId'))
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': f.png.length,
          'X-Frame-Width': String(f.width),
          'X-Frame-Height': String(f.height)
        })
        res.end(f.png)
        return
      }
      if (req.method === 'POST') {
        const body = await this.readJson(req)
        switch (path) {
          case '/api/v1/tap':
            reply(200, await this.tap(body))
            return
          case '/api/v1/swipe':
            reply(200, await this.swipe(body))
            return
          case '/api/v1/key':
            reply(200, await this.key(body))
            return
          case '/api/v1/text':
            reply(200, this.text(body))
            return
          case '/api/v1/touchdown':
            reply(200, this.touchdown(body))
            return
          case '/api/v1/touchmove':
            reply(200, this.touchmove(body))
            return
          case '/api/v1/touchup':
            reply(200, this.touchup(body))
            return
          default:
            throw new BridgeHttpError(404, `未知端点：POST ${path}`)
        }
      }
      throw new BridgeHttpError(404, `未知端点：${req.method} ${path}`)
    } catch (err) {
      if (err instanceof BridgeHttpError) {
        reply(err.status, { error: err.message })
        return
      }
      reply(500, { error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** Bearer Token 校验（恒定时间比较，防时序侧信道——本地端口也照做，习惯成自然） */
  private auth(req: http.IncomingMessage): void {
    const header = String(req.headers['authorization'] ?? '')
    const m = /^Bearer\s+(.+)$/i.exec(header.trim())
    const given = m?.[1] ?? ''
    const ok =
      given.length === this.token.length &&
      crypto.timingSafeEqual(Buffer.from(given), Buffer.from(this.token))
    if (!ok) throw new BridgeHttpError(401, '鉴权失败：缺少或错误的 Authorization: Bearer <token>')
  }

  private readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', (c: Buffer) => {
        size += c.length
        if (size > MAX_BODY_BYTES) {
          reject(new BridgeHttpError(413, '请求体过大'))
          req.destroy()
          return
        }
        chunks.push(c)
      })
      req.on('end', () => {
        if (chunks.length === 0) return resolve({})
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            reject(new BridgeHttpError(400, '请求体必须是 JSON 对象'))
            return
          }
          resolve(parsed as Record<string, unknown>)
        } catch {
          reject(new BridgeHttpError(400, '请求体不是合法 JSON'))
        }
      })
      req.on('error', () => reject(new BridgeHttpError(400, '请求读取失败')))
    })
  }

  /** 解析目标会话：显式 sessionId 必须存在；省略时仅允许恰好一个会话 */
  private resolve(sessionIdRaw: unknown): BridgeSessionInfo {
    const sessions = this.hooks.listSessions()
    const want = String(sessionIdRaw ?? '').trim()
    if (want) {
      const s = sessions.find((x) => x.sessionId === want)
      if (!s) throw new BridgeHttpError(404, `会话不存在：${want}`)
      return s
    }
    if (sessions.length === 0) throw new BridgeHttpError(409, '当前没有投屏会话，请先连接设备')
    if (sessions.length > 1) {
      throw new BridgeHttpError(
        409,
        `当前有 ${sessions.length} 个投屏会话，请在请求里指定 sessionId：${sessions.map((s) => s.sessionId).join(', ')}`
      )
    }
    return sessions[0]
  }

  /** 视频尺寸就绪检查（与 JS 引擎 size() 同语义） */
  private static videoSize(s: BridgeSessionInfo): { width: number; height: number } {
    if (s.width <= 0 || s.height <= 0) {
      throw new BridgeHttpError(409, `视频流尚未就绪（会话 ${s.sessionId} 宽高未知），请稍后重试`)
    }
    return { width: s.width, height: s.height }
  }

  private num(v: unknown, what: string): number {
    const n = Number(v)
    if (!Number.isFinite(n)) throw new BridgeHttpError(400, `${what} 不是数字：${v}`)
    return n
  }

  private touch(action: 0 | 1 | 2, x: number, y: number, pressure: number, width: number, height: number, sessionId: string): void {
    this.rawTouch('finger', action, x, y, pressure, width, height, sessionId)
  }

  /** 通用触摸注入：pointerId 数字 = 多指原语的 finger 编号；'finger' = tap/swipe 的通用虚拟手指 */
  private rawTouch(pointerId: number | 'finger', action: 0 | 1 | 2, x: number, y: number, pressure: number, width: number, height: number, sessionId: string): void {
    this.hooks.sendControl(sessionId, {
      type: 'touch',
      action,
      pointerId,
      x: Math.max(0, Math.round(x)),
      y: Math.max(0, Math.round(y)),
      width,
      height,
      pressure,
      buttons: 0
    })
  }

  // ---- 多指原语（finger 0~9；tap/swipe 的 'finger' 虚拟手指与数字编号互不冲突）----

  /** 清理已消失会话的跟踪条目（会话死了控制 socket 随之关闭，无需补发 UP） */
  private pruneActivePointers(): void {
    const ids = new Set(this.hooks.listSessions().map((s) => s.sessionId))
    for (const k of this.activePointers.keys()) {
      if (!ids.has(k)) this.activePointers.delete(k)
    }
  }

  private static finger(v: unknown): number {
    const n = Number(v)
    if (!Number.isInteger(n) || n < 0 || n > 9) {
      throw new BridgeHttpError(400, `finger 必须是 0~9 的整数：${String(v)}`)
    }
    return n
  }

  private activeFor(sessionId: string): Map<number, { x: number; y: number }> {
    let m = this.activePointers.get(sessionId)
    if (!m) {
      m = new Map()
      this.activePointers.set(sessionId, m)
    }
    return m
  }

  private touchdown(body: Record<string, unknown>): Record<string, unknown> {
    this.pruneActivePointers()
    const s = this.resolve(body['sessionId'])
    const { width, height } = PythonBridge.videoSize(s)
    const finger = PythonBridge.finger(body['finger'] ?? 0)
    const x = this.num(body['x'], 'x')
    const y = this.num(body['y'], 'y')
    const m = this.activeFor(s.sessionId)
    if (m.has(finger)) {
      throw new BridgeHttpError(409, `finger ${finger} 已按下（先 touchup 再 touchdown）`)
    }
    this.rawTouch(finger, 0, x, y, 1, width, height, s.sessionId)
    m.set(finger, { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) })
    return { ok: true, action: 'touchdown', sessionId: s.sessionId, finger, x: Math.round(x), y: Math.round(y), activeFingers: [...m.keys()] }
  }

  private touchmove(body: Record<string, unknown>): Record<string, unknown> {
    this.pruneActivePointers()
    const s = this.resolve(body['sessionId'])
    const { width, height } = PythonBridge.videoSize(s)
    const finger = PythonBridge.finger(body['finger'] ?? 0)
    const x = this.num(body['x'], 'x')
    const y = this.num(body['y'], 'y')
    const m = this.activePointers.get(s.sessionId)
    if (!m || !m.has(finger)) {
      throw new BridgeHttpError(409, `finger ${finger} 尚未按下（先 touchdown）`)
    }
    this.rawTouch(finger, 2, x, y, 1, width, height, s.sessionId)
    m.set(finger, { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) })
    return { ok: true, action: 'touchmove', sessionId: s.sessionId, finger, x: Math.round(x), y: Math.round(y), activeFingers: [...m.keys()] }
  }

  /** 幂等：抬未按下的手指返回 released:[]（方便 Python finally 里无脑 touchup） */
  private touchup(body: Record<string, unknown>): Record<string, unknown> {
    this.pruneActivePointers()
    const s = this.resolve(body['sessionId'])
    const { width, height } = PythonBridge.videoSize(s)
    const m = this.activePointers.get(s.sessionId)
    const isAll = body['finger'] === 'all' || body['all'] === true
    const targets = isAll ? [...(m?.keys() ?? [])] : [PythonBridge.finger(body['finger'] ?? 0)]
    const released: number[] = []
    for (const f of targets) {
      const p = m?.get(f)
      if (!p) continue
      this.rawTouch(f, 1, p.x, p.y, 0, width, height, s.sessionId)
      m!.delete(f)
      released.push(f)
    }
    if (m && m.size === 0) this.activePointers.delete(s.sessionId)
    return { ok: true, action: 'touchup', sessionId: s.sessionId, released, activeFingers: m ? [...m.keys()] : [] }
  }

  /**
   * tap / swipe 都是**手势完成后才返回**：Python 侧顺序调用天然串行，
   * 不会出现两次手势（同一个 pointerId）交错把滑动点乱的问题。
   */
  private async tap(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const s = this.resolve(body['sessionId'])
    const { width, height } = PythonBridge.videoSize(s)
    const x = this.num(body['x'], 'x')
    const y = this.num(body['y'], 'y')
    const dur = Math.min(60_000, Math.max(0, body['durationMs'] === undefined ? TAP_DEFAULT_MS : this.num(body['durationMs'], 'durationMs')))
    this.touch(0, x, y, 1, width, height, s.sessionId) // DOWN
    await sleep(dur)
    // UP 无条件发出（与 JS 引擎同一条铁律：手指永远要抬起来）
    this.touch(1, x, y, 0, width, height, s.sessionId)
    return { ok: true, action: 'tap', sessionId: s.sessionId, x: Math.round(x), y: Math.round(y), durationMs: dur }
  }

  private async swipe(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const s = this.resolve(body['sessionId'])
    const { width, height } = PythonBridge.videoSize(s)
    const ax = this.num(body['x1'], 'x1')
    const ay = this.num(body['y1'], 'y1')
    const bx = this.num(body['x2'], 'x2')
    const by = this.num(body['y2'], 'y2')
    const dur = Math.min(60_000, Math.max(30, body['durationMs'] === undefined ? 300 : this.num(body['durationMs'], 'durationMs')))
    const steps = Math.max(2, Math.round(dur / SWIPE_STEP_MS))
    this.touch(0, ax, ay, 1, width, height, s.sessionId) // DOWN
    for (let i = 1; i < steps; i++) {
      await sleep(dur / steps)
      this.touch(2, ax + ((bx - ax) * i) / steps, ay + ((by - ay) * i) / steps, 1, width, height, s.sessionId) // MOVE
    }
    this.touch(1, bx, by, 0, width, height, s.sessionId) // UP
    return { ok: true, action: 'swipe', sessionId: s.sessionId, steps, durationMs: dur }
  }

  private async key(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const s = this.resolve(body['sessionId'])
    if (body['key'] === undefined) throw new BridgeHttpError(400, '缺少 key（如 "BACK"、"A" 或数字 keycode）')
    let keycode: number
    try {
      keycode = resolveKeycode(body['key'] as string | number)
    } catch (err) {
      throw new BridgeHttpError(400, err instanceof Error ? err.message : String(err))
    }
    const dur = Math.min(60_000, Math.max(0, body['durationMs'] === undefined ? KEY_DEFAULT_MS : this.num(body['durationMs'], 'durationMs')))
    const meta = Math.max(0, Math.min(0xffff, Math.trunc(body['metastate'] === undefined ? 0 : this.num(body['metastate'], 'metastate'))))
    this.hooks.sendControl(s.sessionId, { type: 'keycode', action: 0, keycode, repeat: 0, metastate: meta })
    if (dur > 0) await new Promise((r) => setTimeout(r, dur))
    this.hooks.sendControl(s.sessionId, { type: 'keycode', action: 1, keycode, repeat: 0, metastate: meta })
    return { ok: true, action: 'key', sessionId: s.sessionId, keycode, durationMs: dur }
  }

  private text(body: Record<string, unknown>): Record<string, unknown> {
    const s = this.resolve(body['sessionId'])
    const str = String(body['text'] ?? '')
    if (str.length === 0) throw new BridgeHttpError(400, 'text 不能为空')
    const bytes = Buffer.byteLength(str, 'utf8')
    if (bytes > 300) {
      throw new BridgeHttpError(
        400,
        `text 超长：当前 ${bytes} 字节 > 上限 300 字节（scrcpy INJECT_TEXT 限制，中文每字 3 字节），请拆成多次调用`
      )
    }
    this.hooks.sendControl(s.sessionId, { type: 'text', text: str })
    return { ok: true, action: 'text', sessionId: s.sessionId, bytes }
  }

  private async screenshot(sessionIdRaw: string | null): Promise<Buffer> {
    const s = this.resolve(sessionIdRaw)
    return this.hooks.screenshot(s.serial)
  }

  private async frame(sessionIdRaw: string | null): Promise<{ png: Buffer; width: number; height: number }> {
    const s = this.resolve(sessionIdRaw)
    try {
      return await this.hooks.frame(s.sessionId)
    } catch (err) {
      if (err instanceof BridgeHttpError) throw err
      // 语义固化：帧提供器缺位/异常（MirrorView 未挂载等）统一 503，与 hook 实现无关
      throw new BridgeHttpError(503, `取帧失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
