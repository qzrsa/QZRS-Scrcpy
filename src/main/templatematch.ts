/**
 * 模板匹配（waitImage 的核心）：在一张大图（设备截屏）里找小图（用户截取的模板）。
 *
 * 纯函数、无依赖：输入都是 RGBA 像素数组（调用方用 Electron nativeImage 把
 * PNG 解成 BGRA 位图再转 RGBA——不引 pngjs 之类的解码依赖）。
 *
 * 算法：灰度化 + 标准化互相关（NCC，对亮度整体偏移稳健），按搜索空间分两路：
 *   小图（候选位×模板像素 ≤ 40M）→ 全分辨率穷举，无降采样失真，最稳；
 *   大图 → 金字塔两级：粗扫 = 双方降采样 1/2（像素数 ×1/16），步长 3 + 模板抽样，
 *          保留前 3 个分离候选峰；精扫 = 各候选 ±4 邻域全分辨率精确打分。
 * NCC 分母用同采样点的窗口统计（一次循环同时累加 ΣS/ΣS²/ΣT·S），score 有严格
 * 的 0..1 语义（1 = 完全一致），阈值判断可靠。
 */

export interface GrayImage {
  /** 行优先灰度像素（0..255） */
  data: Uint8Array
  width: number
  height: number
}

/** RGBA → 灰度（BT.601 加权） */
export function toGray(rgba: Uint8Array, width: number, height: number): GrayImage {
  const out = new Uint8Array(width * height)
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114) / 1000
  }
  return { data: out, width, height }
}

/** 2×2 盒滤波降采样（金字塔粗扫用） */
export function downsample2(src: GrayImage): GrayImage {
  const w = src.width >> 1
  const h = src.height >> 1
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const r0 = (y * 2) * src.width
    const r1 = r0 + src.width
    for (let x = 0; x < w; x++) {
      const a = src.data[r0 + x * 2]
      const b = src.data[r0 + x * 2 + 1]
      const c = src.data[r1 + x * 2]
      const d = src.data[r1 + x * 2 + 1]
      out[y * w + x] = (a + b + c + d) >> 2
    }
  }
  return { data: out, width: w, height: h }
}

/**
 * 单候选位置的 NCC：对 (ox,oy) 起、按预生成采样点（模板内行列坐标）取点，
 * 一次循环累加 ΣS、ΣS²、Σ(T·S)，窗口统计与互相关项用同一批采样点，
 * 分母 = sqrt((ΣS²/n-μs²)·σt²)（μt/σt 为同批采样点的模板统计）。
 */
function nccSampled(
  screen: GrayImage,
  ox: number,
  oy: number,
  rows: Int32Array,
  cols: Int32Array,
  tVals: Float64Array,
  n: number,
  muT: number,
  sigmaT: number
): number {
  let s1 = 0
  let s2 = 0
  let st = 0
  const sw = screen.width
  for (let i = 0; i < n; i++) {
    const s = screen.data[(oy + rows[i]) * sw + ox + cols[i]]
    const t = tVals[i]
    s1 += s
    s2 += s * s
    st += s * t
  }
  const muS = s1 / n
  const varS = s2 / n - muS * muS
  if (varS < 1e-6) return 0 // 均匀色块区域无法定位
  const cov = st / n - muT * muS
  const denom = Math.sqrt(varS) * sigmaT
  if (denom < 1e-6) return 0
  return cov / denom
}

/** 预生成某抽样步长下的模板采样点（模板内行列坐标）与统计 */
function buildSampling(tpl: GrayImage, stride: number): { rows: Int32Array; cols: Int32Array; tVals: Float64Array; n: number; muT: number; sigmaT: number } {
  const rows: number[] = []
  const cols: number[] = []
  const vals: number[] = []
  for (let ty = 0; ty < tpl.height; ty += stride) {
    for (let tx = 0; tx < tpl.width; tx += stride) {
      rows.push(ty)
      cols.push(tx)
      vals.push(tpl.data[ty * tpl.width + tx])
    }
  }
  const n = vals.length
  let mu = 0
  for (const v of vals) mu += v
  mu /= n
  let vr = 0
  for (const v of vals) vr += (v - mu) * (v - mu)
  return {
    rows: Int32Array.from(rows),
    cols: Int32Array.from(cols),
    tVals: Float64Array.from(vals),
    n,
    muT: mu,
    sigmaT: Math.sqrt(Math.max(1e-6, vr / n))
  }
}

export interface MatchResult {
  /** 匹配中心点（大图坐标系） */
  x: number
  y: number
  /** 归一化相似度 0..1（1 = 逐像素完全一致） */
  score: number
}

/**
 * 全分辨率穷举的成本预算（候选位置数 × 模板像素数），低于它不走金字塔。
 * 降采样对高频纹理会因相位错位而失真（盒滤波奇偶相位对不上），小图直接
 * 全扫既快又稳；真实截屏（1080×2400 + 100×80 模板 ≈ 18G 次）远超预算才走金字塔。
 */
const EXHAUSTIVE_OPS = 40_000_000

/**
 * 在 screen 里找 tpl 最相似的位置。
 * 返回 null = 尺寸不合法 / 模板过小 / 全图最佳相似度 < minScore。
 */
export function matchTemplate(screen: GrayImage, tpl: GrayImage, minScore: number): MatchResult | null {
  if (tpl.width < 4 || tpl.height < 4) return null
  if (tpl.width > screen.width || tpl.height > screen.height) return null
  if (screen.width < 4 || screen.height < 4) return null

  const smp1 = buildSampling(tpl, 1)
  const ops = (screen.width - tpl.width + 1) * (screen.height - tpl.height + 1) * tpl.width * tpl.height

  // ---- 小搜索空间：全分辨率穷举（无降采样失真，最稳）----
  if (ops <= EXHAUSTIVE_OPS) {
    let best = -2
    let bx = 0
    let by = 0
    for (let oy = 0; oy <= screen.height - tpl.height; oy++) {
      for (let ox = 0; ox <= screen.width - tpl.width; ox++) {
        const s = nccSampled(screen, ox, oy, smp1.rows, smp1.cols, smp1.tVals, smp1.n, smp1.muT, smp1.sigmaT)
        if (s > best) {
          best = s
          bx = ox
          by = oy
        }
      }
    }
    return finish(bx, by, best, tpl, minScore)
  }

  // ---- 大搜索空间：金字塔粗扫（1/2 分辨率，步长 3）----
  const sHalf = downsample2(screen)
  const tHalf = downsample2(tpl)
  if (tHalf.width < 4 || tHalf.height < 4 || tHalf.width > sHalf.width || tHalf.height > sHalf.height) {
    // 模板太小没法降采样 → 全分辨率步长 2 稀疏扫（模板极小，成本可控）
    let best = -2
    let bx = 0
    let by = 0
    for (let oy = 0; oy <= screen.height - tpl.height; oy += 2) {
      for (let ox = 0; ox <= screen.width - tpl.width; ox += 2) {
        const s = nccSampled(screen, ox, oy, smp1.rows, smp1.cols, smp1.tVals, smp1.n, smp1.muT, smp1.sigmaT)
        if (s > best) {
          best = s
          bx = ox
          by = oy
        }
      }
    }
    return finish(bx, by, best, tpl, minScore)
  }

  const coarse = buildSampling(tHalf, 2)
  // 粗扫保留前 3 个「相距 ≥3（半分辨率像素）」的候选峰：降采样后的真实峰
  // 分数可能略低于噪声峰，只取第一名会漏
  const top: { x: number; y: number; s: number }[] = []
  const consider = (x: number, y: number, s: number): void => {
    if (top.length === 3 && s <= top[2].s) return
    for (let i = 0; i < top.length; i++) {
      if (Math.max(Math.abs(top[i].x - x), Math.abs(top[i].y - y)) < 3) {
        if (top[i].s >= s) return // 同一个峰，已有更高分
        top.splice(i, 1) // 同峰更低分 → 替换
        break
      }
    }
    top.push({ x, y, s })
    top.sort((a, b) => b.s - a.s)
    if (top.length > 3) top.pop()
  }
  for (let oy = 0; oy <= sHalf.height - tHalf.height; oy += 3) {
    for (let ox = 0; ox <= sHalf.width - tHalf.width; ox += 3) {
      consider(ox, oy, nccSampled(sHalf, ox, oy, coarse.rows, coarse.cols, coarse.tVals, coarse.n, coarse.muT, coarse.sigmaT))
    }
  }

  // ---- 精扫：全分辨率，逐候选 ±4 邻域，保留全局最优 ----
  let best = -2
  let bx = 0
  let by = 0
  for (const c of top) {
    const cx = c.x * 2
    const cy = c.y * 2
    const x0 = Math.max(0, cx - 4)
    const y0 = Math.max(0, cy - 4)
    const x1 = Math.min(screen.width - tpl.width, cx + 4)
    const y1 = Math.min(screen.height - tpl.height, cy + 4)
    for (let oy = y0; oy <= y1; oy++) {
      for (let ox = x0; ox <= x1; ox++) {
        const s = nccSampled(screen, ox, oy, smp1.rows, smp1.cols, smp1.tVals, smp1.n, smp1.muT, smp1.sigmaT)
        if (s > best) {
          best = s
          bx = ox
          by = oy
        }
      }
    }
  }

  return finish(bx, by, best, tpl, minScore)
}

function finish(bx: number, by: number, score: number, tpl: GrayImage, minScore: number): MatchResult | null {
  if (score < minScore) return null
  return {
    x: bx + Math.floor(tpl.width / 2),
    y: by + Math.floor(tpl.height / 2),
    score: Math.max(0, Math.min(1, score))
  }
}

/** BGRA（Electron nativeImage.toBitmap 的字节序）→ RGBA */
export function bgraToRgba(bgra: Uint8Array): Uint8Array {
  const out = new Uint8Array(bgra.length)
  for (let i = 0; i < bgra.length; i += 4) {
    out[i] = bgra[i + 2]
    out[i + 1] = bgra[i + 1]
    out[i + 2] = bgra[i]
    out[i + 3] = bgra[i + 3]
  }
  return out
}
