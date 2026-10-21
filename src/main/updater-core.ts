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
  /**
   * 可选：相对**某个旧版本**的差量包（一个旧版本一条）。
   * 客户端按自己正在跑的版本去挑；挑不到 / 校验不过 / 不划算就走全量。
   * ★ 差量失败**绝不能**让更新失败 —— 它只是"省流量"的优化，全量永远是兜底。
   */
  patches?: ManifestPatch[]
  /** Release 说明（可选，展示用） */
  notes?: string
}

/* ---------------------------------------------------------------- 差量 */

/**
 * 差量指令：统一 4 元组，**长度恒在 index 3**。
 *   `[0, oldIdx, start, len]` 从旧文件列表第 oldIdx 个文件的 start 处拷 len 字节
 *   `[1, packOffset, 0, len]` 从补丁包 packOffset 处取 len 字节
 * （定义与 `vcdiff.mjs` 的 makeDirPatch 一一对应；那边是唯一实现，这里只是类型）
 */
export type DeltaOp = [number, number, number, number]

export interface DeltaPlanFile extends ManifestFile {
  action: 'same' | 'patch'
  /** action==='patch' 时才有 */
  ops?: DeltaOp[] | number[][]
}

/** 生成端（`vcdiff.mjs` 的 makeDirPatch）产出的差量清单，内联进 update.json */
export interface DeltaPlan {
  version: number
  /** 基准版本（旧）的文件列表；客户端要逐个核对本机字节 */
  olds: ManifestFile[]
  /** 目标版本的文件列表（action==='same' 的不需要写盘） */
  files: DeltaPlanFile[]
  /** 新版本已经没有的文件（来自旧版本清单，用户自己放的文件永远不会进来） */
  removed: string[]
  pack: { size: number; sha256: string }
}

export interface ManifestPatch {
  /** 基准版本号：必须等于客户端正在跑的版本才用 */
  from: string
  /** 补丁包资产名（.bin） */
  asset: string
  size: number
  sha256: string
  /** 生成时算出的"差量/全量"比例（仅展示） */
  ratio?: number
  plan: DeltaPlan
}

/**
 * 走差量的门槛：补丁包不得超过全量包的 60%。
 *
 * ★ 判据是**占比**而不是"文件大不大"：实测里 180 MB 的 exe 两版之间只差
 *   VERSIONINFO 里几个字节，块级差量能把它压到几十 KiB。反过来，如果一次改动
 *   把 app.asar 大半都换了，差量包可能比全量还大 —— 那种情况老实下全量更省。
 */
export const DELTA_LIMIT = 0.6

function isManifestFile(f: unknown): f is ManifestFile {
  const o = f as ManifestFile
  return !!o && typeof o.path === 'string' && !!o.path && typeof o.sha256 === 'string' && !!o.sha256
}

function validPatch(p: unknown): p is ManifestPatch {
  const o = p as ManifestPatch
  if (!o || typeof o !== 'object') return false
  if (typeof o.from !== 'string' || !o.from) return false
  if (typeof o.asset !== 'string' || !o.asset) return false
  if (typeof o.sha256 !== 'string' || !o.sha256) return false
  if (typeof o.size !== 'number' || !(o.size >= 0)) return false
  const pl = o.plan as DeltaPlan | undefined
  if (!pl || typeof pl !== 'object' || pl.version !== 1) return false
  if (!Array.isArray(pl.olds) || !pl.olds.every(isManifestFile)) return false
  if (!Array.isArray(pl.files) || !pl.files.every(isManifestFile)) return false
  if (!pl.pack || typeof pl.pack.sha256 !== 'string' || !pl.pack.sha256) return false
  for (const f of pl.files) {
    if (f.action === 'patch' && !Array.isArray(f.ops)) return false
  }
  if (pl.removed !== undefined && !Array.isArray(pl.removed)) return false
  return true
}

/** 按"我正在跑的版本"挑一条差量。挑不到返回 null（→ 走全量） */
export function pickPatch(m: UpdateManifest | null, from: string): ManifestPatch | null {
  if (!m || !Array.isArray(m.patches) || !from) return null
  return m.patches.find((p) => p.from === from) ?? null
}

/**
 * 差量值不值得走。除了占比门槛，还挡掉"省不到 1 MiB"的边角情况 ——
 * 那种情况多一次下载 + 一次还原，只会多一个出错的机会。
 */
export function deltaWorthIt(p: ManifestPatch | null, fullSize: number, limit = DELTA_LIMIT): boolean {
  if (!p) return false
  const pack = Number(p.size) || 0
  const full = Number(fullSize) || 0
  if (!(full > 0) || !(pack > 0)) return false
  if (full - pack < 1048576) return false
  return pack / full <= limit
}

/**
 * 差量路径要删掉的文件（新版本已经没有的那些）。
 * ★ 这里**故意不过滤**受保护路径：让 writeApply 撞上它并整轮中止，
 *   比悄悄少删一个文件更能暴露"清单被污染了"。
 */
export function removalList(p: ManifestPatch): string[] {
  const r = p?.plan?.removed
  return Array.isArray(r) ? r.slice() : []
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
  // ★ 差量是**可选增强**：坏掉的 patches 只丢差量，不能让整份清单作废
  //   —— 否则发布端一次手误就会让所有人连"有没有新版本"都查不出来。
  const patches = Array.isArray(o.patches) ? o.patches.filter(validPatch) : []
  return { ...(o as UpdateManifest), patches }
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
