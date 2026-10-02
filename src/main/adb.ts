import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import os from 'node:os'
import type { DeviceInfo, DeviceState, AdbShellResult } from '@shared/types'
import { intToIpv4, subnetPrefixToRange, type IpRange } from '@shared/subnet'

/** 本机所有 IPv4 网卡的网段列表（如 ["192.168.11"]），不管物理还是虚拟。 */
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

/**
 * 回环网段。本机网卡枚举拿不到它（127.0.0.1 的 ni.internal === true 会被过滤掉），
 * 必须显式加。用途：发现经内网穿透（nps/frp）、端口转发或本机模拟器暴露在
 * 127.0.0.1:5555 的 adb 设备。
 *
 * 成本极低：内核立即回 RST（ECONNREFUSED），整段 254 个地址约 50ms，且与 timeoutMs 无关。
 */
const LOOPBACK_SUBNET = '127.0'

/** 往网段列表补上回环网段（已含则不重复）。 */
function withLoopback(subnets: string[]): string[] {
  return subnets.includes(LOOPBACK_SUBNET) ? subnets : [...subnets, LOOPBACK_SUBNET]
}

/**
 * 「快速扫描」的网段集合 = 物理网卡网段 + 回环网段。
 *
 * 物理网段判定失败时（极端环境，全是虚拟网卡）回退到全部网卡网段，避免因过滤过严导致扫不到。
 */
export function fastScanSubnets(): string[] {
  const phys = physicalSubnets()
  return withLoopback(phys.length > 0 ? phys : localSubnets())
}

/**
 * 「深度扫描」的网段集合 = 本机全部网卡网段（含 VMware / VPN 等虚拟网卡）+ 回环网段。
 *
 * 注意这里**不含**用户在设置里手填的额外网段——那些可能是 /22、/32 等任意区间，
 * 表达不成"一个 /24 前缀"。合并发生在调用方（ipc.ts 的 devices:scan），
 * 做法是把它和本函数的结果一起转成 IpRange 后交给 scanLanAdb。
 */
export function deepScanSubnets(): string[] {
  return withLoopback(localSubnets())
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
  /** true = 额外连虚拟网卡（VMware/VPN/隧道）网段一起扫，慢很多，用于兜底 */
  allSubnets?: boolean
  /**
   * 精确地址区间（优先级最高，给了就不再走 subnets / allSubnets）。
   * 用于自动检测网段 + 用户手填 CIDR 合并后的统一表达——手填的可能是 /22 或单个 IP，
   * 不是"一个 /24 前缀"能表示的。
   */
  ranges?: IpRange[]
}

/**
 * 单次扫描的地址数硬上限（防御性，正常路径不会撞到）。
 *
 * 调用方（ipc.ts）已按 MAX_EXTRA_ADDRESSES 限制用户输入，自动检测网段也只会是几个 /24，
 * 这里再兜一层是为了防止将来有人直接调 scanLanAdb 传个 /8 进来把界面卡死。
 */
const MAX_SCAN_ADDRESSES = 65536

/**
 * 扫描局域网内开放 adb 端口的设备，返回 IP 列表（按数值升序）。
 *
 * 注意：`adb mdns services` 只能发现 Android 11+ 手动开启「无线调试」开关后
 * 广播 _adb-tls-connect._tcp 的设备；而 `adb tcpip 5555` 模式的设备不发 mDNS
 * 广播，只能靠端口扫描发现。本项目实测场景属于后者，故用端口扫描。
 *
 * 默认（快扫）只扫**物理网卡**网段 + 回环网段（排除 VPN/虚拟机网卡，本机实测约 0.85 秒）。
 * 若一台都没扫到，可用 allSubnets=true 兜底扫**全部网卡网段 + 回环网段**。
 * 另可用 ranges 直接指定区间（含用户手填的任意 CIDR / 单 IP）。
 */
export async function scanLanAdb(port = 5555, opts: ScanOptions = {}): Promise<string[]> {
  const { timeoutMs = 400, concurrency = 128, allSubnets = false } = opts
  let ranges = opts.ranges
  if (!ranges || ranges.length === 0) {
    let subnets = opts.subnets
    if (!subnets || subnets.length === 0) {
      subnets = allSubnets ? deepScanSubnets() : fastScanSubnets()
    }
    if (subnets.length === 0) return []
    ranges = subnets.map(subnetPrefixToRange).filter((r): r is IpRange => r !== null)
  }
  if (ranges.length === 0) return []

  const ips: string[] = []
  for (const r of ranges) {
    for (let n = r.start; n <= r.end && ips.length < MAX_SCAN_ADDRESSES; n++) {
      ips.push(intToIpv4(n))
    }
  }
  if (ips.length === 0) return []

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

  /**
   * 启动 `adb track-devices` 长连接监听：设备列表的任何变化（USB 插拔、tcpip
   * connect/disconnect、device↔offline↔unauthorized 状态切换）都会立刻推送一条
   * 消息，取代 3 秒轮询，设备发现延迟从最长 3s 降到毫秒级。
   *
   * 消息格式：4 字节十六进制长度前缀 + 该长度的设备列表文本（与 `adb devices`
   * 输出相同）。连接建立后 adb 会先推一次当前列表。adb server 被杀时该进程退出
   * （触发 'close'），由调用方决定重启策略。
   *
   * 返回子进程，调用方负责 kill；仅监听 'error'（spawn 失败）与解析回调。
   */
  trackDevices(onChange: (devicesText: string) => void, onError: (err: Error) => void): ChildProcess {
    const child = spawn(this.path, ['track-devices'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let buf = Buffer.alloc(0)
    const feed = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        if (buf.length < 4) return
        const len = Number.parseInt(buf.subarray(0, 4).toString('ascii'), 16)
        // 长度前缀非法（不应发生）：丢弃缓冲防止错误状态死循环
        if (!Number.isFinite(len) || len < 0 || len > 1 << 20) {
          buf = Buffer.alloc(0)
          return
        }
        if (buf.length < 4 + len) return
        const payload = buf.subarray(4, 4 + len).toString('utf8')
        buf = buf.subarray(4 + len)
        onChange(payload)
      }
    }
    child.stdout.on('data', feed)
    // adb 偶尔往 stderr 打提示信息，只收集不处理（排障用）
    child.on('error', onError)
    return child
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

  async connect(hostPort: string, timeoutMs = 30000): Promise<AdbShellResult> {
    return this.exec(['connect', hostPort], timeoutMs)
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
    const buf = await this.execOut(serial, 'screencap -p', 30000)
    // 某些多屏设备的 screencap 会往 stdout 混入警告文本（如 "[Warning] Multiple
    // displays were found..."），污染 PNG 流 → 找到 PNG 签名截掉前缀。
    // 不清洗的话 nativeImage/浏览器解码失败或错解（模板截取/找图全挂）。
    const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    if (buf.length >= 8 && buf.compare(PNG_SIG, 0, 8, 0, 8) !== 0) {
      const i = buf.indexOf(PNG_SIG)
      if (i === -1) throw new Error('screencap 返回的不是 PNG 数据（可能被设备输出污染）')
      return buf.subarray(i)
    }
    return buf
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
