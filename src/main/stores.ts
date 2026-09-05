import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
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

export class Store {
  private settingsPath: string
  private keymapsPath: string

  constructor() {
    const dir = dataDir()
    this.settingsPath = join(dir, 'settings.json')
    this.keymapsPath = join(dir, 'keymaps.json')
    // ensure files exist with defaults
    if (!existsSync(this.settingsPath)) writeJson(this.settingsPath, DEFAULT_SETTINGS)
    if (!existsSync(this.keymapsPath)) writeJson(this.keymapsPath, [])
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

  getKeymaps(): KeymapConfig[] {
    return readJson<KeymapConfig[]>(this.keymapsPath, [])
  }

  setKeymaps(k: KeymapConfig[]): void {
    writeJson(this.keymapsPath, k)
  }

  getDir(): string {
    return dirname(this.settingsPath)
  }
}
