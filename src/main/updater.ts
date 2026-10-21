import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  type Dirent
} from 'node:fs'
import { get as nodeHttpGet } from 'node:http'
import { get as nodeHttpsGet } from 'node:https'
import { dirname, join } from 'node:path'
import { PROTECTED_TOP, isNewer, isProtectedPath, validManifest, verifyDir, type ManifestFile, type UpdateManifest } from './updater-core'
import { readZip } from './zipread'

/* ------------------------------------------------------------------ 常量 */

export const REPO = { owner: 'qzrsa', repo: 'QZRS-Scrcpy' } as const

/**
 * 暂存目录名（放在程序目录下）。
 * ★ 已进 PROTECTED_TOP —— 于是"扫描本机 / 生成清单 / 更新器自己删除"三处会同时排除它。
 */
export const STAGE_DIR = '.update'

export const MANIFEST_ASSET = 'update.json'
const USER_AGENT = 'QZRS-Scrcpy-Updater'

/** 清单最大 8 MiB：正常只有几十到几百 KB（每个文件一行 sha256），给足余量又能挡住被喂垃圾 */
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024

/** 跟随重定向上限。GitHub 的 release 资产一定会 302 到 objects.githubusercontent.com。 */
const MAX_REDIRECTS = 5

export const DEFAULT_BASE = `https://github.com/${REPO.owner}/${REPO.repo}/releases/latest/download`

/* ------------------------------------------------------------------ 小工具 */

const sha256hex = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')

/**
 * 临时关掉 Electron 的 asar 补丁。
 *
 * 打包后 `require('fs')` 是被 Electron 改过的：路径里出现 `xxx.asar` 就会被当成
 * 存档去解析 —— 对 `resources/app.asar` 来说后果是"读不到"和"statSync 把 size
 * 谎报成 0"（静默给错值，比抛错更坏，会让"本机已是最新"的判断永远失败）。
 * 更新器要把它当**普通大文件**读写，所以这两类操作都得关补丁。
 * 纯 Node 下没有这个补丁，所以这条只有打包后真跑才看得见。
 */
function withoutAsar<T>(fn: () => T): T {
  const p = process as unknown as { noAsar?: boolean }
  const prev = p.noAsar
  p.noAsar = true
  try {
    return fn()
  } finally {
    p.noAsar = prev
  }
}

/** 流式算文件 sha256（1 MiB 缓冲：245 MB 的 exe 也不会占内存） */
export function sha256File(path: string): string {
  return withoutAsar(() => {
    const h = createHash('sha256')
    const fd = openSync(path, 'r')
    try {
      const BUF = 1 << 20
      const b = Buffer.allocUnsafe(BUF)
      let n: number
      while ((n = readSync(fd, b, 0, BUF, null)) > 0) h.update(b.subarray(0, n))
    } finally {
      closeSync(fd)
    }
    return h.digest('hex')
  })
}

/**
 * 归一化更新源。
 * 默认是 GitHub 的 `releases/latest/download` —— 它会把请求 302 到最新 Release 的资产。
 * ★ 允许换镜像/代理：本机实测国内直连 GitHub 资产常常断流，而"更新器只能用某个
 *   镜像"是最容易被忽略的失败原因，所以做成显式配置项。填了非法值就**报错**，
 *   绝不静默回落成默认源（那会让用户以为镜像生效了）。
 */
export function normalizeBase(raw: unknown): string {
  const s = String(raw ?? '').trim()
  if (!s) return DEFAULT_BASE
  if (!/^https?:\/\//i.test(s)) throw new Error('更新源必须是 http(s):// 开头的地址')
  return s.replace(/\/+$/, '')
}

export const feedUrl = (base: string): string => normalizeBase(base) + '/' + MANIFEST_ASSET

/* ------------------------------------------------------------------ 传输层 */

export interface GetOpts {
  /** 传路径就"边收边写盘"并返回 {path,size,total}；不传返回 Buffer */
  destPath?: string | null
  onChunk?: (got: number, total: number) => void
  maxBytes?: number
  timeout?: number
}

/**
 * 带进度、带上限、跟随重定向的 GET。
 *
 * ★ `destPath` 必须一路透传到底 —— 曾经在类似实现里写死成"永远不落盘"，
 *   结果调用方紧接着 statSync 就 ENOENT，界面报"下载后读不到文件"，
 *   而那个"已下好的字节数"其实只是内存 Buffer 的大小。
 */
export function httpGet(url: string, opts: GetOpts = {}): Promise<Buffer | { path: string; size: number; total: number }> {
  return httpGetTo(url, opts.destPath ?? null, opts, 0)
}

function httpGetTo(
  url: string,
  destPath: string | null,
  opts: GetOpts,
  redirects: number
): Promise<Buffer | { path: string; size: number; total: number }> {
  return new Promise((resolve, reject) => {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      reject(new Error('更新源地址不合法: ' + url))
      return
    }
    const mod = u.protocol === 'http:' ? nodeHttpGet : nodeHttpsGet
    const req = mod(u, { headers: { 'User-Agent': USER_AGENT, Accept: '*/*' } }, (res) => {
      const code = res.statusCode ?? 0

      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume()
        if (redirects >= MAX_REDIRECTS) {
          reject(new Error('重定向次数过多: ' + url))
          return
        }
        const next = new URL(res.headers.location, u).toString()
        httpGetTo(next, destPath, opts, redirects + 1).then(resolve, reject)
        return
      }
      if (code !== 200) {
        res.resume()
        const e = Object.assign(new Error(`HTTP ${code}`), { status: code })
        reject(e)
        return
      }

      const total = Number(res.headers['content-length']) || 0
      const max = opts.maxBytes ?? 0
      if (max && total > max) {
        res.resume()
        reject(new Error(`响应过大（${total} 字节）`))
        return
      }

      let fd: number | null = null
      let chunks: Buffer[] | null = null
      let got = 0
      try {
        if (destPath) fd = openSync(destPath, 'w')
        else chunks = []
      } catch (e) {
        res.resume()
        reject(e as Error)
        return
      }

      const fail = (e: Error): void => {
        res.destroy()
        if (fd !== null) {
          try {
            closeSync(fd)
          } catch {
            /* noop */
          }
          fd = null
        }
        reject(e)
      }

      res.on('data', (c: Buffer) => {
        got += c.length
        if (max && got > max) {
          fail(new Error(`响应过大（超过 ${max} 字节）`))
          return
        }
        if (fd !== null) {
          try {
            // 直接写文件：不用 createWriteStream，避免 backpressure 与 close 时序
            writeSyncAll(fd, c)
          } catch (e) {
            fail(e as Error)
          }
        } else chunks?.push(c)
        if (opts.onChunk) {
          try {
            opts.onChunk(got, total)
          } catch {
            /* 进度回调不许搞崩下载 */
          }
        }
      })
      res.on('end', () => {
        if (fd !== null) {
          try {
            closeSync(fd)
          } catch {
            /* noop */
          }
          resolve({ path: destPath as string, size: got, total })
        } else {
          resolve(Buffer.concat(chunks ?? [], got))
        }
      })
      res.on('error', fail)
    })
    req.on('error', reject)
    if (opts.timeout) req.setTimeout(opts.timeout, () => req.destroy(new Error('请求超时')))
  })
}

/** 一次 writeSync 可能只写一部分（大 Buffer 时），这里保证写完 */
function writeSyncAll(fd: number, buf: Buffer): void {
  let off = 0
  while (off < buf.length) {
    const n = writeSync(fd, buf, off)
    if (n <= 0) throw new Error('写盘失败')
    off += n
  }
}

async function getJson(url: string, opts: GetOpts = {}): Promise<unknown> {
  const buf = (await httpGet(url, { ...opts, maxBytes: opts.maxBytes ?? MAX_MANIFEST_BYTES })) as Buffer
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch (e) {
    throw new Error('更新清单不是合法 JSON: ' + (e as Error).message)
  }
}

/* ------------------------------------------------------------------ 本机扫描 */

/**
 * 扫"本机程序目录"，产出与清单 files 同构的记录。
 *
 * ★ 受保护目录（keymaps / scripts / logs / ocr-models / .update）**整棵跳过**：
 *   它们一旦进了清单，更新器就会把用户私人数据当程序文件去校验/覆盖。
 * ★ 代价要说清楚：这一步会把整个程序目录读一遍算 sha256（约 370 MB，一两秒）。
 *   所以只在"用户点了下载"之后才调用 —— 启动时的检查不能为此变慢。
 */
export function scanDir(dir: string): ManifestFile[] {
  const out: ManifestFile[] = []
  const walk = (abs: string, rel: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!rel && PROTECTED_TOP.includes(e.name)) continue
      const childRel = rel ? rel + '/' + e.name : e.name
      const childAbs = join(abs, e.name)
      if (e.isDirectory()) {
        walk(childAbs, childRel)
        continue
      }
      if (!e.isFile()) continue // 符号链接 / 设备文件一概不碰
      let st
      try {
        st = withoutAsar(() => statSync(childAbs))
      } catch {
        continue
      }
      out.push({ path: childRel, size: st.size, sha256: sha256File(childAbs) })
    }
  }
  walk(dir, '')
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return out
}

/* ------------------------------------------------------------------ 检查更新 */

export interface CheckResult {
  ok: boolean
  available: boolean
  reason: string
  myVersion: string
  manifest?: UpdateManifest
  base?: string
}

export async function check(o: { myVersion: string; base?: unknown }): Promise<CheckResult> {
  const myVersion = o.myVersion
  const base = normalizeBase(o.base)

  let raw: unknown
  try {
    raw = await getJson(feedUrl(base), { timeout: 30000 })
  } catch (e) {
    const err = e as Error & { status?: number }
    // ★ 404 是**预期内**的正常情况：更新器刚上线时，历史 Release 上根本没有 update.json。
    //   当成"没有可用更新"而不是错误 —— 否则用户一启动就看到红色报错。
    if (err.status === 404) return { ok: true, available: false, myVersion, reason: '更新源还没有发布更新清单' }
    return { ok: false, available: false, myVersion, reason: '取更新清单失败：' + err.message }
  }

  const m = validManifest(raw)
  if (!m) return { ok: false, available: false, myVersion, reason: '更新清单格式不认识（可能更新源不是本程序的）' }

  if (m.app && m.app !== 'QZRS Scrcpy') {
    return { ok: true, available: false, myVersion, reason: `清单属于 ${m.app}，与本程序不符` }
  }
  if (!isNewer(m.version, myVersion)) {
    return { ok: true, available: false, myVersion, manifest: m, reason: '已是最新版本' }
  }
  return { ok: true, available: true, myVersion, manifest: m, base, reason: `发现 v${m.version}` }
}

/* ------------------------------------------------------------------ 下载 */

export async function downloadAsset(o: {
  base: string
  asset: string
  size: number
  sha256: string
  dest: string
  onChunk?: (got: number, total: number) => void
  timeout?: number
}): Promise<{ ok: boolean; path?: string; reason?: string }> {
  const url = o.base + '/' + encodeURIComponent(o.asset)
  try {
    await httpGet(url, {
      destPath: o.dest,
      onChunk: o.onChunk,
      timeout: o.timeout ?? 120000,
      // 给 8 MiB 余量：声明的大小是权威，但传输层多收一点不该直接崩
      maxBytes: o.size ? o.size + 8 * 1024 * 1024 : 0
    })
  } catch (e) {
    try {
      unlinkSync(o.dest)
    } catch {
      /* noop */
    }
    return { ok: false, reason: `下载 ${o.asset} 失败：${(e as Error).message}` }
  }

  let st
  try {
    st = statSync(o.dest)
  } catch (e) {
    return { ok: false, reason: '下载后读不到文件：' + (e as Error).message }
  }
  if (o.size && st.size !== o.size) {
    try {
      unlinkSync(o.dest)
    } catch {
      /* noop */
    }
    return { ok: false, reason: `${o.asset} 大小不符（期望 ${o.size}，实际 ${st.size}）` }
  }
  if (o.sha256) {
    const got = sha256File(o.dest)
    if (got !== o.sha256) {
      try {
        unlinkSync(o.dest)
      } catch {
        /* noop */
      }
      return { ok: false, reason: `${o.asset} 校验失败（sha256 不符），已丢弃` }
    }
  }
  return { ok: true, path: o.dest }
}

/* ------------------------------------------------------------------ 暂存 */

export function stageDirOf(programDir: string, version: string): string {
  return join(programDir, STAGE_DIR, String(version))
}

export function stageRootOf(programDir: string): string {
  return join(programDir, STAGE_DIR)
}

export function dropStage(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 删不掉也不能盖住原始原因 */
  }
}

export interface ApplyPlan {
  schema: number
  app: string
  from: string
  to: string
  programDir: string
  stageDir: string
  exe: string
  restart: boolean
  mode: 'full'
  protectedTop: string[]
  writes: { path: string; size: number; sha256: string }[]
  deletes: string[]
}

/**
 * ★ 唯一写 apply.json / state.json 的地方。
 *   受保护路径的最后一道闸也在这里，所以不可能有哪条路绕过去
 *   （stageFull 前面还会先挡一次，避免白写几百 MB 再拒绝）。
 */
function writeApply(o: {
  programDir: string
  exePath: string
  myVersion: string
  version: string
  stage: string
  writes: ManifestFile[]
  deletes: string[]
  restart: boolean
}): { ok: boolean; reason?: string; stage?: string; plan?: ApplyPlan } {
  const bad = o.writes.map((w) => w.path).concat(o.deletes).filter(isProtectedPath)
  if (bad.length) return { ok: false, reason: `更新涉及受保护路径，已中止：${bad.slice(0, 3).join(', ')}` }

  const apply: ApplyPlan = {
    schema: 1,
    app: 'QZRS Scrcpy',
    from: o.myVersion,
    to: o.version,
    programDir: o.programDir,
    stageDir: o.stage,
    exe: o.exePath,
    restart: o.restart,
    mode: 'full',
    // ★ 助手会拿这份名单**再挡一次**（纵深防御）。名单来自 updater-core，
    //   不是在这里另写一份，所以不会漂移。
    protectedTop: PROTECTED_TOP.slice(),
    writes: o.writes.map((w) => ({ path: w.path, size: w.size, sha256: w.sha256 })),
    deletes: o.deletes.slice()
  }

  try {
    writeFileSync(join(o.stage, 'apply.json'), JSON.stringify(apply, null, 2) + '\n')
    writeFileSync(
      join(stageRootOf(o.programDir), 'state.json'),
      JSON.stringify({ state: 'staged', to: apply.to, from: apply.from, at: Date.now() }, null, 2) + '\n'
    )
  } catch (e) {
    return { ok: false, reason: '写 apply.json 失败：' + (e as Error).message }
  }
  return { ok: true, stage: o.stage, plan: apply }
}

export interface StageResult {
  ok: boolean
  reason?: string
  nothingToDo?: boolean
  stage?: string
  plan?: ApplyPlan
}

/**
 * 全量路径：下绿色版 zip → 解开 → **只摊真正变了的文件**进暂存区。
 *
 * ★ 为什么"全量"也摊进暂存区而不是就地解压：下载完就地解压等于改到一半就开始
 *   覆盖运行中的文件。摊进暂存区、由退出后的助手统一换，才能保证"要么全换要么全不换"。
 * ★ 只摊变了的文件：整包 130 MB 里往往只有 app.asar 之类几个文件真的变了，
 *   没必要把 370 MB 全写一遍。
 * ★ deletes 恒为空：全量包只知道"新版本该有什么"，不知道"本机多出来的那些是什么"
 *   —— 更新器**绝不主动删它看不懂的文件**（那可能是用户自己放的）。
 * ★ 内存：zip 整个读进内存（约 130 MB），但解压是逐条进行的，峰值只有最大的那个文件。
 */
export async function stageFull(o: {
  manifest: UpdateManifest
  base: string
  programDir: string
  myVersion: string
  exePath: string
  restart: boolean
  onChunk?: (got: number, total: number) => void
}): Promise<StageResult> {
  const m = o.manifest
  const stageRoot = stageDirOf(o.programDir, m.version)
  const filesRoot = join(stageRoot, 'files')

  try {
    mkdirSync(stageRoot, { recursive: true })
  } catch (e) {
    return { ok: false, reason: '暂存区创建失败：' + (e as Error).message }
  }

  // 1. 下 zip（落在暂存区里 —— 那里是受保护目录，不会被当成程序文件）
  const zipPath = join(stageRoot, m.full.asset)
  const dl = await downloadAsset({
    base: o.base,
    asset: m.full.asset,
    size: m.full.size,
    sha256: m.full.sha256,
    dest: zipPath,
    onChunk: o.onChunk
  })
  if (!dl.ok) {
    dropStage(stageRoot)
    return { ok: false, reason: dl.reason }
  }

  // 2. 本机现状（只有这一步需要把 370 MB 读一遍）
  let local: Map<string, ManifestFile>
  try {
    local = new Map(scanDir(o.programDir).map((f) => [f.path, f]))
  } catch (e) {
    dropStage(stageRoot)
    return { ok: false, reason: '读取本机程序目录失败：' + (e as Error).message }
  }

  // 3. 解包：逐条算哈希，与清单核对，只写变了的
  const seen: ManifestFile[] = []
  const writes: ManifestFile[] = []
  try {
    const buf = readFileSync(zipPath)
    readZip(buf, ({ name, data }) => {
      const rel = name.replace(/\\/g, '/')
      if (isProtectedPath(rel)) return // 包里不该有，真有也绝不落盘
      const sha = sha256hex(data)
      seen.push({ path: rel, size: data.length, sha256: sha })

      const cur = local.get(rel)
      if (cur && cur.size === data.length && cur.sha256 === sha) return // 本机已经是目标内容

      const dest = join(filesRoot, ...rel.split('/'))
      mkdirSync(dirname(dest), { recursive: true })
      withoutAsar(() => writeFileSync(dest, data))
      writes.push({ path: rel, size: data.length, sha256: sha })
    })
  } catch (e) {
    dropStage(stageRoot)
    return { ok: false, reason: '绿色版包解不开：' + (e as Error).message }
  }
  try {
    unlinkSync(zipPath)
  } catch {
    /* 删不掉不影响（它在受保护目录里） */
  }

  // 4. 包内容必须与清单完全一致 —— 只看 zip 的 hash 证明不了"解出来的东西对"
  const vr = verifyDir(m, seen)
  if (!vr.ok) {
    dropStage(stageRoot)
    return {
      ok: false,
      reason: `绿色版包与更新清单不符（缺 ${vr.missing.length} 个 / 内容不一致 ${vr.differ.length} 个）`
    }
  }

  if (!writes.length) {
    dropStage(stageRoot)
    return { ok: true, nothingToDo: true, reason: '本机文件已与目标版本逐字节一致，无需替换' }
  }

  return writeApply({
    programDir: o.programDir,
    exePath: o.exePath,
    myVersion: o.myVersion,
    version: m.version,
    stage: stageRoot,
    writes,
    deletes: [],
    restart: o.restart
  })
}

/* ------------------------------------------------------------------ 形态 */

export type RunForm = 'green' | 'portable' | 'dev'

/**
 * 更新只支持目录版（绿色版 / 安装版目录形状完全一样：`QZRS Scrcpy.exe` + `resources/`）。
 * 便携版是**单文件 exe**，运行中无法替换自己 → 直接判"不支持"并告诉用户去哪下。
 */
export function canSelfUpdate(form: RunForm): { ok: boolean; reason: string } {
  if (form === 'green') return { ok: true, reason: '' }
  if (form === 'portable') {
    return { ok: false, reason: '便携版是单文件 exe，无法在运行中替换自己 —— 请到 Release 页面下载新版' }
  }
  return { ok: false, reason: '开发模式不做自更新' }
}

/** 判断运行形态：便携版由 electron-builder 注入 PORTABLE_EXECUTABLE_DIR */
export function detectForm(isPackaged: boolean, env: NodeJS.ProcessEnv): RunForm {
  if (!isPackaged) return 'dev'
  return env.PORTABLE_EXECUTABLE_DIR || env.PORTABLE_EXECUTABLE_FILE ? 'portable' : 'green'
}

/** 程序目录里是否已有暂存区（给"打开更新目录"用，确保目录存在） */
export function ensureStageRoot(programDir: string): string {
  const dir = stageRootOf(programDir)
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  } catch {
    /* noop */
  }
  return dir
}

export { sha256hex }
