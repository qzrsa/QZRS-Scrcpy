/**
 * 录制键盘 → 脚本代码行。
 *
 * 键盘和手指走的是两条完全不同的下发路径，所以录出来的代码也不一样：
 *
 *   1. 没有按键映射（或当前方案里没有这个键）→ 发的是 Android keycode，
 *      录成 `await key('BACK')`；按住多久写第二参数 `await key('A', 1200)`。
 *   2. 映射动作是 keycode → 同样是 key 调用，只是 keycode 来自映射。
 *   3. 映射动作是手势（tap / hold / repeat / view / swipe / WASD 摇杆）→
 *      手机上收到的是**触点**不是按键。脚本里没有"按键映射"这一层，所以直接
 *      按映射坐标录成 `tap()` / `swipe()`：回放不用先挂方案，换台设备也能跑。
 *
 * 取舍说明：
 *   - Shift / Ctrl / Alt 单独按下不录，折进下一个键的 metastate
 *     （Ctrl+E 录成 `key('E', 0, 4096)`），不然会录出一堆没意义的 CTRL_LEFT。
 *   - 系统自动重复（e.repeat）不录 —— 按住一个键会刷出几十条同样的记录。
 *   - 停顿时长规则与手势录制共用 recordGapLine（同一份 200ms 阈值 / 50ms 取整）。
 *   - hold / repeat / view / 摇杆都要等**抬手**才知道按了多久，所以按下时返回 null，
 *     由调用方存下按下时刻再交给 up。
 */
import { recordGapLine } from './recordgesture'
import type { RecordedGesture } from './recordgesture'

/** 按住短于这个值视为普通敲击，录成 `key('X')`（引擎默认按 30ms） */
export const KEY_HOLD_MIN_MS = 200

/** keycode → 脚本里能用的名字；与引擎 scriptengine.ts 的 KEYCODE_NAMES 保持一致 */
const KEY_NAMES: Record<number, string> = {
  3: 'HOME',
  4: 'BACK',
  5: 'CALL',
  6: 'ENDCALL',
  24: 'VOLUME_UP',
  25: 'VOLUME_DOWN',
  26: 'POWER',
  82: 'MENU',
  187: 'APP_SWITCH',
  66: 'ENTER',
  67: 'DEL',
  62: 'SPACE',
  61: 'TAB',
  111: 'ESC',
  19: 'UP',
  20: 'DOWN',
  21: 'LEFT',
  22: 'RIGHT',
  84: 'SEARCH',
  27: 'CAMERA',
  80: 'FOCUS',
  79: 'HEADSETHOOK',
  91: 'MUTE',
  92: 'PAGE_UP',
  93: 'PAGE_DOWN'
}
// A-Z（KEYCODE_A=29 起连续）与 0-9（KEYCODE_0=7 起连续）
for (let i = 0; i < 26; i++) KEY_NAMES[29 + i] = String.fromCharCode(65 + i)
for (let i = 0; i <= 9; i++) KEY_NAMES[7 + i] = String(i)

/**
 * keycode → `key()` 的实参字面量。
 * 有名气就写名字（好读），没有就写数字（`key(113)`），数字同样能跑。
 */
export function keyArg(keycode: number): string {
  const n = KEY_NAMES[keycode]
  return n ? `'${n}'` : String(Math.trunc(keycode))
}

/** 按住时长：≥200ms 才写进参数，按 50ms 取整 */
function holdArg(holdMs: number): number {
  return holdMs >= KEY_HOLD_MIN_MS ? Math.max(50, Math.round(holdMs / 50) * 50) : 0
}

function join(waitLine: string, line: string): string {
  return waitLine ? `${waitLine}\n${line}` : line
}

/** 归一化坐标 → 视频像素（脚本 API 用的是视频像素） */
function px(nx: number, size: number): number {
  const v = Math.max(0, Math.min(1, Number.isFinite(nx) ? nx : 0))
  return Math.round(v * Math.max(1, size))
}

type Long = 'tap' | 'hold' | 'repeat' | 'view' | 'swipe' | 'keycode'

/** 录制只关心映射里这几个字段（结构兼容 KeymapBinding） */
export interface RecordBinding {
  action: Long
  x: number
  y: number
  x2: number
  y2: number
  duration: number
  viewDx: number
  viewDy: number
  repeatMs: number
  keycode: number
  groupId?: string | null
}

interface Common {
  /** 按下时刻 */
  downAt: number
  /** 上一条动作结束时刻；0 = 录制开始第一条 */
  lastAt: number
  /** 抬手时刻 */
  now: number
}

/** `await key('BACK')` / `await key('A', 1200)` / `await key('E', 0, 4096)` */
export function keyLine(o: Common & { keycode: number; holdMs: number; metastate: number }): RecordedGesture {
  const hold = holdArg(o.holdMs)
  const meta = Math.trunc(Number(o.metastate) || 0)
  // metastate 非 0 时第二参数必须显式写 0，否则会被当成 duration
  const args = meta ? `, ${hold}, ${meta}` : hold ? `, ${hold}` : ''
  const gap = o.lastAt > 0 ? o.downAt - o.lastAt : 0
  return { code: join(recordGapLine(gap), `await key(${keyArg(o.keycode)}${args})`), at: o.now }
}

/**
 * `await tap(640, 360)` / `await tap(640, 360, 800)` —— 坐标是视频像素。
 * `exact=true` 表示时长是映射里写死的（tap 的 auto-release），不做 200ms 阈值过滤：
 * 用户特意把某个键设成「按住 100ms」，录回去也还得是 100ms。
 */
export function tapLine(
  o: Common & {
    x: number
    y: number
    holdMs: number
    videoW: number
    videoH: number
    at?: number
    exact?: boolean
  }
): RecordedGesture {
  const hold = o.exact ? Math.max(0, Math.round(o.holdMs)) : holdArg(o.holdMs)
  const gap = o.lastAt > 0 ? o.downAt - o.lastAt : 0
  const call = `await tap(${px(o.x, o.videoW)}, ${px(o.y, o.videoH)}${hold ? `, ${hold}` : ''})`
  return { code: join(recordGapLine(gap), call), at: o.at ?? o.now }
}

/** `await swipe(x1, y1, x2, y2, ms)` */
export function swipeLine(
  o: Common & {
    x1: number
    y1: number
    x2: number
    y2: number
    durMs: number
    videoW: number
    videoH: number
    at?: number
  }
): RecordedGesture {
  const dur = Math.max(30, Math.round(o.durMs))
  const gap = o.lastAt > 0 ? o.downAt - o.lastAt : 0
  const call =
    `await swipe(${px(o.x1, o.videoW)}, ${px(o.y1, o.videoH)}, ` +
    `${px(o.x2, o.videoW)}, ${px(o.y2, o.videoH)}, ${dur})`
  return { code: join(recordGapLine(gap), call), at: o.at ?? o.now }
}

/**
 * repeat 映射（连发）→ 按实际按住时长折算成循环点按。
 * 录成一条长按是错的（连发和长按在游戏里完全是两回事），所以按次数展开。
 */
export function repeatLine(
  o: Common & { x: number; y: number; holdMs: number; intervalMs: number; videoW: number; videoH: number }
): RecordedGesture {
  const iv = Math.max(20, Math.round(o.intervalMs || 100))
  const times = Math.max(1, Math.floor(Math.max(0, o.holdMs) / iv))
  const gap = o.lastAt > 0 ? o.downAt - o.lastAt : 0
  const x = px(o.x, o.videoW)
  const y = px(o.y, o.videoH)
  const body = `for (let i = 0; i < ${times}; i++) {\n  await tap(${x}, ${y})\n  await wait(${iv})\n}`
  return { code: join(recordGapLine(gap), body), at: o.now }
}

/** view 映射（拖动视角）→ 起点到终点的 swipe；终点由 tick 次数推出来 */
export function viewLine(
  o: Common & {
    x: number
    y: number
    viewDx: number
    viewDy: number
    intervalMs: number
    holdMs: number
    videoW: number
    videoH: number
  }
): RecordedGesture {
  const iv = Math.max(16, o.intervalMs || 50)
  const ticks = Math.max(1, Math.round(Math.max(0, o.holdMs) / iv))
  const nx2 = Math.max(0, Math.min(1, o.x + o.viewDx * ticks))
  const ny2 = Math.max(0, Math.min(1, o.y + o.viewDy * ticks))
  return swipeLine({
    downAt: o.downAt,
    lastAt: o.lastAt,
    now: o.now,
    x1: o.x,
    y1: o.y,
    x2: nx2,
    y2: ny2,
    durMs: Math.max(30, o.holdMs),
    videoW: o.videoW,
    videoH: o.videoH
  })
}

/**
 * 摇杆（WASD 这类 groupId 绑定）：按住期间每个方向只是往同一根手指上叠向量，
 * 抬手时才是一个完整动作 → 录成一行 `stick(中心, 方向点, 按住时长)`。
 *
 * ⚠️ 两个坑，缺一个就"回放人物不走"：
 *   1. 不能录成 `tap(方向点, 时长)` —— 游戏在 DOWN 时把**落点当摇杆原点**，
 *      方向要等 MOVE 才算，直接在方向点上按一下位移恒为 0；
 *   2. 不能录成「touchDown + 一次 touchMove + wait」—— DOWN 与 MOVE 落在同一个
 *      输入帧会被合并，而且手指不动的那几百毫秒游戏收不到 MOVE，人物立刻停。
 *
 * 所以交给引擎的 stick() 按实时摇杆的时序重放：DOWN(中心) → 跨一帧 → MOVE(方向点)
 * → 每 33ms 续一次 MOVE → UP。细节见 scriptengine.ts 的 stickImpl。
 */
export function stickLine(
  o: Common & {
    centerX: number
    centerY: number
    dx: number
    dy: number
    videoW: number
    videoH: number
  }
): RecordedGesture {
  const cx = px(o.centerX, o.videoW)
  const cy = px(o.centerY, o.videoH)
  const ox = px(o.centerX + o.dx, o.videoW)
  const oy = px(o.centerY + o.dy, o.videoH)
  const held = Math.max(0, o.now - o.downAt)
  // 50ms 取整；短于 50ms 的小抖动不写时长（stick 默认 0 = 只推一次方向点）
  const hold = held < 50 ? 0 : Math.round(held / 50) * 50
  const gap = o.lastAt > 0 ? o.downAt - o.lastAt : 0
  const call = `await stick(${cx}, ${cy}, ${ox}, ${oy}${hold ? `, ${hold}` : ''})`
  return { code: join(recordGapLine(gap), call), at: o.now }
}

export interface RecordKeyOpts extends Omit<Common, 'now'> {
  phase: 'down' | 'up'
  /** 无映射时下发的 keycode；映射动作是手势时为 null */
  keycode: number | null
  /** 命中的映射；没命中为 null */
  binding: RecordBinding | null
  metastate: number
  videoW: number
  videoH: number
  /** 抬手时刻（down 阶段传按下时刻即可，只用于 at 计算） */
  now: number
}

/**
 * 按键 → 一行（或几行）脚本。
 * 返回 null 表示"这次不产生代码"：按下时还不知道按多久（等抬手再录），
 * 或者是在按下阶段就已经录完的一次性动作（tap / swipe）。
 */
export function recordKeyLine(o: RecordKeyOpts): RecordedGesture | null {
  const now = o.now
  const common: Common = { downAt: o.downAt, lastAt: o.lastAt, now }
  const b = o.binding

  // 摇杆由调用方累积各方向向量后走 stickLine，这里不单独录
  if (b?.groupId) return null

  if (o.phase === 'down') {
    if (!b) return null
    // 一次性动作：按下就决定了整段手势的时长，不用等抬手
    if (b.action === 'tap' && b.duration <= 0) {
      return tapLine({ ...common, x: b.x, y: b.y, holdMs: 0, videoW: o.videoW, videoH: o.videoH })
    }
    if (b.action === 'tap') {
      // 映射自带松开时长（duration>0），手机会在 duration 后自己抬手
      return tapLine({
        ...common,
        x: b.x,
        y: b.y,
        holdMs: b.duration,
        videoW: o.videoW,
        videoH: o.videoH,
        at: now + b.duration,
        exact: true
      })
    }
    if (b.action === 'swipe') {
      const dur = Math.max(30, b.duration || 200)
      return swipeLine({
        ...common,
        x1: b.x,
        y1: b.y,
        x2: b.x2,
        y2: b.y2,
        durMs: dur,
        videoW: o.videoW,
        videoH: o.videoH,
        at: now + dur
      })
    }
    return null
  }

  // ---- 抬手阶段：此刻才知道按了多久 ----
  const holdMs = Math.max(0, now - o.downAt)
  if (!b) {
    if (o.keycode == null) return null
    return keyLine({ ...common, keycode: o.keycode, holdMs, metastate: o.metastate })
  }
  switch (b.action) {
    case 'keycode':
      return keyLine({ ...common, keycode: b.keycode, holdMs, metastate: o.metastate })
    case 'hold':
      return tapLine({ ...common, x: b.x, y: b.y, holdMs, videoW: o.videoW, videoH: o.videoH })
    case 'repeat':
      return repeatLine({
        ...common,
        x: b.x,
        y: b.y,
        holdMs,
        intervalMs: b.repeatMs,
        videoW: o.videoW,
        videoH: o.videoH
      })
    case 'view':
      return viewLine({
        ...common,
        x: b.x,
        y: b.y,
        viewDx: b.viewDx,
        viewDy: b.viewDy,
        intervalMs: b.repeatMs,
        holdMs,
        videoW: o.videoW,
        videoH: o.videoH
      })
    default:
      return null // tap / swipe 在按下时已经录过
  }
}
