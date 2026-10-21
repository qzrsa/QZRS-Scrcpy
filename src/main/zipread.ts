import { inflateRawSync } from 'node:zlib'

/**
 * 极简 ZIP 读取器（只支持 store / deflate，不支持 zip64）。
 *
 * 为什么自己写：绿色版更新包是 CI 用 `.NET ZipFile::CreateFromDirectory` 打的 zip，
 * 而 Electron/Node 没有内置解压。引一个 npm 包只为了解一次 zip 不划算，
 * 而这套格式的读取部分本来就很小（中央目录里有权威的 offset / 长度 / 压缩方式）。
 *
 * ★ 安全性说明：这里**不做 CRC 校验**，因为校验比 CRC 强得多 ——
 *   整个 zip 的 sha256 在下载阶段已经比对过，解开之后每个文件还会按清单里的
 *   sha256 逐个核对（见 updater.ts 的 stageFull）。CRC 只能发现传输损坏，
 *   而那两个哈希能发现"内容不对"。
 *
 * ★ zip64 直接报错而不是硬解：绿色版解压后约 370 MB，单个文件最大十几 MB，
 *   正常打包不会触发 zip64。真遇到了说明包被动过 —— 让用户去 Release 手下一个更安全。
 */

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50

export interface ZipEntry {
  name: string
  /** 解压后的字节 */
  data: Buffer
}

function findEocd(buf: Buffer): number {
  // EOCD 末尾可能跟最多 65535 字节的注释，所以从后往前在 64KB 窗口里找
  const min = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  return -1
}

/**
 * 解压整个 zip，逐个条目回调。
 *
 * 用回调而不是返回数组，是为了让调用方能**边解边丢**：370 MB 的包全塞进内存
 * 没必要，调用方算完 sha256 就可以不管这一条了（峰值只有一个文件）。
 */
export function readZip(buf: Buffer, onEntry: (e: ZipEntry) => void): { entries: number } {
  if (buf.length < 22) throw new Error('不是有效的 zip（文件太小）')
  const eocd = findEocd(buf)
  if (eocd < 0) throw new Error('不是有效的 zip（找不到目录结尾记录）')

  const count = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)

  if (count === 0xffff || cdOffset === 0xffffffff) {
    throw new Error('这个 zip 用了 zip64 格式，内置解压不支持；请到 Release 页面手动下载')
  }
  if (cdOffset >= buf.length) throw new Error('zip 目录偏移越界（文件可能被截断）')

  let p = cdOffset
  let n = 0
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length) throw new Error('zip 中央目录被截断')
    if (buf.readUInt32LE(p) !== CEN_SIG) throw new Error('zip 中央目录签名不对（偏移算错了）')

    const method = buf.readUInt16LE(p + 10)
    let compSize = buf.readUInt32LE(p + 20)
    let uncompSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)

    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error(`zip64 条目不受支持：${name}`)
    }
    p += 46 + nameLen + extraLen + commentLen

    // 目录条目本身没有数据
    if (name.endsWith('/')) continue

    if (localOffset + 30 > buf.length) throw new Error(`zip 条目偏移越界：${name}`)
    if (buf.readUInt32LE(localOffset) !== LOC_SIG) throw new Error(`zip 条目头签名不对：${name}`)
    const lNameLen = buf.readUInt16LE(localOffset + 26)
    const lExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + lNameLen + lExtraLen
    const dataEnd = dataStart + compSize
    if (dataEnd > buf.length) throw new Error(`zip 条目数据越界：${name}`)

    const raw = buf.subarray(dataStart, dataEnd)
    let data: Buffer
    if (method === 0) {
      data = raw
    } else if (method === 8) {
      data = inflateRawSync(raw) as Buffer
    } else {
      throw new Error(`zip 条目用了不支持的压缩方式 ${method}：${name}`)
    }
    if (data.length !== uncompSize) {
      throw new Error(`zip 条目解压后大小不符（${data.length} != ${uncompSize}）：${name}`)
    }
    onEntry({ name, data })
    n++
  }
  return { entries: n }
}
