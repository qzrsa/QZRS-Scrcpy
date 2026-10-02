/**
 * 扫描网段的解析工具。
 *
 * 为什么放在 shared：设置页要在用户**输入时**就告诉他"这段会扫多少个地址、大概多久"，
 * 主进程扫描时要做**同一套**解析与合并。两边共用一份实现，预览才不会和实际行为不一致。
 *
 * 支持写法（会在设置页归一化后回显）：
 *   `192.168.50`            → 192.168.50.0/24（3 段常见简写，与自动检测网段同构）
 *   `192.168.50.0/24`       → 原样
 *   `192.168.50.7/24`       → 归一化成 192.168.50.0/24
 *   `192.168.50.7`          → 192.168.50.7（单台设备）
 *   `10.0.0.0/255.0.0.0`    → 等价 /8（接受点分掩码）
 *   多行 / 逗号 / 分号 / 空格分隔均可
 */

/** 一个闭区间地址段（32 位无符号整数，含首尾） */
export interface IpRange {
  /** 起始地址（含），如 192.168.50.1 → 0xC0A83201 */
  start: number
  /** 结束地址（含） */
  end: number
}

/** 用户额外扫描网段的单条解析结果 */
export interface SubnetEntry {
  /** 用户原始输入（已 trim） */
  raw: string
  /** 归一化后的展示串，如 "192.168.50.0/24" / "192.168.50.7" */
  display: string
  range: IpRange
  /** 该段包含的地址个数 */
  count: number
}

export interface SubnetError {
  raw: string
  message: string
}

export interface ParsedSubnets {
  /** 解析成功的条目（已按区间去重，保持输入顺序） */
  entries: SubnetEntry[]
  /** 扫描用：合并重叠/相邻后的区间 */
  ranges: IpRange[]
  /** 展示用串，与 entries 一一对应 */
  display: string[]
  errors: SubnetError[]
  /** entries 的地址总数（合并前） */
  totalAddresses: number
  /** totalAddresses 超上限 */
  overLimit: boolean
}

/**
 * 用户手填网段的地址总量上限（约 /20）。
 *
 * 上限存在的理由很实际：填个 `10.0.0.0/8` 是 1600 万个地址，按 128 并发 × 400ms 要跑
 * 十几个小时。全 TCP 探测没有"更聪明的扫法"，只能拒绝过大输入。
 * 4096 个地址的最坏耗时约 13 秒（见 estimateScanMs），已经接近可接受的上限。
 */
export const MAX_EXTRA_ADDRESSES = 4096

/** 扫描默认并发数与单地址超时（与 adb.ts 的 scanLanAdb 默认值保持一致，用于耗时预估） */
export const SCAN_CONCURRENCY = 128
export const SCAN_TIMEOUT_MS = 400

/** IPv4 点分十进制 → 32 位无符号整数；非法返回 null */
export function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const v = Number(p)
    if (v > 255) return null
    n = ((n << 8) | v) >>> 0
  }
  return n
}

/** 32 位无符号整数 → IPv4 点分十进制 */
export function intToIpv4(n: number): string {
  const v = n >>> 0
  return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.')
}

/** 点分掩码 → 前缀长度；不是连续的 1（如 255.0.255.0）返回 null */
export function netmaskToPrefix(mask: string): number | null {
  const n = ipv4ToInt(mask)
  if (n === null) return null
  let prefix = 0
  let seenZero = false
  for (let i = 31; i >= 0; i--) {
    if (((n >>> i) & 1) === 1) {
      if (seenZero) return null
      prefix++
    } else {
      seenZero = true
    }
  }
  return prefix
}

/**
 * 自动检测到的网段前缀（"192.168.11" / "127.0"）→ 扫描区间。
 *
 * 刻意**跳过网络号与广播地址**（`.0` / `.255`），与改造前的行为完全一致：
 * 老代码就是 `for i = 1..254`。
 */
export function subnetPrefixToRange(prefix: string): IpRange | null {
  const octets = prefix.split('.')
  if (octets.length < 1 || octets.length > 4) return null
  const padded = [...octets, ...Array(4 - octets.length).fill('0')].join('.')
  const base = ipv4ToInt(padded)
  if (base === null) return null
  return { start: base + 1, end: base + 254 }
}

type OneResult = { entry: SubnetEntry } | { error: SubnetError }

/** 解析单条输入。 */
function parseOne(raw: string): OneResult {
  const text = raw.trim()
  const slash = text.indexOf('/')
  const addrPart = slash === -1 ? text : text.slice(0, slash)
  const maskPart = slash === -1 ? '' : text.slice(slash + 1).trim()

  const octets = addrPart.split('.')
  if (octets.length !== 3 && octets.length !== 4) {
    return {
      error: {
        raw: text,
        message: `「${text}」不是合法地址（应为 192.168.50 或 192.168.50.7，可加 /24 掩码）`
      }
    }
  }
  for (const o of octets) {
    if (!/^\d{1,3}$/.test(o) || Number(o) > 255) {
      return { error: { raw: text, message: `「${text}」里有非法数字段「${o}」（每段 0-255）` } }
    }
  }

  let prefix: number
  if (maskPart === '') {
    // 3 段是「一个 /24 网段」的常用简写；4 段不带掩码按单台设备处理。
    prefix = octets.length === 3 ? 24 : 32
  } else if (/^\d{1,2}$/.test(maskPart)) {
    prefix = Number(maskPart)
    if (prefix > 32) {
      return { error: { raw: text, message: `「${text}」的掩码 /${maskPart} 超出范围（0-32）` } }
    }
  } else {
    const m = netmaskToPrefix(maskPart)
    if (m === null) {
      return {
        error: {
          raw: text,
          message: `「${text}」的掩码「${maskPart}」不是连续的子网掩码（应形如 255.255.255.0）`
        }
      }
    }
    prefix = m
  }

  const full = octets.length === 3 ? `${addrPart}.0` : addrPart
  const ip = ipv4ToInt(full)
  if (ip === null) return { error: { raw: text, message: `「${text}」不是合法 IPv4 地址` } }

  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  const network = (ip & mask) >>> 0
  const broadcast = (network | (~mask >>> 0)) >>> 0

  // /31、/32 没有网络号/广播号的概念（RFC 3021），整块都要扫；
  // /30 及更宽的段跳过首尾两个地址（与自动检测网段的行为、以及 nmap 的默认一致）。
  const skipEdges = prefix <= 30
  const start = skipEdges ? network + 1 : network
  const end = skipEdges ? broadcast - 1 : broadcast

  return {
    entry: {
      raw: text,
      display: prefix === 32 ? intToIpv4(network) : `${intToIpv4(network)}/${prefix}`,
      range: { start, end },
      count: end - start + 1
    }
  }
}

/**
 * 解析用户填写的额外扫描网段。
 *
 * 输入可以是多行字符串，也可以是设置里存的字符串数组（一行一个）。
 * 行内再用空格 / 逗号 / 分号 / 中文顿号分隔，容错优先——用户从别处粘贴一段带空格的文本也能用。
 */
export function parseSubnets(input: unknown): ParsedSubnets {
  const lines: string[] = Array.isArray(input)
    ? input.map((x) => String(x))
    : typeof input === 'string'
      ? input.split('\n')
      : []

  const tokens: string[] = []
  for (const line of lines) {
    for (const t of line.split(/[\s,;、]+/)) {
      if (t.trim()) tokens.push(t.trim())
    }
  }

  const entries: SubnetEntry[] = []
  const errors: SubnetError[] = []
  const seen = new Set<string>()
  for (const t of tokens) {
    const r = parseOne(t)
    if ('error' in r) {
      errors.push(r.error)
      continue
    }
    const key = `${r.entry.range.start}-${r.entry.range.end}`
    if (seen.has(key)) continue
    seen.add(key)
    entries.push(r.entry)
  }

  const totalAddresses = entries.reduce((a, e) => a + e.count, 0)
  return {
    entries,
    ranges: mergeRanges(entries.map((e) => e.range)),
    display: entries.map((e) => e.display),
    errors,
    totalAddresses,
    overLimit: totalAddresses > MAX_EXTRA_ADDRESSES
  }
}

/** 合并重叠或首尾相接的区间（结果按 start 升序，区间互不相邻）。返回新数组，不改入参。 */
export function mergeRanges(ranges: IpRange[]): IpRange[] {
  const sorted = ranges
    .filter((r) => r && r.end >= r.start)
    .map((r) => ({ start: r.start, end: r.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end)
  const out: IpRange[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r.start <= last.end + 1) {
      if (r.end > last.end) last.end = r.end
    } else {
      out.push(r)
    }
  }
  return out
}

/** 区间包含的地址总数。 */
export function countRanges(ranges: IpRange[]): number {
  return ranges.reduce((a, r) => a + (r.end - r.start + 1), 0)
}

/**
 * 预估扫描耗时（毫秒）。按"每批并发都跑满 timeoutMs"的最坏情况估算——
 * 实际活跃主机秒回会明显更快，所以这个数字只会偏大，用来劝退过大的输入正好。
 */
export function estimateScanMs(
  addresses: number,
  concurrency = SCAN_CONCURRENCY,
  timeoutMs = SCAN_TIMEOUT_MS
): number {
  if (addresses <= 0) return 0
  return Math.ceil(addresses / concurrency) * timeoutMs
}

/** 毫秒 → 人读的时长串（设置页与提示文案共用）。 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} 毫秒`
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} 秒`
  return `${(ms / 60000).toFixed(1)} 分钟`
}
