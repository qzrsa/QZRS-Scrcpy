import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'

/**
 * OCR 模型资产清单与本地管理（PaddleOCR ONNX，RapidOCR 预转换，Apache-2.0）。
 *
 * 分发策略：**模型不进安装包**——安装包只带这份清单，用户在设置里点「下载」后
 * 从 GitHub Release（后续可加国内网盘手动下载）拉到本地模型目录。
 * 清单里带 SHA256（det/rec/cls 来自 RapidOCR 官方 default_models.yaml，
 * keys 字典用本地副本计算值），下载后逐文件校验，不匹配即删重下。
 *
 * 本地模型目录（固定路径，绿色版随目录走）：
 * 1. `<安装目录>/ocr-models/`（首选）
 * 2. `<userData>/data/ocr-models/`（安装目录不可写时回退，如 Program Files 无管理员权限）
 */

export interface OcrModelEntry {
  file: string
  /** 期望字节数（下载前用于快速完整性预判） */
  size: number
  /** 期望 SHA256（hex）；缺省 = 只校验大小 */
  sha256: string
}

/** RapidOCR v3.9.2 onnxruntime 段 default 模型（ch，mobile） */
export const OCR_MODELS: OcrModelEntry[] = [
  { file: 'ch_PP-OCRv4_det_mobile.onnx', size: 4745517, sha256: 'd2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9' },
  { file: 'ch_PP-OCRv4_rec_mobile.onnx', size: 10857958, sha256: '48fc40f24f6d2a207a2b1091d3437eb3cc3eb6b676dc3ef9c37384005483683b' },
  { file: 'ch_ppocr_mobile_v2.0_cls_mobile.onnx', size: 585532, sha256: 'e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c' },
  { file: 'ppocr_keys_v1.txt', size: 26249, sha256: '28b2362ad4ab2dc38769aa72feb535e3a9ddb3fd2a7585a05920e6393b1dc7f7' }
]

/** OCR 清单版本（模型升级时 bump，同时更新上面的表与 Release 资产） */
export const OCR_MODEL_VERSION = 'v1'
/**
 * 默认下载源：GitHub Release 散文件资产（{file} 占位替换为文件名）。
 * 散文件而非 zip：每个模型可单独校验、单独重试，也不用引解压依赖。
 */
export const OCR_GITHUB_URL_TEMPLATE = `https://github.com/qzrsa/QZRS-Scrcpy/releases/download/ocr-models-${OCR_MODEL_VERSION}/{file}`
/** 手动下载页（国内网盘）；空串 = 设置面板不显示「手动下载」入口。后续由维护者填写。 */
export const OCR_MANUAL_URL = ''

export interface OcrModelStatus {
  version: string
  /** 模型目录实际路径 */
  dir: string
  /** 全部就绪（每个文件存在 + 大小匹配 + sha256 匹配） */
  ready: boolean
  /** 逐文件状态（设置面板展示哪个缺/哪个坏） */
  files: { file: string; present: boolean; ok: boolean; size: number }[]
}

/** 逐文件流式算 SHA256（10MB 模型不至于占内存） */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    const s = createReadStream(path)
    s.on('data', (c) => h.update(c))
    s.on('end', () => resolve(h.digest('hex')))
    s.on('error', reject)
  })
}

/** 解析模型目录：首选安装目录，探测失败回退 userData（与 keymaps/scripts 同策略） */
export function resolveOcrModelDir(): string {
  const installRoot = app.isPackaged ? dirname(process.resourcesPath) : app.getAppPath()
  const candidates = [join(installRoot, 'ocr-models'), join(app.getPath('userData'), 'data', 'ocr-models')]
  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true })
      const probe = join(dir, '.write-test')
      writeFileSync(probe, '1')
      unlinkSync(probe)
      return dir
    } catch {
      /* 试下一个候选 */
    }
  }
  return candidates[candidates.length - 1]
}

/** 校验单个文件：存在 + 大小 + sha256（坏返回 false，供重下） */
export async function verifyModelFile(dir: string, m: OcrModelEntry): Promise<boolean> {
  const p = join(dir, m.file)
  if (!existsSync(p)) return false
  try {
    if (statSync(p).size !== m.size) return false
    if (!m.sha256) return true
    return (await sha256File(p)) === m.sha256
  } catch {
    return false
  }
}

/** 全量状态（设置面板 + 下载器判断是否需要下载） */
export async function ocrStatus(): Promise<OcrModelStatus> {
  const dir = resolveOcrModelDir()
  const files: OcrModelStatus['files'] = []
  let ready = true
  for (const m of OCR_MODELS) {
    const present = existsSync(join(dir, m.file))
    const ok = present ? await verifyModelFile(dir, m) : false
    if (!ok) ready = false
    let size = 0
    try {
      size = statSync(join(dir, m.file)).size
    } catch {
      /* 缺文件 */
    }
    files.push({ file: m.file, present, ok, size })
  }
  return { version: OCR_MODEL_VERSION, dir, ready, files }
}
