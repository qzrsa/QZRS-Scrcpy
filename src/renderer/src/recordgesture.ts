/**
 * 录制手势 → 脚本代码行。
 *
 * 单独抽成纯函数的原因：这段规则（停顿阈值、取整、点击/长按/滑动的分类）
 * 决定了录制出来的宏好不好用，但它跟画布、React 事件没半点关系，
 * 混在 MirrorView 的 onPointerUp 里只能靠手动点击验证。
 *
 * 规则：
 *   1. 两次操作之间的停顿录成 `await wait(ms)` —— 不录的话回放时一串点击
 *      会在几十毫秒内全发出去，等于没点（游戏里最典型）。
 *   2. 停顿 <200ms 视为连击抖动，不插 wait，避免录出一堆 `wait(30)`。
 *   3. 停顿按 50ms 取整，读起来干净（3120ms → 3100ms）。
 *   4. 位移 <24px 视为点击；按住 ≥500ms 记为长按（第三参数是时长）。
 */
export interface RecordPoint {
  x: number
  y: number
  /** 事件时间戳（ms） */
  time: number
}

export interface RecordedGesture {
  /** 生成的代码（有停顿时是两行：`await wait(...)` + 手势） */
  code: string
  /** 这一次动作结束的时刻，调用方存下来给下一次算间隔 */
  at: number
}

/** 停顿低于这个值不插 wait（连击噪声） */
export const RECORD_GAP_MIN_MS = 200
/** 位移小于这个值算点击（与 scrcpy 自己的 tap 判定接近） */
const TAP_DIST_PX = 24
/** 按住超过这个值算长按 */
const LONG_PRESS_MS = 500

export function recordGestureLine(opts: {
  /** 按下点（含时间） */
  down: RecordPoint
  /** 抬起点 */
  up: { x: number; y: number }
  /** 现在（抬起时刻，用于算下一次的间隔基准） */
  now: number
  /** 上一条动作的结束时刻；0 表示这是录制开始后的第一条 */
  lastAt: number
}): RecordedGesture {
  const { down, up, now, lastAt } = opts
  const rx = (v: number): number => Math.round(v)

  const gap = lastAt > 0 ? down.time - lastAt : 0
  const waitLine =
    gap >= RECORD_GAP_MIN_MS ? `await wait(${Math.max(RECORD_GAP_MIN_MS, Math.round(gap / 50) * 50)})` : ''

  const dt = Math.max(30, now - down.time)
  const dist = Math.hypot(up.x - down.x, up.y - down.y)
  const gesture =
    dist < TAP_DIST_PX
      ? dt >= LONG_PRESS_MS
        ? `await tap(${rx(down.x)}, ${rx(down.y)}, ${dt})`
        : `await tap(${rx(down.x)}, ${rx(down.y)})`
      : `await swipe(${rx(down.x)}, ${rx(down.y)}, ${rx(up.x)}, ${rx(up.y)}, ${dt})`

  return { code: waitLine ? `${waitLine}\n${gesture}` : gesture, at: now }
}
