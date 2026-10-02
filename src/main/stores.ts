import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { app } from 'electron'
import type { AppSettings, DeviceHistoryEntry, DeviceInfo, KeymapConfig, ScriptInfo } from '@shared/types'

/** 历史设备最多保留条数，防止 devices.json 无限增长 */
const MAX_DEVICE_HISTORY = 50
/** 仅 lastSeen 前进时的落盘节流：两次写盘至少间隔 60s（轮询每 3s 一次，不节流会一直写盘） */
const HISTORY_TOUCH_THROTTLE_MS = 60_000

const DEFAULT_SETTINGS: AppSettings = {
  adbPath: '',
  serverPath: '',
  scrcpyPath: '',
  theme: 'dark',
  decoderAcceleration: 'auto',
  groupControl: false,
  activeKeymapId: null,
  fullscreenMode: 'overlay' as const,
  /** 调试模式开启时是否把调试日志写入安装目录/logs/<日期>.log（默认关） */
  debugLogToFile: false,
  // 额外扫描网段默认留空：这是给"设备挂在别的 VLAN、本机网卡看不到"的场景兜底用的，
  // 默认多扫任何一段都会拖慢深度扫描，不该由我们替用户决定。
  extraScanSubnets: [],
  session: {
    bitRate: 8000000,
    maxFps: 0,
    maxSize: 1920,
    codec: 'h264',
    videoEncoder: '',
    control: true,
    stayAwake: true,
    showTouches: false,
    powerOffOnClose: false,
    clipboardAutosync: true,
    // 默认开启音频转发，与官方 scrcpy 4.1 的默认行为一致（它是 `--no-audio` 才关），
    // 也让内置投屏与「Scrcpy 独立窗口」模式行为统一——否则会出现"内置没声音"的困惑。
    // ⚠️ 注意 getSettings() 是深合并：只在**没存过** audio 字段的机器上生效；
    //    用户手动关过（settings.json 里 audio:false）的机器会尊重用户选择，不会被改回来。
    // ⚠️ audio_source=output 会静音设备外放（scrcpy 既定语义），设置页已写明。
    audio: true,
    audioSource: 'output',
    audioCodec: 'opus',
    audioBitRate: 0
  }
}

function dataDir(): string {
  const dir = join(app.getPath('userData'), 'data')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function readJson<T>(path: string, fallback: T): T {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    /* ignore */
  }
  return fallback
}

function writeJson(path: string, value: unknown): void {
  try {
    writeFileSync(path, JSON.stringify(value, null, 2), 'utf8')
  } catch {
    /* ignore */
  }
}

/**
 * 安装根目录：
 * - 打包后：process.resourcesPath = <安装目录>/resources，取其上一级即 exe 所在目录
 * - 开发时：app.getAppPath() = 项目根目录
 * 按键方案放在这里的 keymaps/ 子目录，方便用户直接备份/分享。
 */
function installRoot(): string {
  if (app.isPackaged) return dirname(process.resourcesPath)
  return app.getAppPath()
}

/**
 * 调试日志目录候选（按优先级）：
 * 1. 安装目录/logs（软件目录下，绿色版随目录走）
 * 2. userData/logs（安装目录不可写时的兜底，如 Program Files 无管理员权限）
 * 只计算路径，不建目录——目录由 DebugFileLogger 在首次写入时按需创建。
 */
export function debugLogDirCandidates(): string[] {
  return [join(installRoot(), 'logs'), join(dataDir(), 'logs')]
}

/** 文件名安全化：防止 id 里出现路径分隔符等非法字符 */
function safeFileName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'keymap'
}

/**
 * 按键方案目录（安装目录/keymaps）。
 * 若安装目录不可写（例如装在 Program Files 且无管理员权限），自动回退到 userData。
 */
function keymapsDir(): string {
  const candidates = [join(installRoot(), 'keymaps'), join(dataDir(), 'keymaps')]
  for (const dir of candidates) {
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const probe = join(dir, '.write-test')
      writeFileSync(probe, '1', 'utf8')
      unlinkSync(probe)
      return dir
    } catch {
      /* 试下一个候选目录 */
    }
  }
  return candidates[1]
}

/** 脚本目录（安装目录/scripts），回退策略与 keymaps 相同 */
function scriptsDir(): string {
  const candidates = [join(installRoot(), 'scripts'), join(dataDir(), 'scripts')]
  for (const dir of candidates) {
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const probe = join(dir, '.write-test')
      writeFileSync(probe, '1', 'utf8')
      unlinkSync(probe)
      return dir
    } catch {
      /* 试下一个候选目录 */
    }
  }
  return candidates[1]
}

export class Store {
  private settingsPath: string
  private devicesPath: string
  private keymapsDirPath: string
  private legacyKeymapsPath: string
  private scriptsDirPath: string

  constructor() {
    const dir = dataDir()
    this.settingsPath = join(dir, 'settings.json')
    this.devicesPath = join(dir, 'devices.json')
    this.legacyKeymapsPath = join(dir, 'keymaps.json')
    this.keymapsDirPath = keymapsDir()
    this.scriptsDirPath = scriptsDir()
    // ensure settings exists with defaults
    if (!existsSync(this.settingsPath)) writeJson(this.settingsPath, DEFAULT_SETTINGS)
    this.migrateLegacyKeymaps()
  }

  /** 旧版把全部方案存在一个 keymaps.json 里，这里迁移成「每方案一个文件」（仅新目录为空时执行） */
  private migrateLegacyKeymaps(): void {
    const legacy = readJson<KeymapConfig[]>(this.legacyKeymapsPath, [])
    if (legacy.length === 0) return
    if (this.listKeymapFiles().length > 0) return
    for (const cfg of legacy) {
      if (!cfg?.id) continue
      writeJson(join(this.keymapsDirPath, `${safeFileName(cfg.id)}.json`), cfg)
    }
  }

  private listKeymapFiles(): string[] {
    try {
      return readdirSync(this.keymapsDirPath).filter((f) => f.endsWith('.json'))
    } catch {
      return []
    }
  }

  getSettings(): AppSettings {
    const raw = readJson<Partial<AppSettings>>(this.settingsPath, {})
    return {
      ...DEFAULT_SETTINGS,
      ...raw,
      session: { ...DEFAULT_SETTINGS.session, ...(raw.session ?? {}) },
      // 手改过 settings.json 的话这里可能是字符串甚至数字；渲染层会对它 .join('\n')，
      // 所以统一收敛成字符串数组，坏值一律当成空（扫描侧 parseSubnets 也会再过滤一遍）。
      extraScanSubnets: Array.isArray(raw.extraScanSubnets)
        ? raw.extraScanSubnets.map((x) => String(x))
        : typeof raw.extraScanSubnets === 'string'
          ? [raw.extraScanSubnets]
          : []
    }
  }

  setSettings(s: AppSettings): void {
    writeJson(this.settingsPath, s)
  }

  /** 历史连接过的设备（最近在前） */
  getDeviceHistory(): DeviceHistoryEntry[] {
    const raw = readJson<unknown>(this.devicesPath, [])
    if (!Array.isArray(raw)) return []
    return (raw as DeviceHistoryEntry[]).filter(
      (d) => d && typeof d.serial === 'string' && d.serial.length > 0
    )
  }

  /**
   * 把当前在线的设备并入历史记录，返回合并后的完整历史（最近在前）。
   *
   * 每 3s 轮询都会调用，因此写盘做了节流：
   * - 有结构性变化（新增设备 / model / transport 改变）→ 立即写；
   * - 只有 lastSeen 前进 → 至少间隔 60s 才写一次。
   */
  rememberDevices(live: DeviceInfo[]): DeviceHistoryEntry[] {
    const prev = this.getDeviceHistory()
    const map = new Map(prev.map((d) => [d.serial, d]))
    const now = Date.now()
    // Date.now() 只有毫秒分辨率：同一次调用里新增多台设备会拿到完全相同的 lastSeen，
    // 排序结果退化成 adb 的遍历顺序，把「最近在前」和 50 条上限的语义弄错。
    // 用一个单调递增的戳保证同批次内后处理到的更新，顺序确定且与后续调用可比。
    let stamp = now
    const nextStamp = (): number => (stamp += 1)
    let structural = false
    let touched = false

    for (const d of live) {
      // 只记「真正连上过」的设备：unauthorized / offline 不算
      if (!d?.serial || d.state !== 'device') continue
      const old = map.get(d.serial)
      if (!old) {
        map.set(d.serial, { serial: d.serial, model: d.model ?? null, transport: d.transport ?? null, lastSeen: nextStamp() })
        structural = true
        continue
      }
      const model = d.model ?? old.model
      const transport = d.transport ?? old.transport
      if (model !== old.model || transport !== old.transport) structural = true
      if (now - old.lastSeen >= HISTORY_TOUCH_THROTTLE_MS) touched = true
      // alias / order 是用户自定义数据，必须原样保留（防止轮询合并时被洗掉）
      map.set(d.serial, {
        serial: d.serial,
        model,
        transport,
        lastSeen: Math.max(old.lastSeen, now),
        alias: old.alias,
        order: old.order
      })
    }

    const list = [...map.values()].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, MAX_DEVICE_HISTORY)
    if (structural || touched) writeJson(this.devicesPath, list)
    return list
  }

  /** 从历史记录中删除一台设备（不碰 adb 连接，由调用方按需 disconnect） */
  forgetDevice(serial: string): DeviceHistoryEntry[] {
    const list = this.getDeviceHistory().filter((d) => d.serial !== serial)
    writeJson(this.devicesPath, list)
    return list
  }

  /**
   * 重命名设备（用户别名）。alias 为空串 = 清除别名。
   * structural=true 立即写盘：别名是用户主动操作，必须马上持久化。
   */
  renameDevice(serial: string, alias: string): DeviceHistoryEntry[] {
    const trimmed = alias.trim().slice(0, 30)
    const list = this.getDeviceHistory().map((d) => {
      if (d.serial !== serial) return d
      const next: DeviceHistoryEntry = { ...d }
      if (trimmed) next.alias = trimmed
      else delete next.alias
      return next
    })
    writeJson(this.devicesPath, list)
    return list
  }

  /**
   * 拖动排序：按传入的 serial 顺序写 order = 0..n-1。
   * 没出现在列表里的历史条目清除 order（它们会排在有 order 的设备之后，按在线优先/lastSeen）。
   */
  setDeviceOrder(orderedSerials: string[]): DeviceHistoryEntry[] {
    const orderMap = new Map(orderedSerials.map((s, i) => [s, i]))
    const list = this.getDeviceHistory().map((d) => {
      if (!orderMap.has(d.serial)) {
        if (d.order === undefined) return d
        const next: DeviceHistoryEntry = { ...d }
        delete next.order
        return next
      }
      return { ...d, order: orderMap.get(d.serial) }
    })
    writeJson(this.devicesPath, list)
    return list
  }

  /** 读取方案目录下所有 json，每个文件是一个独立方案 */
  getKeymaps(): KeymapConfig[] {
    const out: KeymapConfig[] = []
    for (const f of this.listKeymapFiles()) {
      const cfg = readJson<KeymapConfig | null>(join(this.keymapsDirPath, f), null)
      if (cfg && cfg.id) out.push(cfg)
    }
    return out
  }

  /** 每个方案写一个文件；列表中已不存在的方案，其文件一并删除 */
  setKeymaps(k: KeymapConfig[]): void {
    for (const cfg of k) {
      if (!cfg?.id) continue
      writeJson(join(this.keymapsDirPath, `${safeFileName(cfg.id)}.json`), cfg)
    }
    const keep = new Set(k.filter((c) => c?.id).map((c) => `${safeFileName(c.id)}.json`))
    for (const f of this.listKeymapFiles()) {
      if (keep.has(f)) continue
      try {
        unlinkSync(join(this.keymapsDirPath, f))
      } catch {
        /* ignore */
      }
    }
  }

  /** 方案文件夹实际路径（可能因权限回退到 userData） */
  getKeymapsDir(): string {
    return this.keymapsDirPath
  }

  /** ---- 用户脚本（scripts/ 目录，每脚本一个 json）---- */

  private listScriptFiles(): string[] {
    try {
      return readdirSync(this.scriptsDirPath).filter((f) => f.endsWith('.json'))
    } catch {
      return []
    }
  }

  /** 读取全部脚本（按 updatedAt 降序，最近编辑在前） */
  getScripts(): ScriptInfo[] {
    const out: ScriptInfo[] = []
    for (const f of this.listScriptFiles()) {
      const s = readJson<ScriptInfo | null>(join(this.scriptsDirPath, f), null)
      if (s && s.id && typeof s.code === 'string') {
        out.push({
          id: s.id,
          name: String(s.name || '未命名脚本').slice(0, 40),
          code: s.code,
          updatedAt: Number(s.updatedAt) || 0
        })
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 保存（新增或覆盖）；列表中已不存在的脚本，其文件一并删除 */
  setScripts(list: ScriptInfo[]): ScriptInfo[] {
    for (const s of list) {
      if (!s?.id) continue
      writeJson(join(this.scriptsDirPath, `${safeFileName(s.id)}.json`), {
        id: s.id,
        name: String(s.name || '未命名脚本').slice(0, 40),
        code: String(s.code ?? '').slice(0, 100_000),
        updatedAt: Number(s.updatedAt) || Date.now()
      })
    }
    const keep = new Set(list.filter((s) => s?.id).map((s) => `${safeFileName(s.id)}.json`))
    for (const f of this.listScriptFiles()) {
      if (keep.has(f)) continue
      try {
        unlinkSync(join(this.scriptsDirPath, f))
      } catch {
        /* ignore */
      }
    }
    return this.getScripts()
  }

  /** 脚本文件夹实际路径（设置面板/脚本面板展示用） */
  getScriptsDir(): string {
    return this.scriptsDirPath
  }

  /** ---- waitImage 模板（scripts/templates/*.png）---- */

  private templatesDir(): string {
    return join(this.scriptsDirPath, 'templates')
  }

  /** 保存 waitImage 模板（PNG 字节）。返回实际路径。 */
  saveTemplate(name: string, png: Buffer): string {
    const safe = name.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'template'
    const dir = this.templatesDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const path = join(dir, `${safe}.png`)
    writeFileSync(path, png)
    return path
  }

  /** 全部模板名（不含扩展名） */
  getTemplateNames(): string[] {
    try {
      return readdirSync(this.templatesDir())
        .filter((f) => f.endsWith('.png'))
        .map((f) => f.slice(0, -4))
    } catch {
      return []
    }
  }

  /** 全部模板（名字 + base64 PNG，脚本面板的模板管理器用来画缩略图） */
  getTemplates(): { name: string; png: string }[] {
    return this.getTemplateNames().map((name) => {
      const png = this.readTemplate(name)
      return { name, png: png ? png.toString('base64') : '' }
    })
  }

  /** 读模板 PNG 字节；不存在返回 null */
  readTemplate(name: string): Buffer | null {
    try {
      const safe = name.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40)
      const p = join(this.templatesDir(), `${safe}.png`)
      if (!existsSync(p)) return null
      return readFileSync(p)
    } catch {
      return null
    }
  }

  /** 删除模板 */
  deleteTemplate(name: string): void {
    try {
      const safe = name.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40)
      const p = join(this.templatesDir(), `${safe}.png`)
      if (existsSync(p)) unlinkSync(p)
    } catch {
      /* ignore */
    }
  }

  getDir(): string {
    return dirname(this.settingsPath)
  }
}
