import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { app } from 'electron'
import type { AppSettings, KeymapConfig } from '@shared/types'

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
  private keymapsDirPath: string
  private legacyKeymapsPath: string

  constructor() {
    const dir = dataDir()
    this.settingsPath = join(dir, 'settings.json')
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
