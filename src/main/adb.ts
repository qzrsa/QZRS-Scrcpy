import { spawn } from 'node:child_process'
import net from 'node:net'
import os from 'node:os'
import type { DeviceInfo, DeviceState, AdbShellResult } from '@shared/types'

/** 本机所在网段列表（如 ["192.168.11"]），用于局域网扫描。 */
export function localSubnets(): string[] {
  const out = new Set<string>()
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      // 只取 IPv4 非回环地址；按 /24 处理（家庭/办公网络绝大多数情况）
      if (ni.family === 'IPv4' && !ni.internal) {
        out.add(ni.address.split('.').slice(0, 3).join('.'))
      }
    }
  }
  return [...out]
}

/** 虚拟网卡 MAC OUI 前缀（含 VPN 伪接口的全零 MAC） */
const VIRTUAL_MAC_PREFIXES = [
  '00:00:00', // VPN / 隧道伪接口（如 vgate0）——正常物理网卡不会是全零
  '00:50:56', // VMware
  '00:0c:29', // VMware
  '00:05:69', // VMware
  '08:00:27', // VirtualBox
  '00:15:5d', // Hyper-V
  '00:1c:42', // Parallels
  '02:00:4c' // Microsoft Loopback / WSL
]

/** 虚拟网卡接口名特征 */
const VIRTUAL_NAME_RE =
  /vmware|virtualbox|hyper-v|vethernet|tap-|tunnel|loopback|pseudo|tailscale|zerotier|radmin|npcap|wsl/i

/**
 * 物理网卡所在网段（排除 VPN / 虚拟机 / 隧道等虚拟网卡），如 ["192.168.11"]。
 *
 * 不能用「默认路由选出的主网段」代替：本机实测装了 VPN 时，系统默认路由指向
 * VPN 网卡（172.30.234），而真实局域网是 192.168.11，会扫错地方、一台都发现不了。
 * 按 MAC OUI + 接口名过滤虚拟网卡才是可靠做法。
 */
export function physicalSubnets(): string[] {
  const out = new Set<string>()
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    const nameIsVirtual = VIRTUAL_NAME_RE.test(name)
    for (const ni of list ?? []) {
      if (ni.family !== 'IPv4' || ni.internal) continue
      const mac = (ni.mac ?? '').toLowerCase()
      const macIsVirtual =
        mac === '' || VIRTUAL_MAC_PREFIXES.some((p) => mac.startsWith(p))
      if (nameIsVirtual || macIsVirtual) continue
      out.add(ni.address.split('.').slice(0, 3).join('.'))
    }
  }
  return [...out]
}

/** 探测单个 IP:port 是否可连通。 */
function probeTcp(ip: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    let done = false
    const finish = (v: boolean): void => {
      if (done) return
      done = true
      sock.destroy()
      resolve(v)
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
    sock.connect(port, ip)
  })
}

export interface ScanOptions {
  /** 单地址连接超时（毫秒） */
  timeoutMs?: number
  /** 并发探测数 */
  concurrency?: number
  /** 限定扫描的网段（如 ["192.168.11"]）；不传则按 allSubnets 决定 */
  subnets?: string[]
  /** true = 连虚拟网卡（VMware/VPN/隧道）网段一起扫，慢很多，用于兜底 */
  allSubnets?: boolean
}

/**
 * 扫描局域网内开放 adb 端口的设备，返回 IP 列表（按数值升序）。
 *
 * 注意：`adb mdns services` 只能发现 Android 11+ 手动开启「无线调试」开关后
 * 广播 _adb-tls-connect._tcp 的设备；而 `adb tcpip 5555` 模式的设备不发 mDNS
 * 广播，只能靠端口扫描发现。本项目实测场景属于后者，故用端口扫描。
 *
 * 默认只扫**物理网卡**网段（排除 VPN/虚拟机网卡，本机实测约 0.8 秒扫完 254 个地址）。
 * 若一台都没扫到，可用 allSubnets=true 兜底扫全部网段（含虚拟网卡）。
 */
export async function scanLanAdb(port = 5555, opts: ScanOptions = {}): Promise<string[]> {
  const { timeoutMs = 400, concurrency = 128, allSubnets = false } = opts
  let subnets = opts.subnets
  if (!subnets || subnets.length === 0) {
    subnets = allSubnets ? localSubnets() : physicalSubnets()
    // 物理网段判定失败时（极端环境）回退到全部网段，避免因过滤过严导致扫不到
    if (!allSubnets && subnets.length === 0) subnets = localSubnets()
  }
  if (subnets.length === 0) return []

  const ips: string[] = []
  for (const s of subnets) {
    for (let i = 1; i <= 254; i++) ips.push(`${s}.${i}`)
  }

  const found: string[] = []
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < ips.length) {
      const ip = ips[cursor++]
      // eslint-disable-next-line no-await-in-loop
      if (await probeTcp(ip, port, timeoutMs)) found.push(ip)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, ips.length) }, worker))

  const num = (ip: string): number[] => ip.split('.').map(Number)
  return found.sort((a, b) => {
    const na = num(a)
    const nb = num(b)
    return na[0] - nb[0] || na[1] - nb[1] || na[2] - nb[2] || na[3] - nb[3]
  })
}

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
