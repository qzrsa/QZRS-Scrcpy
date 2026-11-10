import { createServer } from 'node:net'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { app } from 'electron'

/**
 * 「项目自带资源」的候选根目录：所有可能位置都试一遍，命中即返回。
 * 不用 app.isPackaged 判断——它在部分 electron-builder 配置下不可靠，
 * 曾导致便携版找不到 scrcpy-server。
 * 打包后命中 process.resourcesPath / dirname(app.getAppPath())；
 * 开发模式命中 app.getAppPath() 及其 resources/。
 */
function resBases(): string[] {
  return [
    process.resourcesPath,
    dirname(app.getAppPath()),
    app.getAppPath(),
    join(app.getAppPath(), 'resources')
  ]
}

/** Find a free TCP port on localhost. */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (address && typeof address === 'object') {
        srv.close(() => resolve(address.port))
      } else {
        srv.close(() => reject(new Error('Could not determine free port')))
      }
    })
  })
}

/**
 * Generate a random SCID used to name the device socket.
 *
 * MUST be a 31-bit non-negative integer. scrcpy's Java server parses it with
 * `Integer.parseInt(hex, 16)` (signed 32-bit, Options.java), so any value with
 * the high bit set (>= 0x80000000) overflows and throws NumberFormatException.
 * The official C client matches this by masking to 31 bits (scrcpy.c:
 * scrcpy_generate_scid -> `sc_rand_u32() & 0x7FFFFFFF`).
 */
export function randomScid(): number {
  return (Math.random() * 0xffffffff) >>> 0 & 0x7fffffff
}

/** Socket name on the device for a given scid. */
export function socketNameFor(scid: number): string {
  return 'scrcpy_' + scid.toString(16).padStart(8, '0')
}

function adbExe(): string {
  return process.platform === 'win32' ? 'adb.exe' : 'adb'
}

/** Locate the adb executable. Priority: user setting > bundled /adb > env > common locations. */
export function findAdb(explicit?: string): string | null {
  if (explicit && existsSync(explicit)) return explicit

  const candidates: string[] = []
  // 项目自带的 adb 目录（多个基准都试一遍，不依赖 isPackaged）
  for (const base of resBases()) candidates.push(join(base, 'adb', adbExe()))
  if (process.env.ANDROID_HOME) {
    candidates.push(join(process.env.ANDROID_HOME, 'platform-tools', adbExe()))
  }
  if (process.env.ANDROID_SDK_ROOT) {
    candidates.push(join(process.env.ANDROID_SDK_ROOT, 'platform-tools', adbExe()))
  }
  const local = join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', adbExe())
  candidates.push(local)
  candidates.push(join(process.env.ProgramFiles || 'C:\\Program Files', 'platform-tools', adbExe()))
  candidates.push('C:\\platform-tools\\' + adbExe())
  // bundled with the app (optional)
  candidates.push(join(app.getAppPath(), 'resources', 'platform-tools', adbExe()))

  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  return null
}

/** Locate the bundled scrcpy-server binary. */
export function findServer(explicit?: string): string | null {
  if (explicit && existsSync(explicit)) return explicit
  // 多个基准都试一遍，不依赖 isPackaged（曾因 isPackaged=false 找不到）
  const candidates = resBases().map(b => join(b, 'scrcpy-server'))
  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  return null
}

/**
 * Locate the official scrcpy CLI (scrcpy.exe on Windows). Used as a fallback
 * to launch scrcpy's own SDL window when the built-in WebCodecs renderer has
 * issues (e.g. green screen / aspect-ratio glitches on certain GPUs).
 */
export function findScrcpy(explicit?: string): string | null {
  if (explicit && existsSync(explicit)) return explicit
  const exe = process.platform === 'win32' ? 'scrcpy.exe' : 'scrcpy'
  const candidates: string[] = []
  if (process.env.SCRCPY_HOME) candidates.push(join(process.env.SCRCPY_HOME, exe))
  // 项目自带的 scrcpy 目录（多个基准都试一遍）
  for (const base of resBases()) candidates.push(join(base, 'scrcpy', exe))
  // PATH lookup
  const pathDirs = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')
  for (const d of pathDirs) {
    if (d) candidates.push(join(d, exe))
  }
  // Common install locations
  const local = join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', exe)
  candidates.push(local)
  candidates.push(join(process.env.ProgramFiles || 'C:\\Program Files', 'scrcpy', exe))
  candidates.push('C:\\platform-tools\\' + exe)
  // Bundled with the app (optional)
  candidates.push(join(app.getAppPath(), 'resources', 'scrcpy', exe))
  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  return null
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}