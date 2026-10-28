import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as ort from 'onnxruntime-node'

/**
 * OCR 推理引擎（PaddleOCR ONNX，RapidOCR 预转换模型，纯 JS 后处理）。
 *
 * 与 onnxruntime-node 直接对接，跑在 Electron 主进程（onnxruntime-node 用 N-API，
 * Electron 可直接加载，无需 electron-rebuild）。模型文件由 ocrdownload.ts 从
 * GitHub Release 下载到本地模型目录，**不进安装包**。
 *
 * 管线（对齐 PaddleOCR/RapidOCR 标准实现）：
 *   1. det 文本检测：resize(32 倍数, 短边上限 960) → ImageNet 归一化 → DB 推理
 *      → heatmap 二值化 → 连通域 → 轴对齐 bbox + unclip 扩张 → 映射回原图坐标。
 *   2. cls 角度分类（可选）：每个框 crop → resize 48×192 → 归一化 → 二分类(0°/180°)，
 *      180° 时把 crop 旋转 180° 再识别。
 *   3. rec 文本识别：每个框 crop → resize 高 48（宽按比例，上限 320）→ (p/255-0.5)/0.5
 *      → CTC 推理 → 贪心解码（去重 + 去 blank）→ 字典映射。
 *
 * 坐标约定：recognize 的输入是位图，返回的 box 是**相对这张位图**的像素坐标；
 * 视频↔截屏的换算由 ipc.ts 负责。
 */

// ===== 检测参数（PaddleOCR DB 默认值）=====
const DET_LIMIT_SIDE = 960 // 短边上限（等比例缩放）
const DET_THRESH = 0.3 // 二值化阈值
const DET_BOX_THRESH = 0.3 // 框内置信度阈值（轴对齐 bbox 采样天然偏高，放宽）
const DET_MIN_SIZE = 3 // 短边最小像素
const DET_MIN_AREA = 12 // 最小连通域面积（滤噪点）
const DET_UNCLIP_RATIO = 1.5 // 扩张比例（抵消训练时 0.4 的 shrink）

// ===== 识别/分类参数 =====
const REC_IMG_H = 48
const REC_MAX_W = 320
const CLS_IMG_W = 192
const CLS_THRESH = 0.9 // cls 分类置信度阈值（低于则不判 180°，避免误翻转）

// ImageNet 归一化（det 用）
const DET_MEAN = [0.485, 0.456, 0.406]
const DET_STD = [0.229, 0.224, 0.225]

const DET_MODEL = 'ch_PP-OCRv4_det_mobile.onnx'
const REC_MODEL = 'ch_PP-OCRv4_rec_mobile.onnx'
const CLS_MODEL = 'ch_ppocr_mobile_v2.0_cls_mobile.onnx'
const KEYS_FILE = 'ppocr_keys_v1.txt'

export interface OcrLineBox {
  x: number
  y: number
  w: number
  h: number
}

export interface OcrLine {
  text: string
  score: number
  box: OcrLineBox
}

export interface OcrResult {
  /** 所有文本行按阅读顺序（自上而下）用 \n 拼接 */
  text: string
  lines: OcrLine[]
}

export interface DetBox {
  x0: number
  y0: number
  x1: number
  y1: number
  score: number
}

// ===== 图像工具（均为纯函数，BGRA 源 / RGB 中间态）=====

/** 双线性插值：BGRA 全图 → RGB（det 预处理直接一步到位，省一次全量 RGB 拷贝） */
function resizeBgraToRgb(src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  const out = new Uint8Array(dw * dh * 3)
  const sx = sw / dw
  const sy = sh / dh
  for (let y = 0; y < dh; y++) {
    const gy = y * sy
    const y0 = Math.floor(gy)
    const y1 = Math.min(sh - 1, y0 + 1)
    const fy = gy - y0
    for (let x = 0; x < dw; x++) {
      const gx = x * sx
      const x0 = Math.floor(gx)
      const x1 = Math.min(sw - 1, x0 + 1)
      const fx = gx - x0
      const o = (y * dw + x) * 3
      const i00 = (y0 * sw + x0) * 4
      const i01 = (y0 * sw + x1) * 4
      const i10 = (y1 * sw + x0) * 4
      const i11 = (y1 * sw + x1) * 4
      const w00 = (1 - fx) * (1 - fy)
      const w01 = fx * (1 - fy)
      const w10 = (1 - fx) * fy
      const w11 = fx * fy
      // 源是 BGRA：+2=R +1=G +0=B
      out[o] = src[i00 + 2] * w00 + src[i01 + 2] * w01 + src[i10 + 2] * w10 + src[i11 + 2] * w11
      out[o + 1] = src[i00 + 1] * w00 + src[i01 + 1] * w01 + src[i10 + 1] * w10 + src[i11 + 1] * w11
      out[o + 2] = src[i00] * w00 + src[i01] * w01 + src[i10] * w10 + src[i11] * w11
    }
  }
  return out
}

/** 从 BGRA 全图 crop 指定区域 → RGB（坐标自动 clamp 到图内） */
function cropBgraToRgb(
  src: Uint8Array,
  sw: number,
  sh: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): { rgb: Uint8Array; w: number; h: number } {
  const cx0 = Math.max(0, Math.floor(x0))
  const cy0 = Math.max(0, Math.floor(y0))
  const cx1 = Math.min(sw - 1, Math.ceil(x1))
  const cy1 = Math.min(sh - 1, Math.ceil(y1))
  const cw = Math.max(1, cx1 - cx0 + 1)
  const ch = Math.max(1, cy1 - cy0 + 1)
  const out = new Uint8Array(cw * ch * 3)
  for (let y = cy0; y <= cy1; y++) {
    const rowSrc = y * sw
    const rowDst = (y - cy0) * cw
    for (let x = cx0; x <= cx1; x++) {
      const si = (rowSrc + x) * 4
      const di = (rowDst + (x - cx0)) * 3
      out[di] = src[si + 2]
      out[di + 1] = src[si + 1]
      out[di + 2] = src[si]
    }
  }
  return { rgb: out, w: cw, h: ch }
}

/** 双线性插值：RGB → RGB */
function resizeRgb(rgb: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  if (sw === dw && sh === dh) return rgb
  const out = new Uint8Array(dw * dh * 3)
  const sx = sw / dw
  const sy = sh / dh
  for (let y = 0; y < dh; y++) {
    const gy = y * sy
    const y0 = Math.floor(gy)
    const y1 = Math.min(sh - 1, y0 + 1)
    const fy = gy - y0
    for (let x = 0; x < dw; x++) {
      const gx = x * sx
      const x0 = Math.floor(gx)
      const x1 = Math.min(sw - 1, x0 + 1)
      const fx = gx - x0
      const o = (y * dw + x) * 3
      const i00 = (y0 * sw + x0) * 3
      const i01 = (y0 * sw + x1) * 3
      const i10 = (y1 * sw + x0) * 3
      const i11 = (y1 * sw + x1) * 3
      const w00 = (1 - fx) * (1 - fy)
      const w01 = fx * (1 - fy)
      const w10 = (1 - fx) * fy
      const w11 = fx * fy
      for (let c = 0; c < 3; c++) {
        out[o + c] = rgb[i00 + c] * w00 + rgb[i01 + c] * w01 + rgb[i10 + c] * w10 + rgb[i11 + c] * w11
      }
    }
  }
  return out
}

/** 180° 旋转（水平 + 垂直同时翻转）RGB 图 */
function rotate180(rgb: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(rgb.length)
  const stride = w * 3
  for (let y = 0; y < h; y++) {
    const sy = (h - 1 - y) * stride
    const dy = y * stride
    for (let x = 0; x < w; x++) {
      const si = sy + (w - 1 - x) * 3
      const di = dy + x * 3
      out[di] = rgb[si]
      out[di + 1] = rgb[si + 1]
      out[di + 2] = rgb[si + 2]
    }
  }
  return out
}

/** RGB → NCHW float32 + 归一化（通用：normalize(rgb, w, h, mean, std, planeStride, padW)） */
function rgbToNchw(
  rgb: Uint8Array,
  w: number,
  h: number,
  mean: number[],
  std: number[],
  outW: number
): Float32Array {
  const data = new Float32Array(3 * h * outW) // 默认 0 填充（pad 区域 = 0）
  for (let c = 0; c < 3; c++) {
    const m = mean[c]
    const s = std[c]
    const plane = c * h * outW
    for (let y = 0; y < h; y++) {
      const base = y * outW
      for (let x = 0; x < w; x++) {
        data[plane + base + x] = (rgb[(y * w + x) * 3 + c] / 255 - m) / s
      }
    }
  }
  return data
}

// ===== OCR 引擎 =====

export class OcrEngine {
  private det: ort.InferenceSession | null = null
  private rec: ort.InferenceSession | null = null
  private cls: ort.InferenceSession | null = null
  private keys: string[] | null = null
  private loading: Promise<void> | null = null
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly modelDir: string) {}

  /** 是否已具备全部模型文件（供 ipc 提前判断，避免无模型时报加载错误） */
  get ready(): boolean {
    return [DET_MODEL, REC_MODEL, CLS_MODEL, KEYS_FILE].every((f) => {
      try {
        return readFileSync(join(this.modelDir, f)).length > 0
      } catch {
        return false
      }
    })
  }

  /** 懒加载全部模型（只跑一次，串行化，失败可重试） */
  private async ensureLoaded(): Promise<void> {
    if (this.det && this.rec && this.cls && this.keys) return
    if (this.loading) return this.loading
    this.loading = (async () => {
      const missing = [DET_MODEL, REC_MODEL, CLS_MODEL, KEYS_FILE].filter((f) => {
        try {
          return readFileSync(join(this.modelDir, f)).length === 0
        } catch {
          return true
        }
      })
      if (missing.length > 0) {
        throw new Error(`OCR 模型未下载（缺 ${missing.join('、')}），请在「设置 → OCR 模型」里先下载`)
      }
      this.det = await ort.InferenceSession.create(join(this.modelDir, DET_MODEL))
      this.rec = await ort.InferenceSession.create(join(this.modelDir, REC_MODEL))
      this.cls = await ort.InferenceSession.create(join(this.modelDir, CLS_MODEL))
      this.keys = readFileSync(join(this.modelDir, KEYS_FILE), 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.length > 0)
    })()
    try {
      await this.loading
    } finally {
      this.loading = null
    }
  }

  /** 串行化 recognize（onnxruntime session 虽线程安全，但预处理/后处理串行更省内存峰值） */
  recognize(bgra: Uint8Array, width: number, height: number): Promise<OcrResult> {
    const run = (): Promise<OcrResult> => this.recognizeInner(bgra, width, height)
    const p = this.chain.then(run, run)
    this.chain = p.then(
      () => undefined,
      () => undefined
    )
    return p
  }

  private async recognizeInner(bgra: Uint8Array, width: number, height: number): Promise<OcrResult> {
    await this.ensureLoaded()
    const det = this.det!
    const rec = this.rec!
    const cls = this.cls!
    const keys = this.keys!
    if (width <= 0 || height <= 0) return { text: '', lines: [] }

    // 1. 检测
    const detInput = this.detPreprocess(bgra, width, height)
    const detFeed: ort.InferenceSession.FeedsType = {
      [det.inputNames[0]]: new ort.Tensor('float32', detInput.data, [1, 3, detInput.dh, detInput.dw])
    }
    const detRes = await det.run(detFeed)
    const heat = detRes[det.outputNames[0]].data as Float32Array
    const boxes = this.detPostprocess(heat, detInput.dh, detInput.dw, detInput.ratioW, detInput.ratioH)

    // 2. 逐框分类 + 识别
    const lines: OcrLine[] = []
    for (const b of boxes) {
      const crop = cropBgraToRgb(bgra, width, height, b.x0, b.y0, b.x1, b.y1)
      if (crop.w < 2 || crop.h < 2) continue
      let rgb = crop.rgb
      let cw = crop.w
      let ch = crop.h

      // 角度分类（180° 翻转纠正）
      const clsInput = rgbToNchw(resizeRgb(rgb, cw, ch, CLS_IMG_W, REC_IMG_H), CLS_IMG_W, REC_IMG_H, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5], CLS_IMG_W)
      const clsFeed: ort.InferenceSession.FeedsType = {
        [cls.inputNames[0]]: new ort.Tensor('float32', clsInput, [1, 3, REC_IMG_H, CLS_IMG_W])
      }
      const clsRes = await cls.run(clsFeed)
      const clsOut = clsRes[cls.outputNames[0]].data as Float32Array
      const cls0 = clsOut[0]
      const cls1 = clsOut[1]
      const is180 = cls1 > cls0 && cls1 > CLS_THRESH
      if (is180) {
        rgb = rotate180(rgb, cw, ch)
      }

      // 识别
      const ratio = cw / ch
      let recW = Math.ceil(REC_IMG_H * ratio)
      if (recW > REC_MAX_W) recW = REC_MAX_W
      const recRgb = resizeRgb(rgb, cw, ch, recW, REC_IMG_H)
      const recInput = rgbToNchw(recRgb, recW, REC_IMG_H, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5], REC_MAX_W)
      const recFeed: ort.InferenceSession.FeedsType = {
        [rec.inputNames[0]]: new ort.Tensor('float32', recInput, [1, 3, REC_IMG_H, REC_MAX_W])
      }
      const recRes = await rec.run(recFeed)
      const logits = recRes[rec.outputNames[0]].data as Float32Array
      const numClasses = recRes[rec.outputNames[0]].dims[2]
      const T = recRes[rec.outputNames[0]].dims[1]
      const decoded = ctcDecode(logits, T, numClasses, keys)
      if (!decoded.text) continue

      lines.push({
        text: decoded.text,
        score: b.score * decoded.score,
        box: {
          x: Math.round(Math.min(b.x0, b.x1)),
          y: Math.round(Math.min(b.y0, b.y1)),
          w: Math.round(Math.abs(b.x1 - b.x0)),
          h: Math.round(Math.abs(b.y1 - b.y0))
        }
      })
    }

    // 3. 按 y（再按 x）排序，自上而下阅读顺序
    lines.sort((a, b) => (a.box.y !== b.box.y ? a.box.y - b.box.y : a.box.x - b.box.x))
    const text = lines.map((l) => l.text).join('\n')
    return { text, lines }
  }

  /** det 预处理：算 resize 尺寸 + resize(BGRA→RGB) + ImageNet 归一化 NCHW */
  private detPreprocess(
    bgra: Uint8Array,
    sw: number,
    sh: number
  ): { data: Float32Array; dw: number; dh: number; ratioW: number; ratioH: number } {
    let ratio = 1
    if (Math.max(sw, sh) > DET_LIMIT_SIDE) ratio = DET_LIMIT_SIDE / Math.max(sw, sh)
    let dh = Math.max(32, Math.round((sh * ratio) / 32) * 32)
    let dw = Math.max(32, Math.round((sw * ratio) / 32) * 32)
    const rgb = resizeBgraToRgb(bgra, sw, sh, dw, dh)
    const data = rgbToNchw(rgb, dw, dh, DET_MEAN, DET_STD, dw)
    return { data, dw, dh, ratioW: dw / sw, ratioH: dh / sh }
  }

  /** det 后处理：二值化 → 连通域 → 轴对齐 bbox + unclip → 映射回原图 */
  private detPostprocess(
    heat: Float32Array,
    h: number,
    w: number,
    ratioW: number,
    ratioH: number
  ): DetBox[] {
    const n = w * h
    const label = new Int32Array(n).fill(-1)
    const boxes: DetBox[] = []

    for (let start = 0; start < n; start++) {
      if (heat[start] <= DET_THRESH || label[start] >= 0) continue
      // BFS 8 连通
      const queue: number[] = [start]
      label[start] = 0
      let minX = w
      let maxX = -1
      let minY = h
      let maxY = -1
      let area = 0
      let head = 0
      while (head < queue.length) {
        const idx = queue[head++]
        const x = idx % w
        const y = (idx / w) | 0
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
        area++
        const xm1 = x > 0
        const xp1 = x < w - 1
        const ym1 = y > 0
        const yp1 = y < h - 1
        const neighbors = [
          xm1 ? idx - 1 : -1,
          xp1 ? idx + 1 : -1,
          ym1 ? idx - w : -1,
          yp1 ? idx + w : -1,
          xm1 && ym1 ? idx - w - 1 : -1,
          xp1 && ym1 ? idx - w + 1 : -1,
          xm1 && yp1 ? idx + w - 1 : -1,
          xp1 && yp1 ? idx + w + 1 : -1
        ]
        for (const ni of neighbors) {
          if (ni >= 0 && label[ni] < 0 && heat[ni] > DET_THRESH) {
            label[ni] = 0
            queue.push(ni)
          }
        }
      }

      const bw = maxX - minX + 1
      const bh = maxY - minY + 1
      if (Math.min(bw, bh) < DET_MIN_SIZE || area < DET_MIN_AREA) continue

      // 框内置信度（轴对齐 bbox 均值）
      let sum = 0
      for (let y = minY; y <= maxY; y++) {
        const row = y * w
        for (let x = minX; x <= maxX; x++) sum += heat[row + x]
      }
      const score = sum / area
      if (score < DET_BOX_THRESH) continue

      // unclip 扩张（distance = area * ratio / perimeter，对齐 pyclipper offset）
      const perimeter = 2 * (bw + bh)
      const distance = (area * DET_UNCLIP_RATIO) / perimeter
      const ux0 = minX - distance
      const uy0 = minY - distance
      const ux1 = maxX + distance
      const uy1 = maxY + distance

      boxes.push({
        x0: ux0 / ratioW,
        y0: uy0 / ratioH,
        x1: ux1 / ratioW,
        y1: uy1 / ratioH,
        score
      })
    }
    return boxes
  }
}

/** CTC 贪心解码：argmax → 去重（折叠连续相同）→ 去 blank(class 0) → 字典映射 */
export function ctcDecode(logits: Float32Array, T: number, numClasses: number, keys: string[]): { text: string; score: number } {
  let text = ''
  let prev = -1
  let sum = 0
  for (let t = 0; t < T; t++) {
    const base = t * numClasses
    let maxIdx = 0
    let maxVal = logits[base]
    for (let c = 1; c < numClasses; c++) {
      const v = logits[base + c]
      if (v > maxVal) {
        maxVal = v
        maxIdx = c
      }
    }
    sum += maxVal
    if (maxIdx > 0 && maxIdx !== prev) {
      const ch = keys[maxIdx - 1]
      if (ch) text += ch
    }
    prev = maxIdx
  }
  return { text, score: T > 0 ? sum / T : 0 }
}
