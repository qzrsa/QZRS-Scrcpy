/**
 * 录制手势 → 脚本代码行（纯函数，便于单测）。
 * 停顿录成 wait(ms)：<200ms 视为连击抖动不录，按 50ms 取整。
 * 位移 <24px 视为点击；按住 ≥500ms 记为长按（第三参数为时长）。
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

/**
 * 停顿 → `await wait(ms)` 这一行（不需要插 wait 时返回空串）。
 *
 * 手势录制和键盘录制共用同一条规则：两边如果各写一份，迟早会有一边
 * 把 50ms 取整写成 100ms，录出来的脚本节奏就对不上了。
 */
export function recordGapLine(gap: number): string {
  if (gap < RECORD_GAP_MIN_MS) return ''
  return `await wait(${Math.max(RECORD_GAP_MIN_MS, Math.round(gap / 50) * 50)})`
}

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
  const waitLine = recordGapLine(gap)

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
