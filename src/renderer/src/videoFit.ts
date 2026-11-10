/**
 * 镜像画布的显示尺寸计算：按「等比缩放 + 完整可见」算出显式像素。
 * 纯 CSS 做不到——画布只能被压小不能放大，且竖屏时百分比 max-height 会失效导致被裁。
 * ⚠️ 不要改成 width/height:100% + object-fit: contain：画布盒子会变成整个容器，
 * getBoundingClientRect() 拿到盒子而非画面，触摸/按键覆盖层的坐标映射会整体偏移。
 */

export interface Size {
  width: number
  height: number
}

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

/** 画布四周留白（CSS px）：避免圆角与投影贴死在 stage 边缘被 `overflow: hidden` 裁掉。 */
export const MIRROR_PADDING = 8

/** `canvas` 在还没有任何帧时的 intrinsic 尺寸（HTML 规范默认值）。 */
export const CANVAS_IDLE_WIDTH = 300
export const CANVAS_IDLE_HEIGHT = 150

/**
 * 画布是否已经拿到真实视频尺寸。
 *
 * 按 300x150 的默认尺寸铺开会先闪一个巨大的黑框，所以首帧到达前不套自适应。
 * 这里用尺寸本身判断，而不是额外记一个"是否收到过帧"的标志：
 * 切会话时画布会保留上一路的分辨率（比掉回默认小框更自然），而且这个判断可被直接测试。
 */
export function hasRealVideoSize(width: number, height: number): boolean {
  return width > 0 && height > 0 && (width !== CANVAS_IDLE_WIDTH || height !== CANVAS_IDLE_HEIGHT)
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

/**
 * 按「等比缩放 + 完整可见（contain）」计算视频在给定盒子里的显示尺寸。
 * 允许放大也允许缩小，宽高比严格保持 `videoW : videoH`（不产生非等比拉伸）。
 *
 * 参数非法（0 / 负数 / NaN / Infinity）时返回 `{0, 0}`，调用方据此跳过这次写入 ——
 * 否则会把 NaN 写进 style 把画布从布局里"抹掉"。
 */
export function fitContain(
  boxW: number,
  boxH: number,
  videoW: number,
  videoH: number,
  padding = 0
): Size {
  const positive = (v: number): boolean => Number.isFinite(v) && v > 0
  if (!positive(boxW) || !positive(boxH) || !positive(videoW) || !positive(videoH)) {
    return { width: 0, height: 0 }
  }
  const pad = Number.isFinite(padding) && padding > 0 ? padding : 0
  let availW = boxW - pad * 2
  let availH = boxH - pad * 2
  // 盒子比两倍留白还窄/矮时退化成不留白：宁可贴边，也别算不出尺寸
  if (availW < 1 || availH < 1) {
    availW = boxW
    availH = boxH
  }
  const k = Math.min(availW / videoW, availH / videoH)
  return { width: round2(videoW * k), height: round2(videoH * k) }
}

/**
 * 子矩形相对父矩形的偏移，用于把覆盖层钉在**画布**上而不是整个 stage 上
 * （`.mirror-wrap` 现在铺满 stage，覆盖层若按父级尺寸铺开会整体偏移）。
 */
export function relativeRect(parent: Rect, child: Rect): Rect {
  return {
    left: round2(child.left - parent.left),
    top: round2(child.top - parent.top),
    width: round2(child.width),
    height: round2(child.height)
  }
}
