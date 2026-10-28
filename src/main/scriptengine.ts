import vm from 'node:vm'
import type { ControlCommand, ScriptInfo, ScriptRunEvent, WaitImageResult } from '@shared/types'
import type { OcrResult } from './ocr'

/**
 * 脚本执行引擎：把用户 JS 放进 node:vm 沙箱，以 async IIFE 运行。
 *
 * 沙箱只暴露一套设备操作 API（tap/swipe/text/key/wait/log），拿不到 process /
 * require / fs —— 想碰设备只能通过这些 API，每个 API 底层就是一个 ControlCommand
 * （复用 scrcpy 控制协议，与按键映射同一条链路）。
 *
 * 坐标约定：脚本里的 (x, y) 是视频像素坐标（与调试浮层一致），引擎运行时按
 * 会话当前视频宽高换算成 scrcpy 要的归一化参数（协议本身要求传 width/height）。
 *
 * 每个运行（run）独立；同一脚本可对多个会话并发运行，运行之间没有共享状态。
 * 停止 = 置 stop 标志 + 唤醒所有挂起的 wait；下一个 API 调用点抛出 StoppedError
 * 结束整个脚本，已发出的触摸指令不回滚（手指不会卡住：tap 类操作 DOWN/UP 成对，
 * 停止只可能发生在两步之间，UP 永远会发出后才检查停止标志）。
 */

/** 停止标志专用错误；用户代码抓不到它（沙箱 API 层统一转成 'stopped' 事件） */
class ScriptStoppedError extends Error {
  constructor() {
    super('脚本已停止')
    this.name = 'ScriptStoppedError'
  }
}

class ScriptApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScriptApiError'
  }
}

export interface ScriptEngineHooks {
  sendControl(sessionId: string, cmd: ControlCommand): void
  /** 会话当前视频尺寸；null = 会话不存在或视频流还没就绪 */
  getVideoSize(sessionId: string): { width: number; height: number } | null
  isSessionAlive(sessionId: string): boolean
  onEvent(evt: ScriptRunEvent): void
  /**
   * waitImage 用：对指定会话的设备截屏并找命名模板。
   * 返回坐标 = 匹配中心在**设备截屏坐标系**里的位置（引擎负责换算到视频坐标）。
   * null = 模板不存在；found=false = 本轮没找到。
   */
  findTemplate(
    sessionId: string,
    name: string,
    threshold: number
  ): Promise<{ found: boolean; x: number; y: number; score: number; screenW: number; screenH: number } | null>
  /**
   * getPixelColor 用：读「视频像素坐标」处的颜色（ipc 负责截屏 + 坐标换算）。
   * null = 会话不存在 / 截屏失败。
   */
  getPixelColor(sessionId: string, videoX: number, videoY: number): Promise<{ r: number; g: number; b: number; hex: string } | null>
  /**
   * findColor 用：在「视频坐标系的 region」（null = 全屏）里找第一个容差内命中。
   * 返回命中点视频坐标；null = 会话不存在 / 截屏失败；{found:false} 由引擎按无命中处理。
   */
  findColor(
    sessionId: string,
    rgb: { r: number; g: number; b: number },
    tolerance: number,
    region: { x: number; y: number; w: number; h: number } | null
  ): Promise<{ found: boolean; x: number; y: number } | null>
  /**
   * ocrText 用：对指定区域（视频坐标，null = 全屏）做 OCR 文字识别。
   * 返回 lines 的 box 是**视频坐标**（引擎已换算好，脚本可直接 tap）。
   * null = 会话不存在 / 截屏失败 / 模型未就绪。
   */
  ocrText(sessionId: string, region: { x: number; y: number; w: number; h: number } | null): Promise<OcrResult | null>
}

/** 常用 Android keycode 名称表（脚本里 key('BACK') 之类用） */
const KEYCODE_NAMES: Record<string, number> = {
  HOME: 3,
  BACK: 4,
  CALL: 5,
  ENDCALL: 6,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  POWER: 26,
  MENU: 82,
  APP_SWITCH: 187,
  ENTER: 66,
  DEL: 67,
  SPACE: 62,
  TAB: 61,
  ESC: 111,
  UP: 19,
  DOWN: 20,
  LEFT: 21,
  RIGHT: 22,
  SEARCH: 84,
  CAMERA: 27,
  FOCUS: 80,
  HEADSETHOOK: 79,
  MUTE: 91,
  PAGE_UP: 92,
  PAGE_DOWN: 93
}
// 字母 A-Z（KEYCODE_A=29 起连续）与数字 0-9（KEYCODE_0=7 起连续），支持 key('A') / key('5')
for (let i = 0; i < 26; i++) KEYCODE_NAMES[String.fromCharCode(65 + i)] = 29 + i
for (let i = 0; i <= 9; i++) KEYCODE_NAMES[String(i)] = 7 + i

/** 解析 key() 参数：数字直接用；'BACK' 这类名称查表；未知名报错 */
export function resolveKeycode(name: string | number): number {
  if (typeof name === 'number' && Number.isFinite(name)) {
    const k = Math.trunc(name)
    if (k < 0 || k > 0xffff) throw new ScriptApiError(`keycode 越界：${k}`)
    return k
  }
  const s = String(name).trim().toUpperCase()
  const code = KEYCODE_NAMES[s]
  if (code === undefined) {
    throw new ScriptApiError(`未知按键名 "${name}"；可用：${Object.keys(KEYCODE_NAMES).join(', ')} 或直接写数字 keycode`)
  }
  return code
}

interface RunState {
  runId: string
  scriptId: string
  name: string
  sessionId: string
  stopped: boolean
  /** >0 = 整段脚本循环跑，每轮结束后等这么多毫秒（录制宏的"每隔 N 秒执行一次"） */
  loopMs: number
  /** >0 = 循环跑满 N 轮后自动结束（0 = 不限，跑到点「停止」为止） */
  maxRounds: number
  /** 挂起的定时器（stop 时提前唤醒） */
  timers: Set<NodeJS.Timeout>
  /** 等待被唤醒的 stop 检查点（stop 时立即触发） */
  wake: Set<() => void>
  /**
   * 当前按着的手指（touchDown 之后、touchUp 之前）。
   * 脚本结束/报错/被停止时必须由引擎负责抬起，否则设备上会留下一根"死死按住"的手指。
   */
  finger: { x: number; y: number } | null
}

/** `run()` 的可选参数 */
export interface RunOptions {
  /**
   * 循环间隔（ms）。>0 时把用户代码包进 `while (true) { ... await 间隔 }`，
   * 直到点「停止」。上限一天，避免手滑写成天文数字。
   */
  loopMs?: number
  /**
   * 循环限次：loopMs>0 时生效，跑满 maxRounds 轮后自动结束（0 = 不限）。
   * 不循环（loopMs=0）时本字段无意义——脚本天然只跑一遍。
   */
  maxRounds?: number
}

export interface RunningScript {
  runId: string
  scriptId: string
  name: string
  sessionId: string
}

const MAX_CODE_LENGTH = 100_000
/** swipe 的 MOVE 插值步长（ms/步）：~16ms 接近满帧率，协议不会丢中间点 */
const SWIPE_STEP_MS = 16
/** stick 按下之后隔多久才推方向（ms）：必须跨过一个输入帧，否则 DOWN/MOVE 会被合并 */
const STICK_SETTLE_MS = 40
/** stick 按住期间重发 MOVE 的心跳（ms）：与实时摇杆 setInterval(33) 一致 */
const STICK_TICK_MS = 33

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 墙钟 HH:mm:ss —— 循环日志里带上它，用户能直接对着表看 */
function clockOf(t: number): string {
  const d = new Date(t)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** 时长口语化：45 秒 / 50 分 / 1 小时 40 分；不足 1 秒直接给毫秒（循环下限 200ms） */
function durText(ms: number): string {
  const raw = Math.max(0, ms)
  if (raw < 1000) return `${Math.round(raw)} 毫秒`
  const total = Math.round(raw / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return m > 0 ? `${h} 小时 ${m} 分` : `${h} 小时`
  if (m > 0) return s > 0 ? `${m} 分 ${s} 秒` : `${m} 分`
  return `${s} 秒`
}

/** Omit 在联合类型上会塌缩成公共键，这里分发处理（每个成员各自 omit） */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type ScriptRunEventPartial = DistributiveOmit<ScriptRunEvent, 'runId' | 'scriptId' | 'name'>

/**
 * vm 沙箱里抛的异常属于沙箱自己的 realm，宿主侧 `instanceof Error` 恒为 false
 * （沙箱有独立的 Error 构造器）——只能按特征取 stack，不能依赖 instanceof。
 * 宿主 realm 抛的错（ScriptApiError / ScriptStoppedError）不受影响，仍可用 instanceof。
 */
function crossRealmStack(err: unknown): string {
  const s = (err as { stack?: unknown } | null | undefined)?.stack
  return typeof s === 'string' ? s : ''
}

function crossRealmMessage(err: unknown): string {
  const e = err as { name?: unknown; message?: unknown } | null | undefined
  if (e && typeof e === 'object' && typeof e.message === 'string' && e.message !== '') {
    const name = typeof e.name === 'string' && e.name !== '' ? e.name : 'Error'
    return `${name}: ${e.message}`
  }
  return String(err)
}

export class ScriptEngine {
  /**
   * 循环等待的切段长度（ms）。长等待必须切成小段：
   * 一次性 setTimeout(50 分钟) 在系统睡眠/休眠期间会被冻结，唤醒后还要把剩余时间
   * 走完，等于"到点不执行"；切段后每段都按**墙上时钟**重新算剩余，醒来即到点。
   * 顺带每段都能查一次 stop，长等待期点「停止」不会拖到下一轮。
   */
  static LOOP_SLICE_MS = 30_000
  /** 循环等待的心跳日志间隔（ms）：45 分钟一片安静的话，用户分不清"在等"和"已经死了" */
  static LOOP_BEAT_MS = 5 * 60_000

  private runs = new Map<string, RunState>()
  private seq = 0

  constructor(private hooks: ScriptEngineHooks) {}

  /** 正在运行的脚本列表 */
  running(): RunningScript[] {
    return [...this.runs.values()].map((r) => ({
      runId: r.runId,
      scriptId: r.scriptId,
      name: r.name,
      sessionId: r.sessionId
    }))
  }

  /** 某脚本是否正在运行（同脚本不允许并发跑两份，防止把自己点乱） */
  isScriptRunning(scriptId: string): boolean {
    for (const r of this.runs.values()) {
      if (r.scriptId === scriptId) return true
    }
    return false
  }

  /**
   * 启动脚本。代码在沙箱 async IIFE 里执行，顶层可 await。
   * 返回 runId；执行结果通过 onEvent 异步汇报（started/log/done/stopped/error）。
   */
  run(script: Pick<ScriptInfo, 'id' | 'name' | 'code'>, sessionId: string, opts?: RunOptions): { runId: string } {
    if (this.isScriptRunning(script.id)) {
      throw new Error(`脚本「${script.name}」正在运行中，请先停止`)
    }
    const code = String(script.code ?? '')
    if (code.length === 0) throw new Error('脚本内容为空')
    if (code.length > MAX_CODE_LENGTH) throw new Error(`脚本过长（>${MAX_CODE_LENGTH} 字符）`)
    if (!this.hooks.isSessionAlive(sessionId)) throw new Error('会话不存在或已断开，请先连接设备')

    // 下限 200ms：再短就不是"循环"而是死循环刷指令了（会把设备点乱）。
    const rawLoop = Number(opts?.loopMs ?? 0)
    const loopMs = Number.isFinite(rawLoop) && rawLoop > 0 ? Math.max(200, Math.min(86_400_000, Math.floor(rawLoop))) : 0
    // 循环限次：只在 loopMs>0 时有意义；夹到 [1, 100000]，0 = 不限
    const rawMax = Number(opts?.maxRounds ?? 0)
    const maxRounds =
      loopMs > 0 && Number.isFinite(rawMax) && rawMax > 0 ? Math.max(1, Math.min(100_000, Math.floor(rawMax))) : 0

    this.seq += 1
    const runId = `r${Date.now().toString(36)}${this.seq.toString(36)}`
    const st: RunState = {
      runId,
      scriptId: script.id,
      name: script.name,
      sessionId,
      stopped: false,
      loopMs,
      maxRounds,
      timers: new Set(),
      wake: new Set(),
      finger: null
    }
    this.runs.set(runId, st)
    this.emit(st, { state: 'started', sessionId })

    const started = Date.now()
    void this.execute(st, code)
      .then((outcome) => {
        if (outcome === 'stopped') this.emit(st, { state: 'stopped' })
        else if (typeof outcome === 'string') this.emit(st, { state: 'error', message: outcome })
        else if (outcome && typeof outcome === 'object') this.emit(st, { state: 'error', message: outcome.message, line: outcome.line })
        else this.emit(st, { state: 'done', elapsedMs: Date.now() - started })
      })
      .finally(() => {
        this.runs.delete(runId)
      })
    return { runId }
  }

  /** 停止一个运行：置标志 + 清挂起定时器 + 唤醒所有等待点 */
  stop(runId: string): void {
    const st = this.runs.get(runId)
    if (!st) return
    st.stopped = true
    for (const t of st.timers) clearTimeout(t)
    st.timers.clear()
    for (const wake of st.wake) wake()
    st.wake.clear()
  }

  stopAll(): void {
    for (const runId of [...this.runs.keys()]) this.stop(runId)
  }

  private emit(st: RunState, partial: ScriptRunEventPartial): void {
    const evt = { runId: st.runId, scriptId: st.scriptId, name: st.name, ...partial } as ScriptRunEvent
    try {
      this.hooks.onEvent(evt)
    } catch {
      /* 事件回调不能拖垮引擎 */
    }
  }

  /**
   * 仅落盘的 debug 级日志（stick 心跳等高频信息，不刷脚本面板）。
   * 排查「指令发了没生效 vs 压根没发」用：grep `[stick]` 看 ↓↑ 是否成对。
   */
  private emitDebug(st: RunState, line: string): void {
    this.emit(st, { state: 'log', line, debug: true })
  }

  /**
   * 从异常栈解析用户脚本行号。
   * 栈里用户帧形如 `at xxx.js:2:1`；外层包装在用户代码前加了若干行
   * （普通模式 1 行 `(async () => {`；循环模式再加 1 行 `while (true) {`），
   * 所以用户看到的行号 = 栈行号 - 包装行数。
   * 取**第一个**匹配（栈从内到外，第一个 .js 帧就是最内层的用户调用点）。
   */
  private parseErrorLine(stack: string, wrapperLines = 1): number | undefined {
    const m = /\.js:(\d+):\d+/.exec(stack)
    if (!m) return undefined
    const line = parseInt(m[1], 10) - wrapperLines
    return line >= 1 ? line : 1
  }

  /** 包装层在用户代码前插入的行数（循环模式多一行 while） */
  private static wrapperLines(st: RunState): number {
    return st.loopMs > 0 ? 2 : 1
  }

  /**
   * 执行主体。返回值语义：
   * undefined → 正常跑完；'stopped' → 被停止；string → 错误消息；
   * { message, line } → 带行号的错误。
   * 注意别用 'ok' 之类的字符串表示成功——它会被上层当成错误消息。
   */
  private async execute(st: RunState, code: string): Promise<'stopped' | undefined | string | { message: string; line?: number }> {
    const api = this.buildApi(st)
    const context = vm.createContext(api, { name: `qzrs-script-${st.runId}` })
    try {
      // 循环模式：整段用户代码当作循环体，每轮之间由 __qzrsLoopTick 等固定间隔。
      // 用 while(true) 而不是 for，是因为循环次数通常由用户点「停止」决定；
      // 设置了 maxRounds 时 __qzrsLoopTick 返回 true 触发 break，跑满 N 轮自动收尾。
      const body =
        st.loopMs > 0 ? `while (true) {\n${code}\nif (await __qzrsLoopTick(${st.loopMs})) break\n}` : code
      // 包一层 async IIFE：用户代码可以直接顶层 await（vm.Script 本身不支持 TLA）
      const wrapped = new vm.Script(`(async () => {\n${body}\n})()`, { filename: `${st.name}.js` })
      await wrapped.runInContext(context, { timeout: 5000 })
      return st.stopped ? 'stopped' : undefined
    } catch (err) {
      if (st.stopped) return 'stopped'
      const stack = crossRealmStack(err)
      const line = this.parseErrorLine(stack, ScriptEngine.wrapperLines(st))
      if (err instanceof ScriptApiError) return { message: err.message, line }
      return { message: `脚本异常 → ${crossRealmMessage(err)}`, line }
    } finally {
      // 手指没抬就结束（报错/停止/用户忘了 touchUp）→ 引擎兜底抬起
      this.liftFinger(st)
    }
  }

  /** 把手上的手指抬起来（幂等，视频没就绪或会话已断都静默跳过） */
  private liftFinger(st: RunState): void {
    const f = st.finger
    if (!f) return
    st.finger = null
    try {
      const s = this.hooks.getVideoSize(st.sessionId)
      if (!s || s.width <= 0 || s.height <= 0) return
      this.hooks.sendControl(st.sessionId, {
        type: 'touch',
        action: 1,
        pointerId: 'finger',
        x: Math.max(0, Math.round(f.x)),
        y: Math.max(0, Math.round(f.y)),
        width: s.width,
        height: s.height,
        pressure: 0,
        buttons: 0
      })
    } catch {
      /* 会话没了就算了，不能让清理动作把引擎带崩 */
    }
  }

  /** 构造沙箱上下文：除 API 外不带任何宿主能力 */
  private buildApi(st: RunState): Record<string, unknown> {
    /** 循环模式已完成的轮数（只用于日志） */
    let round = 0
    const checkStop = (): void => {
      if (st.stopped) throw new ScriptStoppedError()
      if (!this.hooks.isSessionAlive(st.sessionId)) {
        throw new ScriptApiError('会话已断开，脚本中止')
      }
    }

    /**
     * 异步 API 的防雷罩：用户脚本可能不 await（`tap(1,2)` 直接调），
     * 失败的 promise 会变成 unhandledRejection。这里挂一个 catch 把
     * rejection 标记为已处理（转成日志行），返回原 promise——await 它的
     * 用户依然能拿到原始异常。
     */
    const guard = <T,>(p: Promise<T>): Promise<T> => {
      p.catch((err) => {
        if (err instanceof ScriptStoppedError || st.stopped) return
        const line = this.parseErrorLine(crossRealmStack(err), ScriptEngine.wrapperLines(st))
        const msg = err instanceof ScriptApiError ? err.message : crossRealmMessage(err)
        this.emit(st, { state: 'log', line: `⚠${line ? ` 第${line}行 ` : ' '}${msg}` })
      })
      return p
    }

    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        const t = setTimeout(() => {
          st.timers.delete(t)
          st.wake.delete(resolve)
          resolve()
        }, Math.max(0, ms))
        st.timers.add(t)
        // stop() 会 clearTimeout + 调用 resolve 提前唤醒（否则 promise 永远悬挂）
        st.wake.add(resolve)
      })

    const size = (): { width: number; height: number } => {
      const s = this.hooks.getVideoSize(st.sessionId)
      if (!s || s.width <= 0 || s.height <= 0) {
        throw new ScriptApiError('视频流尚未就绪（宽高未知），请稍后重试')
      }
      return s
    }

    const touch = (
      action: 0 | 1 | 2,
      x: number,
      y: number,
      pressure: number
    ): void => {
      const { width, height } = size()
      this.hooks.sendControl(st.sessionId, {
        type: 'touch',
        action,
        pointerId: 'finger',
        x: Math.max(0, Math.round(x)),
        y: Math.max(0, Math.round(y)),
        width,
        height,
        pressure,
        buttons: 0
      })
    }

    /**
     * 坐标解析 + 边界夹取。为什么必须夹：
     * waitImage 超时返回 (-1,-1)、用户手写 tap(99999,99999) 这类越界值，
     * 不夹就会把负数兜成 0（误触左上角）或把超大值直接发进 scrcpy 协议。
     * 这里统一夹到 [0, 视频宽/高]，越界打一条 warning 日志（不中断脚本）。
     */
    const posX = (v: unknown, what: string): number => {
      const n = Number(v)
      if (!Number.isFinite(n)) throw new ScriptApiError(`${what} 坐标不是数字：${v}`)
      const { width } = size()
      const c = Math.max(0, Math.min(width, Math.round(n)))
      if (Math.round(n) !== c) {
        this.emit(st, { state: 'log', line: `⚠ ${what} 坐标 ${Math.round(n)} 越界（视频宽 ${width}），已夹到 ${c}` })
      }
      return c
    }
    const posY = (v: unknown, what: string): number => {
      const n = Number(v)
      if (!Number.isFinite(n)) throw new ScriptApiError(`${what} 坐标不是数字：${v}`)
      const { height } = size()
      const c = Math.max(0, Math.min(height, Math.round(n)))
      if (Math.round(n) !== c) {
        this.emit(st, { state: 'log', line: `⚠ ${what} 坐标 ${Math.round(n)} 越界（视频高 ${height}），已夹到 ${c}` })
      }
      return c
    }

    const tapImpl = async (x: unknown, y: unknown, duration = 60): Promise<void> => {
      checkStop()
      // 手指还按着时不能再 tap：同一个 pointerId 再发 DOWN 是非法指令，设备侧状态会乱
      if (st.finger) throw new ScriptApiError('手指还按着（touchDown 之后要先 touchUp），不能接着 tap/swipe')
      const px = posX(x, 'x')
      const py = posY(y, 'y')
      const d = Math.max(0, Number(duration) || 0)
      touch(0, px, py, 1) // DOWN
      if (d > 0) await sleep(d)
      touch(1, px, py, 0) // UP 必须先发出，再检查 stop（否则长按中停止会卡住手指）
      checkStop()
    }

    const swipeImpl = async (x1: unknown, y1: unknown, x2: unknown, y2: unknown, duration = 300): Promise<void> => {
      checkStop()
      if (st.finger) throw new ScriptApiError('手指还按着（touchDown 之后要先 touchUp），不能接着 tap/swipe')
      const ax = posX(x1, 'x1')
      const ay = posY(y1, 'y1')
      const bx = posX(x2, 'x2')
      const by = posY(y2, 'y2')
      const dur = Math.min(60_000, Math.max(30, Number(duration) || 300))
      const steps = Math.max(2, Math.round(dur / SWIPE_STEP_MS))
      touch(0, ax, ay, 1) // DOWN
      for (let i = 1; i < steps; i++) {
        await sleep(dur / steps)
        if (st.stopped) {
          touch(1, bx, by, 0) // 停止时也把手指抬起
          throw new ScriptStoppedError()
        }
        touch(2, ax + ((bx - ax) * i) / steps, ay + ((by - ay) * i) / steps, 1) // MOVE
      }
      touch(1, bx, by, 0) // UP
    }

    /**
     * 底层三段式触控：touchDown → touchMove* → touchUp。
     *
     * 为什么需要：不少游戏（尤其虚拟摇杆）在 DOWN 时把**落点当成摇杆原点**，
     * 方向要等 MOVE 才计算 —— 于是「直接在方向点上按一下」永远算出零位移
     * （录制的 WASD 回放没反应就是这个原因）。必须先按中心，再推到方向。
     */
    const touchDownImpl = async (x: unknown, y: unknown): Promise<void> => {
      checkStop()
      if (st.finger) throw new ScriptApiError('手指还按着（上一次 touchDown 没配 touchUp），先 touchUp() 再按')
      const px = posX(x, 'x')
      const py = posY(y, 'y')
      touch(0, px, py, 1)
      st.finger = { x: px, y: py }
    }

    const touchMoveImpl = async (x: unknown, y: unknown): Promise<void> => {
      checkStop()
      if (!st.finger) throw new ScriptApiError('还没按下手指 —— 先 touchDown(x, y)')
      const px = posX(x, 'x')
      const py = posY(y, 'y')
      touch(2, px, py, 1)
      st.finger = { x: px, y: py }
    }

    const touchUpImpl = async (): Promise<void> => {
      const f = st.finger
      st.finger = null
      if (!f) return // 幂等：没按着就当无事发生，脚本收尾里可以放心调用
      touch(1, f.x, f.y, 0) // 先抬手指，再查 stop（否则停止时手指会卡在屏幕上）
      checkStop()
    }

    /**
     * 摇杆一招做完：DOWN 在中心 → 隔一帧 → MOVE 到方向点 → 每 33ms 续 MOVE → UP。
     *
     * 为什么不拿 touchDown/touchMove/touchUp 拼：实时摇杆（键位映射的 WASD）是
     * 「DOWN 中心 + setInterval(33ms) 持续 MOVE」，这两点缺一不可 ——
     *   1. DOWN 与 MOVE 落在同一个输入帧：Unity 侧只报一次 Began 且位置已经是方向点，
     *      游戏把落点当摇杆原点 ⇒ 位移恒 0（就是「录制的 WASD 人物不走」）；
     *   2. 推到位之后不发 MOVE：手指不动的那几百毫秒游戏收不到任何事件，
     *      Moved 不触发 ⇒ 人物立刻停下。
     */
    const stickImpl = async (
      cx: unknown,
      cy: unknown,
      dirX: unknown,
      dirY: unknown,
      holdMs = 0
    ): Promise<void> => {
      checkStop()
      if (st.finger) throw new ScriptApiError('手指还按着（先 touchUp() 再用 stick）')
      const ax = posX(cx, 'x1')
      const ay = posY(cy, 'y1')
      const bx = posX(dirX, 'x2')
      const by = posY(dirY, 'y2')
      const hold = Math.min(60_000, Math.max(0, Number(holdMs) || 0))

      touch(0, ax, ay, 1) // DOWN：按在摇杆中心，游戏以这里为原点
      st.finger = { x: ax, y: ay }
      this.emitDebug(st, `[stick] ↓ 中心(${Math.round(ax)},${Math.round(ay)}) → (${Math.round(bx)},${Math.round(by)})，hold=${hold}ms`)
      await sleep(STICK_SETTLE_MS) // 跨帧，别让 DOWN 和 MOVE 挤进同一帧
      st.finger = { x: bx, y: by }
      touch(2, bx, by, 1) // 第一次推出方向

      const ticks = Math.floor(hold / STICK_TICK_MS)
      for (let i = 0; i < ticks; i++) {
        await sleep(STICK_TICK_MS)
        if (st.stopped) {
          st.finger = null
          touch(1, bx, by, 0) // 停止时也要把手指抬起来
          throw new ScriptStoppedError()
        }
        touch(2, bx, by, 1) // 按住期间持续发 MOVE，等价于实时摇杆的 33ms 心跳
      }
      const rest = hold - ticks * STICK_TICK_MS
      if (rest > 0) await sleep(rest)

      st.finger = null
      touch(1, bx, by, 0) // UP
      this.emitDebug(st, `[stick] ↑ 完成（MOVE×${ticks + 1}）`)
      checkStop()
    }

    const keyImpl = async (name: unknown, duration = 30, metastate = 0): Promise<void> => {
      checkStop()
      const keycode = resolveKeycode(name as string | number)
      const d = Math.max(0, Number(duration) || 0)
      const meta = Math.max(0, Math.min(0xffff, Math.trunc(Number(metastate) || 0)))
      this.hooks.sendControl(st.sessionId, { type: 'keycode', action: 0, keycode, repeat: 0, metastate: meta })
      if (d > 0) await sleep(d)
      this.hooks.sendControl(st.sessionId, { type: 'keycode', action: 1, keycode, repeat: 0, metastate: meta })
      checkStop()
    }

    const waitImpl = async (ms: unknown): Promise<void> => {
      checkStop()
      const n = Math.min(600_000, Math.max(0, Number(ms) || 0))
      await sleep(n)
      checkStop()
    }

    /**
     * waitImage：轮询截屏找模板，直到出现或超时。
     * 找到 → { found:true, x, y }（视频像素坐标，可直接喂给 tap）；
     * 超时 → { found:false, x:-1, y:-1 }（不抛错，脚本自己决定怎么办）；
     * 模板不存在 → 直接报错（提示先去脚本面板截取模板）。
     */
    const waitImageImpl = async (name: unknown, opts?: unknown): Promise<WaitImageResult> => {
      checkStop()
      const tplName = String(name ?? '').trim()
      if (!tplName) throw new ScriptApiError('waitImage() 需要模板名，如 waitImage("start_btn")')
      const o = (typeof opts === 'object' && opts !== null ? opts : {}) as { timeout?: unknown; interval?: unknown; threshold?: unknown }
      const timeout = Math.min(120_000, Math.max(1000, Number(o.timeout) || 10_000))
      const interval = Math.min(5000, Math.max(200, Number(o.interval) || 800))
      const threshold = Math.min(1, Math.max(0.5, Number(o.threshold) || 0.9))
      const deadline = Date.now() + timeout
      let waited = 0
      // eslint-disable-next-line no-constant-condition
      while (true) {
        checkStop()
        const r = await this.hooks.findTemplate(st.sessionId, tplName, threshold)
        if (r === null) throw new ScriptApiError(`模板 "${tplName}" 不存在——请先在脚本面板「截取模板」里框选保存`)
        if (r.found && r.screenW > 0 && r.screenH > 0) {
          const { width, height } = size()
          // 截屏是设备原始分辨率，视频流被 maxSize 缩放过 → 按比例换算成视频坐标
          const sx = width / r.screenW
          const sy = height / r.screenH
          return { found: true, x: Math.round(r.x * sx), y: Math.round(r.y * sy), score: r.score }
        }
        if (Date.now() >= deadline) {
          this.emit(st, { state: 'log', line: `waitImage("${tplName}") 超时（${Math.round(waited / 100) / 10}s 内未出现）` })
          return { found: false, x: -1, y: -1 }
        }
        const nap = Math.min(interval, Math.max(1, deadline - Date.now()))
        waited += nap
        await sleep(nap)
        checkStop()
      }
    }

    const joinLogArgs = (args: unknown[]): string =>
      args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a) ?? String(a))).join(' ')

    /** '#RRGGBB' / '#RGB' / {r,g,b} → {r,g,b}（各通道夹到 0~255） */
    const parseColor = (v: unknown, what: string): { r: number; g: number; b: number } => {
      const byte = (n: number): number => Math.max(0, Math.min(255, Math.round(n)))
      if (typeof v === 'string') {
        let s = v.trim().replace(/^#/, '')
        if (s.length === 3) s = s.split('').map((c) => c + c).join('')
        if (!/^[0-9a-fA-F]{6}$/.test(s)) {
          throw new ScriptApiError(`${what} 颜色格式不对：${JSON.stringify(v)}（要 '#RRGGBB'，如 '#ff0000'）`)
        }
        return { r: parseInt(s.slice(0, 2), 16), g: parseInt(s.slice(2, 4), 16), b: parseInt(s.slice(4, 6), 16) }
      }
      if (v && typeof v === 'object') {
        const o = v as { r?: unknown; g?: unknown; b?: unknown }
        const r = Number(o.r)
        const g = Number(o.g)
        const b = Number(o.b)
        if (![r, g, b].every((n) => Number.isFinite(n))) {
          throw new ScriptApiError(`${what} 颜色对象要 {r,g,b} 三个数字`)
        }
        return { r: byte(r), g: byte(g), b: byte(b) }
      }
      throw new ScriptApiError(`${what} 颜色格式不对：${JSON.stringify(v)}（要 '#RRGGBB' 或 {r,g,b}）`)
    }

    /** 读视频坐标处像素颜色 → { r, g, b, hex } */
    const getPixelColorImpl = async (x: unknown, y: unknown): Promise<{ r: number; g: number; b: number; hex: string }> => {
      checkStop()
      const px = posX(x, 'x')
      const py = posY(y, 'y')
      const c = await this.hooks.getPixelColor(st.sessionId, px, py)
      if (!c) throw new ScriptApiError('读取像素失败（会话断开或截屏失败）')
      return { r: c.r, g: c.g, b: c.b, hex: c.hex }
    }

    /** 在（视频坐标系）region 里找第一个容差内的颜色 → { found, x, y } */
    const findColorImpl = async (
      color: unknown,
      opts?: unknown
    ): Promise<{ found: boolean; x: number; y: number }> => {
      checkStop()
      const rgb = parseColor(color, 'findColor')
      const o = (typeof opts === 'object' && opts !== null ? opts : {}) as { tolerance?: unknown; region?: unknown }
      const tolerance = Math.min(255, Math.max(0, Number(o.tolerance) || 10))
      let region: { x: number; y: number; w: number; h: number } | null = null
      if (o.region && typeof o.region === 'object') {
        const rg = o.region as { x?: unknown; y?: unknown; w?: unknown; h?: unknown }
        region = {
          x: posX(rg.x, 'region.x'),
          y: posY(rg.y, 'region.y'),
          w: Math.max(1, posX(rg.w, 'region.w')),
          h: Math.max(1, posY(rg.h, 'region.h'))
        }
      }
      const m = await this.hooks.findColor(st.sessionId, rgb, tolerance, region)
      if (!m) throw new ScriptApiError('找色失败（会话断开或截屏失败）')
      return m.found ? { found: true, x: m.x, y: m.y } : { found: false, x: -1, y: -1 }
    }

    /** OCR 识别：ocrText(region?) 全屏或指定区域（视频坐标），返回文字与每行位置 */
    const ocrTextImpl = async (
      region?: unknown
    ): Promise<{ text: string; lines: { text: string; score: number; x: number; y: number; w: number; h: number }[] }> => {
      checkStop()
      let reg: { x: number; y: number; w: number; h: number } | null = null
      if (region !== undefined && region !== null) {
        if (typeof region !== 'object') throw new ScriptApiError('ocrText() 参数要 {x,y,w,h} 或不传（全屏）')
        const o = region as { x?: unknown; y?: unknown; w?: unknown; h?: unknown }
        reg = {
          x: posX(o.x ?? 0, 'region.x'),
          y: posY(o.y ?? 0, 'region.y'),
          w: Math.max(1, posX(o.w, 'region.w')),
          h: Math.max(1, posY(o.h, 'region.h'))
        }
      }
      const r = await this.hooks.ocrText(st.sessionId, reg)
      if (!r) {
        throw new ScriptApiError('OCR 失败（会话断开、截屏失败或模型未就绪）——请到「设置 → OCR 模型」下载模型')
      }
      return {
        text: r.text,
        lines: r.lines.map((l) => ({ text: l.text, score: l.score, x: l.box.x, y: l.box.y, w: l.box.w, h: l.box.h }))
      }
    }

    return {
      // ---- 基础 API（异步的都过 guard：不 await 也不产生 unhandledRejection）----
      /** 点按。duration>0 时为长按（按下后等 duration 再抬起）。 */
      tap: (x: unknown, y: unknown, duration?: number): Promise<void> => guard(tapImpl(x, y, duration)),
      /** 滑动：(x1,y1) → (x2,y2)，duration 总时长 ms，内部按 ~16ms 步长插值 MOVE。 */
      swipe: (x1: unknown, y1: unknown, x2: unknown, y2: unknown, duration?: number): Promise<void> =>
        guard(swipeImpl(x1, y1, x2, y2, duration)),
      /** 输入文本（scrcpy INJECT_TEXT，最长 300 字节，中文 OK）。超长直接报错，不静默截断。 */
      text: (s: unknown): void => {
        checkStop()
        const str = String(s ?? '')
        if (str.length === 0) throw new ScriptApiError('text() 需要非空文本')
        const bytes = Buffer.byteLength(str, 'utf8')
        if (bytes > 300) {
          throw new ScriptApiError(`text() 超长：当前 ${bytes} 字节 > 上限 300 字节（中文每字 3 字节），请拆成多次 text() 或用 setClipboard(text, true) 粘贴`)
        }
        this.hooks.sendControl(st.sessionId, { type: 'text', text: str })
      },
      /**
       * 设置设备剪贴板（并可选自动粘贴）。长文本用这个，不受 text() 的 300 字节限制。
       *   await setClipboard('很长的文本…')        // 只写剪贴板
       *   await setClipboard('很长的文本…', true)  // 写剪贴板并立即在设备上粘贴
       */
      setClipboard: (text: unknown, paste = false): void => {
        checkStop()
        const str = String(text ?? '')
        if (str.length === 0) throw new ScriptApiError('setClipboard() 需要非空文本')
        this.hooks.sendControl(st.sessionId, { type: 'setClipboard', text: str, paste: !!paste })
      },
      /** 按键：key('BACK') / key(4) / key('BACK', 500)=长按 500ms / key('A', 0, metastate) 组合键。 */
      key: (name: unknown, duration?: number, metastate?: number): Promise<void> => guard(keyImpl(name, duration, metastate)),
      /**
       * 按下手指（不抬起）。配合 touchMove / touchUp 用：
       *   await touchDown(540, 1200)   // 按在摇杆中心
       *   await touchMove(430, 1000)   // 推到左上
       *   await wait(800)              // 一直推着
       *   await touchUp()
       * 引擎在脚本结束/报错/被停止时会自动抬手，不会把手指卡在屏幕上。
       * ⚠️ 推摇杆请用 stick()：它会在 DOWN 之后跨一帧再推，并在按住期间持续发 MOVE；
       *    手写的「DOWN + 一次 MOVE + wait」Game 侧多半收不到持续拖动。
       */
      touchDown: (x: unknown, y: unknown): Promise<void> => guard(touchDownImpl(x, y)),
      /** 移动已按下的手指（必须先 touchDown）。 */
      touchMove: (x: unknown, y: unknown): Promise<void> => guard(touchMoveImpl(x, y)),
      /** 抬起手指（幂等）。 */
      touchUp: (): Promise<void> => guard(touchUpImpl()),
      /**
       * 推摇杆：(xc,yc) 是摇杆中心，(xd,yd) 是推到的方向点，holdMs 是保持多久。
       *   await stick(540, 1200, 430, 1000, 800)   // 中心 → 左上，推住 0.8 秒
       * 内部：DOWN(中心) → 隔一帧 → MOVE(方向点) → 每 33ms 续 MOVE → UP。
       * 直接 tap(方向点) 是错的（游戏拿落点当原点，位移恒 0），所以摇杆只认这个 API。
       */
      stick: (x1: unknown, y1: unknown, x2: unknown, y2: unknown, holdMs?: number): Promise<void> =>
        guard(stickImpl(x1, y1, x2, y2, holdMs)),
      /** 等待 ms（可被 stop 提前唤醒）。 */
      wait: (ms: unknown): Promise<void> => guard(waitImpl(ms)),
      /**
       * 循环模式的轮间隔 —— 内部 API，不进文档、也不给用户脚本主动用。
       *
       * 实现要点（都是踩过的坑）：
       *   1. 不能直接 `await wait(ms)`：wait 被 stop 唤醒后循环会立刻进下一轮；
       *   2. 不能用一次长 setTimeout：系统睡眠/休眠会冻结定时器，50 分钟的空档变成
       *      "永远等不到"（用户实测 3000/6000 秒一轮，1 小时后没动静就是这个）；
       *   3. 长等待必须有心跳日志，否则用户无法判断脚本还活着。
       * 所以：记住目标墙钟时间 → 每 30 秒（或剩余时间，取小）醒一次 → 查 stop、
       * 按墙钟重算剩余 → 每 5 分钟打一行倒计时。
       */
      __qzrsLoopTick: async (ms: unknown): Promise<boolean> => {
        round += 1
        // 限次：跑满 N 轮立即收尾，不再等下一轮间隔，也不打「第 N+1 轮开始」。
        if (st.maxRounds > 0 && round >= st.maxRounds) {
          this.emit(st, { state: 'log', line: `✔ 已跑满 ${round}/${st.maxRounds} 轮，循环结束` })
          checkStop()
          return true
        }
        const wait = Math.max(0, Number(ms) || 0)
        const nextAt = Date.now() + wait
        this.emit(st, {
          state: 'log',
          line: `↻ 第 ${round} 轮完成，${durText(wait)}后重来（约 ${clockOf(nextAt)}）`
        })
        checkStop()

        let beatAt = Date.now() + ScriptEngine.LOOP_BEAT_MS
        for (;;) {
          const left = nextAt - Date.now()
          if (left <= 0) break
          await sleep(Math.min(ScriptEngine.LOOP_SLICE_MS, left))
          checkStop()
          if (Date.now() >= beatAt) {
            this.emit(st, {
              state: 'log',
              line: `⏳ 距第 ${round + 1} 轮还有 ${durText(nextAt - Date.now())}（${clockOf(nextAt)}）`
            })
            beatAt = Date.now() + ScriptEngine.LOOP_BEAT_MS
          }
        }
        this.emit(st, { state: 'log', line: `▶ 第 ${round + 1} 轮开始（${clockOf(Date.now())}）` })
        return false
      },
      /**
       * 截屏找图：等到模板出现在屏幕上为止（或超时）。
       * 用法：const p = await waitImage('start_btn'); if (p.found) await tap(p.x, p.y)
       * 可选：waitImage('btn', { timeout: 15000, threshold: 0.85 })
       */
      waitImage: (name: unknown, opts?: unknown): Promise<WaitImageResult> => guard(waitImageImpl(name, opts)),
      /**
       * 读像素颜色：(x,y) 是视频坐标。
       *   const c = await getPixelColor(540, 1200)   // { r, g, b, hex: '#rrggbb' }
       */
      getPixelColor: (x: unknown, y: unknown): Promise<{ r: number; g: number; b: number; hex: string }> =>
        guard(getPixelColorImpl(x, y)),
      /**
       * 找色：在指定区域（默认全屏）找第一个容差内的颜色。
       *   const p = await findColor('#ff0000')                       // 全屏找红
       *   const p = await findColor({ r:255,g:0,b:0 }, { tolerance: 15, region: { x:0,y:0,w:540,h:1200 } })
       * 返回 { found, x, y }（视频坐标）；未命中 found=false、x/y=-1。
       * 颜色支持 '#RRGGBB' / '#RGB' / {r,g,b}；tolerance 0~255（默认 10，RGB 三通道各自容差）。
       */
      findColor: (color: unknown, opts?: unknown): Promise<{ found: boolean; x: number; y: number }> =>
        guard(findColorImpl(color, opts)),
      /**
       * OCR 识别屏幕文字（PaddleOCR 本地模型，模型从设置里下载）。
       *   const r = await ocrText()                        // 全屏识别
       *   const r = await ocrText({ x:0, y:0, w:540, h:300 })  // 指定区域
       *   if (r.text.includes('确认')) await tap(r.lines[0].x, r.lines[0].y)
       * 返回 { text, lines: [{ text, score, x, y, w, h }] }（x/y/w/h 是视频坐标，可直接 tap）。
       * ⚠️ 需先在「设置 → OCR 模型」下载模型；一次全屏识别约 1 秒，建议先框小区域再识别。
       */
      ocrText: (region?: unknown): Promise<{ text: string; lines: { text: string; score: number; x: number; y: number; w: number; h: number }[] }> =>
        guard(ocrTextImpl(region)),
      /** 输出一行日志到脚本面板。 */
      log: (...args: unknown[]): void => {
        this.emit(st, { state: 'log', line: joinLogArgs(args) })
      },
      // ---- 沙箱内置（无宿主能力）----
      console: {
        log: (...args: unknown[]): void => {
          this.emit(st, { state: 'log', line: joinLogArgs(args) })
        }
      }
    }
  }
}
