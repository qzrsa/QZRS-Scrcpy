import { spawn } from 'node:child_process'
import type { DeviceInfo, DeviceState, AdbShellResult } from '@shared/types'

/** Thin wrapper around the adb executable. */
export class AdbClient {
  constructor(public readonly path: string) {}

  exec(args: string[], timeoutMs = 30000): Promise<AdbShellResult> {
    return new Promise((resolve) => {
      const child = spawn(this.path, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
      }, timeoutMs)
      child.stdout.on('data', (d) => (stdout += d.toString()))
      child.stderr.on('data', (d) => (stderr += d.toString()))
      child.on('error', (err) => {
        clearTimeout(timer)
        resolve({ code: -1, stdout, stderr: err.message })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code: code ?? -1, stdout, stderr })
      })
    })
  }

  /** Start the adb server. */
  async startServer(): Promise<boolean> {
    const r = await this.exec(['start-server'])
    return r.code === 0
  }

  /** List devices. Returns an empty array on failure. */
  async devices(): Promise<DeviceInfo[]> {
    const r = await this.exec(['devices', '-l'])
    if (r.code !== 0) return []
    const lines = r.stdout.split(/\r?\n/).slice(1)
    const out: DeviceInfo[] = []
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const parts = trimmed.split(/\s+/)
      if (parts.length < 2) continue
      const serial = parts[0]
      const state = parseState(parts[1])
      let model: string | null = null
      let device: string | null = null
      let product: string | null = null
      for (let i = 2; i < parts.length; i++) {
        const kv = parts[i]
        const eq = kv.indexOf(':')
        if (eq < 0) continue
        const k = kv.slice(0, eq)
        const v = kv.slice(eq + 1)
        if (k === 'model') model = v.replace(/_/g, ' ')
        else if (k === 'device') device = v
        else if (k === 'product') product = v
        // 注意：transport_id 是 adb 内部数字 ID，不是 usb/tcpip 类型，忽略它
      }
      // adb -l 不直接暴露 usb/tcpip，从 serial 格式推断：
      // 含 IP:port → tcpip（无线 adb）；emulator- 前缀 → local（模拟器）；其余 → usb
      const isTcp = /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/.test(serial)
      const isEmulator = /^emulator-/.test(serial)
      const transport = isTcp ? 'tcpip' : isEmulator ? 'local' : 'usb'
      out.push({
        serial,
        state,
        model,
        device,
        product,
        transport
      })
    }
    return out
  }

  async connect(hostPort: string): Promise<AdbShellResult> {
    return this.exec(['connect', hostPort])
  }

  async disconnect(hostPort: string): Promise<AdbShellResult> {
    return this.exec(['disconnect', hostPort])
  }

  /** Restart adbd in TCP/IP mode on the given port. */
  async tcpip(serial: string, port: number): Promise<AdbShellResult> {
    return this.exec(['-s', serial, 'tcpip', String(port)])
  }

  async push(serial: string, local: string, remote: string): Promise<AdbShellResult> {
    return this.exec(['-s', serial, 'push', local, remote], 120000)
  }

  async pull(serial: string, remote: string, local: string): Promise<AdbShellResult> {
    return this.exec(['-s', serial, 'pull', remote, local], 120000)
  }

  /** Capture a binary stream from `exec-out` (e.g. screencap). Returns raw Buffer. */
  execOut(serial: string, command: string, timeoutMs = 30000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.path, ['-s', serial, 'exec-out', command], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const chunks: Buffer[] = []
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error('exec-out 超时'))
      }, timeoutMs)
      child.stdout.on('data', (d: Buffer) => chunks.push(d))
      child.stderr.on('data', (d) => (stderr += d.toString()))
      child.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve(Buffer.concat(chunks))
        else reject(new Error(stderr.trim() || `exec-out 失败 exit ${code}`))
      })
    })
  }

  /** Capture a PNG screenshot from the device. */
  async screencap(serial: string): Promise<Buffer> {
    return this.execOut(serial, 'screencap -p', 30000)
  }

  async forward(serial: string, localPort: number, socketName: string): Promise<AdbShellResult> {
    return this.exec(['-s', serial, 'forward', `tcp:${localPort}`, `localabstract:${socketName}`])
  }

  async removeForward(serial: string, localPort: number): Promise<AdbShellResult> {
    return this.exec(['-s', serial, 'forward', '--remove', `tcp:${localPort}`])
  }

  /** Run an adb shell command. */
  async shell(serial: string, command: string, timeoutMs = 30000): Promise<AdbShellResult> {
    return this.exec(['-s', serial, 'shell', command], timeoutMs)
  }

  /** Get device IP (for TCP/IP switching). */
  async getDeviceIp(serial: string): Promise<string | null> {
    const r = await this.shell(serial, 'ip route')
    if (r.code !== 0) return null
    const m = r.stdout.match(/src\s+([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)/)
    if (m) return m[1]
    const m2 = r.stdout.match(/inet\s+([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)/)
    return m2 ? m2[1] : null
  }
}

function parseState(s: string): DeviceState {
  switch (s) {
    case 'device':
      return 'device'
    case 'offline':
      return 'offline'
    case 'unauthorized':
      return 'unauthorized'
    case 'no permissions':
    case 'no-permissions':
      return 'no-permissions'
    default:
      return 'unknown'
  }
}
