import vm from 'node:vm'
import type { ControlCommand, ScriptInfo, ScriptRunEvent } from '@shared/types'

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
  /** 挂起的定时器（stop 时提前唤醒） */
  timers: Set<NodeJS.Timeout>
  /** 等待被唤醒的 stop 检查点（stop 时立即触发） */
  wake: Set<() => void>
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

/** Omit 在联合类型上会塌缩成公共键，这里分发处理（每个成员各自 omit） */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type ScriptRunEventPartial = DistributiveOmit<ScriptRunEvent, 'runId' | 'scriptId' | 'name'>

export class ScriptEngine {
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
  run(script: Pick<ScriptInfo, 'id' | 'name' | 'code'>, sessionId: string): { runId: string } {
    if (this.isScriptRunning(script.id)) {
      throw new Error(`脚本「${script.name}」正在运行中，请先停止`)
    }
    const code = String(script.code ?? '')
    if (code.length === 0) throw new Error('脚本内容为空')
    if (code.length > MAX_CODE_LENGTH) throw new Error(`脚本过长（>${MAX_CODE_LENGTH} 字符）`)
    if (!this.hooks.isSessionAlive(sessionId)) throw new Error('会话不存在或已断开，请先连接设备')

    this.seq += 1
    const runId = `r${Date.now().toString(36)}${this.seq.toString(36)}`
    const st: RunState = {
      runId,
      scriptId: script.id,
      name: script.name,
      sessionId,
      stopped: false,
      timers: new Set(),
      wake: new Set()
    }
    this.runs.set(runId, st)
    this.emit(st, { state: 'started', sessionId })

    const started = Date.now()
    void this.execute(st, code)
      .then((outcome) => {
        if (outcome === 'stopped') this.emit(st, { state: 'stopped' })
        else if (typeof outcome === 'string') this.emit(st, { state: 'error', message: outcome })
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
   * 执行主体。返回值语义：
   * undefined → 正常跑完；'stopped' → 被停止；string → 错误消息（用户代码异常 / API 错误）。
   * 注意别用 'ok' 之类的字符串表示成功——它会被上层当成错误消息。
   */
  private async execute(st: RunState, code: string): Promise<'stopped' | undefined | string> {
    const api = this.buildApi(st)
    const context = vm.createContext(api, { name: `qzrs-script-${st.runId}` })
    try {
      // 包一层 async IIFE：用户代码可以直接顶层 await（vm.Script 本身不支持 TLA）
      const wrapped = new vm.Script(`(async () => {\n${code}\n})()`, { filename: `${st.name}.js` })
      await wrapped.runInContext(context, { timeout: 5000 })
      return st.stopped ? 'stopped' : undefined
    } catch (err) {
      if (st.stopped) return 'stopped'
      if (err instanceof ScriptStoppedError) return 'stopped'
      if (err instanceof ScriptApiError) return err.message
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      return `脚本异常 → ${msg}`
    }
  }

  /** 构造沙箱上下文：除 API 外不带任何宿主能力 */
  private buildApi(st: RunState): Record<string, unknown> {
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
    const guard = (p: Promise<void>): Promise<void> => {
      p.catch((err) => {
        if (err instanceof ScriptStoppedError || st.stopped) return
        const msg = err instanceof ScriptApiError ? err.message : err instanceof Error ? `${err.name}: ${err.message}` : String(err)
        this.emit(st, { state: 'log', line: `⚠ ${msg}` })
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

    const pos = (v: unknown, what: string): number => {
      const n = Number(v)
      if (!Number.isFinite(n)) throw new ScriptApiError(`${what} 坐标不是数字：${v}`)
      return n
    }

    const tapImpl = async (x: unknown, y: unknown, duration = 60): Promise<void> => {
      checkStop()
      const px = pos(x, 'x')
      const py = pos(y, 'y')
      const d = Math.max(0, Number(duration) || 0)
      touch(0, px, py, 1) // DOWN
      if (d > 0) await sleep(d)
      touch(1, px, py, 0) // UP 必须先发出，再检查 stop（否则长按中停止会卡住手指）
      checkStop()
    }

    const swipeImpl = async (x1: unknown, y1: unknown, x2: unknown, y2: unknown, duration = 300): Promise<void> => {
      checkStop()
      const ax = pos(x1, 'x1')
      const ay = pos(y1, 'y1')
      const bx = pos(x2, 'x2')
      const by = pos(y2, 'y2')
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

    const keyImpl = async (name: unknown, duration = 30): Promise<void> => {
      checkStop()
      const keycode = resolveKeycode(name as string | number)
      const d = Math.max(0, Number(duration) || 0)
      this.hooks.sendControl(st.sessionId, { type: 'keycode', action: 0, keycode, repeat: 0, metastate: 0 })
      if (d > 0) await sleep(d)
      this.hooks.sendControl(st.sessionId, { type: 'keycode', action: 1, keycode, repeat: 0, metastate: 0 })
      checkStop()
    }

    const waitImpl = async (ms: unknown): Promise<void> => {
      checkStop()
      const n = Math.min(600_000, Math.max(0, Number(ms) || 0))
      await sleep(n)
      checkStop()
    }

    const joinLogArgs = (args: unknown[]): string =>
      args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a) ?? String(a))).join(' ')

    return {
      // ---- 基础 API（异步的都过 guard：不 await 也不产生 unhandledRejection）----
      /** 点按。duration>0 时为长按（按下后等 duration 再抬起）。 */
      tap: (x: unknown, y: unknown, duration?: number): Promise<void> => guard(tapImpl(x, y, duration)),
      /** 滑动：(x1,y1) → (x2,y2)，duration 总时长 ms，内部按 ~16ms 步长插值 MOVE。 */
      swipe: (x1: unknown, y1: unknown, x2: unknown, y2: unknown, duration?: number): Promise<void> =>
        guard(swipeImpl(x1, y1, x2, y2, duration)),
      /** 输入文本（scrcpy INJECT_TEXT，最长 300 字节，中文 OK）。 */
      text: (s: unknown): void => {
        checkStop()
        const str = String(s ?? '')
        if (str.length === 0) throw new ScriptApiError('text() 需要非空文本')
        this.hooks.sendControl(st.sessionId, { type: 'text', text: str })
      },
      /** 按键：key('BACK') / key(4) / key('BACK', 500)=长按 500ms。 */
      key: (name: unknown, duration?: number): Promise<void> => guard(keyImpl(name, duration)),
      /** 等待 ms（可被 stop 提前唤醒）。 */
      wait: (ms: unknown): Promise<void> => guard(waitImpl(ms)),
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
