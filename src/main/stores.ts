import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { app } from 'electron'
import type { AppSettings, DeviceHistoryEntry, DeviceInfo, KeymapConfig } from '@shared/types'

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
    clipboardAutosync: true
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

export class Store {
  private settingsPath: string
  private devicesPath: string
  private keymapsDirPath: string
  private legacyKeymapsPath: string

  constructor() {
    const dir = dataDir()
    this.settingsPath = join(dir, 'settings.json')
    this.devicesPath = join(dir, 'devices.json')
    this.legacyKeymapsPath = join(dir, 'keymaps.json')
    this.keymapsDirPath = keymapsDir()
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
      session: { ...DEFAULT_SETTINGS.session, ...(raw.session ?? {}) }
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
      map.set(d.serial, { serial: d.serial, model, transport, lastSeen: Math.max(old.lastSeen, now) })
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

  getDir(): string {
    return dirname(this.settingsPath)
  }
}
