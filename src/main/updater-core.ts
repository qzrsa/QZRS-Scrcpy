/**
 * 自更新的**纯逻辑**：清单自检、版本比较、目录校验、受保护路径判定。
 *
 * 刻意不碰 fs / 网络 / electron —— 于是这一层能被离线脚本穷举所有分支
 * （`.workbuddy/scripts/verify-updater.cjs` 就是直接 require 编译产物跑的）。
 * 真正的下载、落盘、进程切换在 updater.ts / updater-apply.ts 里。
 */

/** 更新清单里的一行文件记录 */
export interface ManifestFile {
  path: string
  size: number
  sha256: string
}

export interface UpdateManifest {
  schema: number
  app?: string
  channel?: string
  version: string
  /** 解压后总字节数（仅用于展示） */
  unpackedSize?: number
  /** 全量回退资产：绿色版 zip */
  full: { asset: string; size: number; sha256: string }
  /** 目标版本的权威文件清单（解包后逐文件校验） */
  files: ManifestFile[]
  /** Release 说明（可选，展示用） */
  notes?: string
}

/**
 * 程序目录里**属于用户**的顶层目录，更新器绝不读、不写、不删。
 *
 * 为什么这份名单在本文件（而不是 updater.ts）：清单自检、本机扫描、助手脚本
 * 三处都要用它，放在纯逻辑层可以保证"生成清单的脚本"和"应用更新的客户端"
 * 拿到的是同一份定义 —— 两边各写一份迟早漂移，而漂移的后果是更新器去覆盖
 * 用户的按键方案 / 脚本 / 下载好的 OCR 模型。
 *
 * - `keymaps`     用户按键方案（安装目录/keymaps，权限不足时回退到 userData）
 * - `scripts`     用户脚本与 waitImage 模板
 * - `logs`        调试日志
 * - `ocr-models`  用户下载的 OCR 模型（约 16MB，不在安装包里）
 * - `.update`     更新器自己的暂存区（下载中的 zip、apply.json、apply.log）
 */
export const PROTECTED_TOP: readonly string[] = [
  'keymaps',
  'scripts',
  'logs',
  'ocr-models',
  '.update'
]

/** 相对路径是否落在受保护顶层目录里（`/` 与 `\` 都认） */
export function isProtectedPath(rel: string): boolean {
  const norm = String(rel ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (!norm) return true
  const top = norm.split('/')[0]
  return PROTECTED_TOP.includes(top)
}

/**
 * 清单自检：形状不对就当"没有可用清单"，让上层退回"无更新"，
 * 而不是拿着半份清单去下载一个不存在的资产。
 */
export function validManifest(m: unknown): UpdateManifest | null {
  if (!m || typeof m !== 'object') return null
  const o = m as Partial<UpdateManifest>
  if (o.schema !== 1) return null
  if (typeof o.version !== 'string' || !o.version) return null
  if (!o.full || typeof o.full.asset !== 'string' || !o.full.asset) return null
  if (typeof o.full.sha256 !== 'string' || !o.full.sha256) return null
  if (!Array.isArray(o.files)) return null
  for (const f of o.files) {
    if (!f || typeof f.path !== 'string' || typeof f.sha256 !== 'string') return null
  }
  return o as UpdateManifest
}

function parseVer(v: unknown): [number, number, number] | null {
  const m = String(v ?? '').trim().match(/^(\d+)\.(\d+)\.(\d+)/)
  return m ? [+m[1], +m[2], +m[3]] : null
}

/**
 * 版本比较：只认 `1.2.3` 这种三段数字（本项目版本号规则），不引入 semver 依赖。
 *
 * ★ 解析不出来时一律返回 false（"不算新"）：误报"有更新"会让用户去下一个可能
 *   并不存在的资产、拿到莫名其妙的失败；漏报一次只是晚一天知道，代价小得多。
 */
export function isNewer(a: unknown, b: unknown): boolean {
  const pa = parseVer(a)
  const pb = parseVer(b)
  if (!pa || !pb) return false
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i]
  }
  return false
}

export interface Verdict {
  ok: boolean
  missing: string[]
  differ: string[]
  /** 本机多出来的文件（用户自己放的 / 旧版残留）。只报告，绝不删 */
  extra: string[]
  checked: number
}

/**
 * 校验一份"完整的程序目录"是否就是目标版本。
 *
 * 全量下载解包之后**必须**走这一步：只看 zip 的 hash 只能证明包没坏，
 * 证不了解出来的东西对不对（zip 有可能本身就被替换过，或者清单与包不配套）。
 */
export function verifyDir(manifest: UpdateManifest, files: ManifestFile[]): Verdict {
  const have = new Map(files.map((f) => [f.path, f]))
  const wantPaths = new Set<string>()
  const missing: string[] = []
  const differ: string[] = []
  for (const w of manifest.files) {
    wantPaths.add(w.path)
    const h = have.get(w.path)
    if (!h) {
      missing.push(w.path)
      continue
    }
    if (h.size !== w.size || h.sha256 !== w.sha256) differ.push(w.path)
  }
  const extra = [...have.keys()].filter((p) => !wantPaths.has(p))
  return { ok: missing.length === 0 && differ.length === 0, missing, differ, extra, checked: manifest.files.length }
}

/** 给界面/日志用的一句话摘要 */
export function summarize(manifest: UpdateManifest | null): string {
  if (!manifest) return '更新清单不可用'
  const full = manifest.full.size / 1048576
  return `v${manifest.version}｜全量 ${full.toFixed(1)} MiB｜文件 ${manifest.files.length} 个`
}

export function humanBytes(n: number): string {
  if (!(n >= 0)) return '—'
  if (n < 1024) return n + ' B'
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KiB'
  return (n / 1048576).toFixed(2) + ' MiB'
}
