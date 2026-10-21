import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppSettings, UpdateNotice, UpdateProgress, UpdateSnapshot, UpdateStatus } from '@shared/types'
import * as applyLib from './updater-apply'
import * as updater from './updater'
import { humanBytes, isNewer } from './updater-core'
import type { UpdateManifest } from './updater-core'

/**
 * 自更新的**编排层**：把「检查 → 下载 → 摊进暂存区 → 交接给退出后助手」串成一条状态机，
 * 并把状态摊成一份快照给界面。主进程只负责喂真实依赖（app / 设置 / spawn），
 * 于是整条状态机能在离线脚本里用注入依赖跑完 —— 不联网，也不碰真实程序目录。
 *
 * 分工（刻意分层，混了就会出现两份实现）：
 *   updater-core   纯判断：清单自检 / 版本比较 / 目录校验 / 受保护路径
 *   updater        执行：传输、落盘、摊暂存区
 *   updater-apply  生成"退出后"的助手脚本（纯字符串拼装）
 *   update-service 编排 + 状态机 + 面向界面的快照   ← 本文件
 *
 * ★★ 三条不可动摇的产品约束（对齐「快速启动」的更新模型）：
 *   ① 默认开启自动检查，但**只在启动时检查一次** —— 不轮询、不常驻、不后台盯着。
 *   ② **下载与安装永远等用户点**。检查是全自动的，动手必须是人按的。
 *   ③ 便携版是单文件 exe，运行中无法替换自己 → 直接判"不支持"，并告诉用户去哪下。
 *
 * ★★ 为什么快照要连"为什么不能更新"一起给出：用户看到"更新不可用"时最需要的是原因
 *   （便携版？清单没发？超时？），而不是一个静默的灰按钮。
 */

const STATE_TEXT: Record<UpdateStatus, string> = {
  unsupported: '当前形态不支持自动更新',
  idle: '尚未检查',
  checking: '正在检查更新…',
  uptodate: '已是最新版本',
  available: '发现新版本',
  downloading: '正在下载…',
  staged: '已就绪，重启即可完成更新',
  nothing: '本机文件已是目标内容，无需替换',
  failed: '更新失败'
}

/** 清单请求最多等 30 秒。传输层这条路径上没有单独的取消机制，用 Promise.race 兜住 */
const CHECK_TIMEOUT_MS = 30000

/**
 * 进度事件推送间隔。一个 130 MB 的包会有上千次 chunk 回调，
 * 每次都跨进程推一次会把渲染层淹掉。
 */
const PROGRESS_THROTTLE_MS = 150

/** 等助手"报活"最多等这么久。PowerShell 冷启动约 0.4 s，给足余量但不无限等。 */
const HELPER_ALIVE_MS = 6000

interface St {
  status: UpdateStatus
  latest: string
  reason: string
  checkedAt: number
  manifest: UpdateManifest | null
  stage: string
  progress: { got: number; total: number } | null
  notice: UpdateNotice | null
}

export interface UpdateDeps {
  version: () => string
  form: () => updater.RunForm
  programDir: () => string
  exePath: () => string
  getSettings: () => AppSettings
  /** 局部更新设置（只写给出的字段），用于记住"这条提示已经报过" */
  patchSettings: (patch: Partial<AppSettings>) => void
  send: (channel: string, payload: unknown) => void
  quit: () => void
  now?: () => number
}

function fmtTime(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export class UpdateService {
  private st: St = {
    status: 'idle',
    latest: '',
    reason: '',
    checkedAt: 0,
    manifest: null,
    stage: '',
    progress: null,
    notice: null
  }

  private seq = 0
  private inflight: Promise<{ ok: boolean; reason?: string }> | null = null
  private booted = false
  private readonly now: () => number

  constructor(private deps: UpdateDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  private settings(): AppSettings {
    return this.deps.getSettings()
  }

  private can(): { ok: boolean; reason: string } {
    return updater.canSelfUpdate(this.deps.form())
  }

  /** 归一化后的更新源；设置里填了非法值就返回 {error}，绝不静默回落成默认源 */
  private base(): { url: string; error: string } {
    try {
      return { url: updater.normalizeBase(this.settings().updateBase), error: '' }
    } catch (e) {
      return { url: '', error: (e as Error).message }
    }
  }

  /** 状态/进度变了就推一份新快照。渲染层只认快照，不自己拼状态 */
  private push(): void {
    try {
      this.deps.send('update:state', this.snapshot())
    } catch {
      /* 窗口没了也不能影响更新本身 */
    }
  }

  private set(partial: Partial<St>): void {
    Object.assign(this.st, partial)
    this.push()
  }

  /* ---------------------------------------------------------- 界面快照 */

  private planInfo(): UpdateSnapshot['plan'] {
    if (!this.st.manifest) return null
    const size = Number(this.st.manifest.full?.size) || 0
    return { mode: 'full', size, sizeText: humanBytes(size) }
  }

  private progressInfo(): UpdateProgress | null {
    const p = this.st.progress
    if (!p) return null
    const total = Number(p.total) || 0
    const got = Number(p.got) || 0
    const pct = total > 0 ? Math.min(100, Math.floor((got / total) * 100)) : null
    return {
      got,
      total,
      pct,
      text: total > 0 ? `${humanBytes(got)} / ${humanBytes(total)}（${pct}%）` : humanBytes(got)
    }
  }

  snapshot(): UpdateSnapshot {
    const s = this.settings()
    const c = this.can()
    const b = this.base()
    return {
      supported: !!c.ok,
      unsupportedReason: c.ok ? '' : c.reason,
      form: this.deps.form(),
      myVersion: this.deps.version(),
      autoUpdate: s.autoUpdate !== false,
      base: b.error ? '' : b.url,
      baseError: b.error,
      status: this.st.status,
      statusText: STATE_TEXT[this.st.status] ?? this.st.status,
      latest: this.st.latest,
      reason: this.st.reason,
      plan: this.planInfo(),
      progress: this.progressInfo(),
      checkedAt: this.st.checkedAt,
      checkedAtText: fmtTime(this.st.checkedAt),
      dir: updater.stageRootOf(this.deps.programDir()),
      busy: this.st.status === 'checking' || this.st.status === 'downloading',
      canCheck: c.ok && this.st.status !== 'checking' && this.st.status !== 'downloading',
      canDownload: c.ok && this.st.status === 'available',
      canApply: c.ok && this.st.status === 'staged',
      notice: this.st.notice
    }
  }

  /* ---------------------------------------------------------- 检查 */

  /**
   * 查一次更新。
   * @param o.silent  true = 启动时的静默检查（"已是最新/没清单"不打扰用户）
   * @param o.timeoutMs 可覆盖超时（自检用 —— 不然验一次超时要等 30 秒）
   */
  async check(o: { silent?: boolean; timeoutMs?: number } = {}): Promise<{ ok: boolean; available?: boolean; reason?: string }> {
    const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : CHECK_TIMEOUT_MS
    const c = this.can()
    if (!c.ok) {
      this.set({ status: 'unsupported', latest: '', reason: c.reason, checkedAt: this.now() })
      return { ok: false, reason: c.reason }
    }
    const b = this.base()
    if (b.error) {
      this.set({ status: 'failed', latest: '', reason: b.error, checkedAt: this.now() })
      return { ok: false, reason: b.error }
    }
    if (this.st.status === 'checking' || this.st.status === 'downloading') {
      return { ok: false, reason: '正在忙，先等一下' }
    }

    const my = ++this.seq
    this.set({ status: 'checking', reason: '', notice: null })

    let timer: NodeJS.Timeout | null = null
    let r: { ok: boolean; available: boolean; reason: string; manifest?: UpdateManifest }
    try {
      r = await Promise.race([
        updater.check({ myVersion: this.deps.version(), base: b.url }),
        new Promise<never>((_res, rej) => {
          const wait = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} 秒` : `${timeoutMs} 毫秒`
          timer = setTimeout(() => rej(new Error(`检查超时（更新源 ${wait} 没响应）`)), timeoutMs)
        })
      ])
    } catch (e) {
      r = { ok: false, available: false, reason: (e as Error).message }
    } finally {
      if (timer) clearTimeout(timer)
    }

    // ★ 本次已被后来的动作取代 → 结果直接丢掉。否则迟到的响应会把界面拽回过期状态。
    if (my !== this.seq) return { ok: false, reason: '结果已过期（期间有更新的操作）' }

    if (!r.ok) {
      this.set({ status: 'failed', latest: '', reason: r.reason, checkedAt: this.now() })
      return { ok: false, reason: r.reason }
    }
    if (!r.available) {
      this.set({ status: 'uptodate', latest: '', reason: r.reason, manifest: r.manifest ?? null, checkedAt: this.now() })
      return { ok: true, available: false, reason: r.reason }
    }
    this.set({
      status: 'available',
      latest: r.manifest!.version,
      reason: r.reason,
      manifest: r.manifest!,
      checkedAt: this.now()
    })
    return { ok: true, available: true, reason: r.reason }
  }

  /* ---------------------------------------------------------- 下载并暂存 */

  download(): Promise<{ ok: boolean; reason?: string }> {
    if (this.inflight) return this.inflight
    const c = this.can()
    if (!c.ok) return Promise.resolve({ ok: false, reason: c.reason })
    if (!this.st.manifest) return Promise.resolve({ ok: false, reason: '还没有可用清单，请先检查更新' })
    if (this.st.status === 'downloading') return Promise.resolve({ ok: false, reason: '正在下载' })
    if (this.st.status !== 'available') return Promise.resolve({ ok: false, reason: '当前没有待下载的更新' })

    const fail = (reason: string): { ok: boolean; reason: string } => {
      this.set({ status: 'failed', reason, progress: null })
      return { ok: false, reason }
    }

    this.inflight = (async () => {
      const b = this.base()
      if (b.error) return fail(b.error)

      const my = ++this.seq
      const m = this.st.manifest!
      const size = Number(m.full?.size) || 0
      this.set({ status: 'downloading', reason: '', progress: size ? { got: 0, total: size } : null })

      let lastPush = 0
      const onChunk = (got: number, total: number): void => {
        this.st.progress = { got, total: Number(total) || size || 0 }
        const t = this.now()
        if (t - lastPush < PROGRESS_THROTTLE_MS) return
        lastPush = t
        this.push()
      }

      let r: updater.StageResult
      try {
        r = await updater.stageFull({
          manifest: m,
          base: b.url,
          programDir: this.deps.programDir(),
          myVersion: this.deps.version(),
          exePath: this.deps.exePath(),
          restart: true,
          onChunk
        })
      } catch (e) {
        r = { ok: false, reason: '下载失败：' + (e as Error).message }
      }

      if (my !== this.seq) return { ok: false, reason: '结果已过期（期间有更新的操作）' }
      if (!r.ok) return fail(r.reason ?? '下载失败')
      if (r.nothingToDo) {
        this.set({
          status: 'nothing',
          latest: m.version,
          progress: null,
          stage: '',
          reason: `本机文件已与 v${m.version} 逐字节一致，无需替换`
        })
        return { ok: true }
      }
      this.set({
        status: 'staged',
        latest: m.version,
        progress: null,
        stage: r.stage ?? '',
        reason: `已下载并校验 v${m.version}（全量），重启即完成`
      })
      return { ok: true }
    })().finally(() => {
      this.inflight = null
    })

    return this.inflight
  }

  /* ---------------------------------------------------------- 交接助手 */

  /** 显式给绝对路径，不指望 PATH（打包后被拉起的环境未必带完整 PATH） */
  private systemExe(name: string): string {
    const root = process.env.SystemRoot || 'C:\\Windows'
    const abs = join(root, 'System32', name)
    return existsSync(abs) ? abs : name
  }

  private powerShellExe(): string {
    const root = process.env.SystemRoot || 'C:\\Windows'
    const abs = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    return existsSync(abs) ? abs : 'powershell.exe'
  }

  /**
   * 助手起来后的**第一件事**就是往暂存区写 apply.log。
   * 所以"apply.log 出现"就是它真的活了的活体证据 —— 比看一眼 child.pid 可靠得多
   * （曾经出现过"spawn 成功但 PowerShell 一个字节都没执行"，pid 有、活没干）。
   * 返回 false 时调用方**必须放弃退出**：否则就是用户碰到过的那种
   * 「点了重启并更新 → 程序关掉 → 什么都没发生 → 再打开还是旧版」。
   */
  private async waitHelperAlive(logPath: string): Promise<boolean> {
    const t0 = this.now()
    for (;;) {
      try {
        if (existsSync(logPath)) return true
      } catch {
        /* 查询失败就当没出现 */
      }
      if (this.now() - t0 >= HELPER_ALIVE_MS) return false
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  /**
   * 把暂存的更新交给"退出后运行"的助手，然后退出自己。
   *
   * ★★ 顺序不能反：**先**把助手拉起来并确认它活着，**再**退出 —— 反过来的话主进程一走，
   *    还没 spawn 的助手就再也没人起了。
   * ★ 助手会等这个 pid 真的退出后才动手（Windows 上运行中的 exe 不可覆盖）。
   */
  async applyAndRestart(): Promise<{ ok: boolean; reason?: string; helperPid?: number }> {
    if (this.st.status !== 'staged') return { ok: false, reason: '还没有下载好的更新' }
    const stageDir = this.st.stage || updater.stageDirOf(this.deps.programDir(), this.st.latest)
    const planPath = join(stageDir, 'apply.json')

    let plan: applyLib.ApplyJson
    try {
      plan = JSON.parse(readFileSync(planPath, 'utf8')) as applyLib.ApplyJson
    } catch (e) {
      return { ok: false, reason: '读不到更新计划（暂存区可能已被清理）：' + (e as Error).message }
    }

    // 计划里的 restart 决定助手换完文件后要不要把新版拉起来 —— 我们总是要
    plan.restart = true
    plan.exe = plan.exe || this.deps.exePath()

    // ★ 先清掉上一轮留下的日志：否则"活体检查"会被旧文件骗过去
    const logPath = join(stageDir, 'apply.log')
    try {
      unlinkSync(logPath)
    } catch {
      /* 没有旧日志才是常态 */
    }

    const scriptPath = join(stageDir, applyLib.HELPER_FILE)
    const script = applyLib.buildApplyScript(plan, { pid: process.pid, waitSeconds: 120, logPath })
    try {
      // ★ 带 BOM：PowerShell 5.1 读到 BOM 才按 UTF-8 解析，中文路径才不会废
      writeFileSync(scriptPath, applyLib.scriptFileText(script), 'utf8')
    } catch (e) {
      return { ok: false, reason: '写更新助手脚本失败：' + (e as Error).message }
    }

    const line = applyLib.launcherCommandLine(this.powerShellExe(), scriptPath)
    let child
    try {
      // ★ windowsVerbatimArguments：cmd 的 /c 引号规矩与 CRT 的 \" 转义不是一回事，
      //   交给 Node 去转义会得到一个跑不起来的命令行（实测 exit 1）。
      // ★ 不要 detached：见 updater-apply.ts 顶部注释。
      child = spawn(this.systemExe('cmd.exe'), [line], {
        detached: false,
        stdio: 'ignore',
        windowsHide: true,
        windowsVerbatimArguments: true
      })
      child.unref()
    } catch (e) {
      return { ok: false, reason: '启动更新助手失败：' + (e as Error).message }
    }

    if (!(await this.waitHelperAlive(logPath))) {
      // 只留下一个活的进程去换文件才是安全的；它没起来就绝不退出（本机文件一个都没动）
      try {
        child.kill()
      } catch {
        /* 可能已经自己退了 */
      }
      const reason =
        '更新助手没能启动（' + logPath + ' 没有出现）。程序没有退出，文件也没动，可以再试一次。'
      return { ok: false, reason }
    }

    this.set({ reason: '正在退出并替换文件，稍后会自动重新打开…' })
    if (this.deps.quit) setTimeout(() => this.deps.quit(), 300)
    return { ok: true, helperPid: child.pid ?? 0 }
  }

  /* ---------------------------------------------------------- 启动时的收尾 */

  /** 只在"这件事还没报过"时把 notice 挂到快照上，并记下已报（跨重启也不会重复） */
  private notifyOnce(key: string, kind: UpdateNotice['kind'], title: string, text: string): boolean {
    if (this.settings().lastUpdateNotice === key) return false
    this.st.notice = { kind, title, text, key }
    try {
      this.deps.patchSettings({ lastUpdateNotice: key })
    } catch {
      /* noop */
    }
    return true
  }

  /**
   * 读上一次更新的结果。四件事：
   *   ① `applied` → 报个喜（但只在"那个版本确实就是正在跑的版本"时，否则会瞎报）
   *   ② `failed`  → **必须**报：不报的话用户会以为更新成功了，却一直用着旧版
   *   ③ `staged`  → 上次下好了但没重启 → 恢复成"可重启更新"，别让它白下
   *   ④ 其余（针对更老版本的残留暂存）→ 清掉，别把上百 MB 白留在用户盘上
   */
  restoreStaged(): { ok: boolean; applied?: string; failed?: string; resumed?: string; discarded?: string } {
    const root = updater.stageRootOf(this.deps.programDir())
    const stateFile = join(root, 'state.json')
    let s: { state?: string; to?: string; from?: string; note?: string; at?: string | number } | null = null
    try {
      s = JSON.parse(readFileSync(stateFile, 'utf8'))
    } catch {
      return { ok: true }
    }
    if (!s || !s.state) return { ok: true }

    const my = this.deps.version()
    const key = `${s.state}|${s.to ?? ''}|${s.at ?? ''}`

    if (s.state === 'applied' && s.to === my) {
      this.notifyOnce(key, 'applied', `已更新到 v${s.to}`, '文件替换完成，当前运行的已经是新版本。')
      return { ok: true, applied: s.to }
    }
    if (s.state === 'failed') {
      this.notifyOnce(
        key,
        'failed',
        '上次更新没有成功',
        `${s.note || '助手没能替换文件'}。程序仍在 v${my}，可以再试一次；日志：${join(root, 'apply-' + (s.to ?? '') + '.log')}`
      )
      return { ok: true, failed: s.note ?? '' }
    }
    if (s.state === 'staged') {
      const dir = join(root, String(s.to ?? ''))
      if (s.to && isNewer(s.to, my) && existsSync(join(dir, 'apply.json'))) {
        this.set({ status: 'staged', latest: s.to, stage: dir, reason: `上次已下好 v${s.to}，重启即可完成更新` })
        return { ok: true, resumed: s.to }
      }
      // 目标已经不比本机新了（或暂存区没了）→ 白占地方，清掉
      updater.dropStage(dir)
      try {
        unlinkSync(stateFile)
      } catch {
        /* noop */
      }
      return { ok: true, discarded: s.to }
    }
    return { ok: true }
  }

  /** 启动时调一次：判形态 + 恢复/收尾上次的更新结果。**不**发网络请求。 */
  boot(): { ok: boolean; reason?: string } {
    if (this.booted) return { ok: true }
    this.booted = true
    const c = this.can()
    if (!c.ok) {
      this.set({ status: 'unsupported', reason: c.reason })
      return { ok: false, reason: c.reason }
    }
    this.restoreStaged()
    this.push()
    return { ok: true }
  }

  /** 确保更新目录存在（"打开更新目录"用） */
  ensureDir(): string {
    const dir = updater.stageRootOf(this.deps.programDir())
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    } catch {
      /* noop */
    }
    return dir
  }

  /** 供离线自检直接看内部状态（正常流程用不到） */
  peek(): St {
    return this.st
  }
}
