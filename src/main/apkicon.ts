/**
 * 应用图标提取（APK 资源解析）
 *
 * 现代 App 经 AAPT2 资源混淆后，图标文件不再是 `ic_launcher.png` 这种可猜文件名，
 * 而是短随机名（如 `res/BWP.xml`、`res/zra.png`）。要可靠拿到图标，必须：
 *
 *   1. 解析 AndroidManifest.xml（binary XML）→ application 元素的 `android:icon` 资源 ID
 *   2. 解析 resources.arsc → 把资源 ID 映射到真实文件路径（可能跨多个 density config）
 *   3. 若路径是 adaptive icon XML（`*.xml`），再解析它的 foreground → 资源 ID → PNG 路径
 *
 * 全部逻辑为纯函数，输入是 exec-out 提取出的干净二进制 Buffer。
 * 结构参照 AOSP ResourceTypes.h（ResChunk_header / ResStringPool / ResTable_type）。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 资源引用（manifest/XML 属性里的 `@0x7f...` 值） */
export interface ResRef {
  /** 值类型：0x01=resource reference，0x03=string，0x10=attribute... */
  type: number
  /** 值内容（type=0x01 时是资源 ID） */
  data: number
}

export interface IconPathResult {
  /** 提取到的图标文件路径（APK 内路径，如 res/xxx.png），未找到则为 null */
  path: string | null
  /** 该资源 ID 在所有 config 下的候选路径（诊断用） */
  candidates: string[]
}

// ---------------------------------------------------------------------------
// String Pool
// ---------------------------------------------------------------------------

interface StringPool {
  get: (idx: number) => string | null
  count: number
}

/** 解析 ResStringPool（支持 UTF-8 双长度前缀 + UTF-16） */
function readStringPool(buf: Buffer, offset: number): StringPool {
  const stringCount = buf.readUInt32LE(offset + 8)
  const flags = buf.readUInt32LE(offset + 16)
  const stringsStart = buf.readUInt32LE(offset + 20)
  const isUtf8 = (flags & 0x100) !== 0
  const base = offset + stringsStart
  const offsets: number[] = []
  for (let i = 0; i < stringCount; i++) {
    offsets.push(buf.readUInt32LE(offset + 28 + 4 * i))
  }
  const get = (idx: number): string | null => {
    if (idx < 0 || idx >= stringCount) return null
    const sOff = base + offsets[idx]
    if (isUtf8) {
      // UTF-8：u16len (varint 1~2B) + u8len (varint 1~2B) + data
      const b0 = buf[sOff]
      let p = sOff + (b0 & 0x80 ? 2 : 1)
      const b1 = buf[p]
      let u8len: number
      if (b1 & 0x80) {
        u8len = ((b1 & 0x7f) << 8) | buf[p + 1]
        p += 2
      } else {
        u8len = b1
        p += 1
      }
      return buf.subarray(p, p + u8len).toString('utf8')
    }
    // UTF-16：2 字节单元数前缀
    const len = buf.readUInt16LE(sOff)
    const ds = sOff + 2
    return buf.subarray(ds, ds + len * 2).toString('utf16le')
  }
  return { get, count: stringCount }
}

// ---------------------------------------------------------------------------
// Binary XML（AndroidManifest.xml / adaptive icon XML）
// ---------------------------------------------------------------------------

const START_ELEMENT = 0x0102
const RESOURCE_MAP = 0x0180

/**
 * 在 binary XML 里查找某个元素的某个属性值。
 * @param elementName 目标元素名（如 'application'）
 * @param attrName    目标属性名（如 'icon'）
 * @returns 属性值（ResRef），未找到返回 null
 */
function findXmlAttr(buf: Buffer, elementName: string, attrName: string): ResRef | null {
  const headerSize = buf.readUInt16LE(2)
  const xmlSize = buf.readUInt32LE(4)
  const sp = readStringPool(buf, headerSize)
  // 跳过 string pool
  const spHeader = readChunkHeader(buf, headerSize)
  let pos = headerSize + spHeader.size
  // 跳过 ResourceMap chunk（可选）
  const rm = readChunkHeader(buf, pos)
  if (rm.type === RESOURCE_MAP) pos += rm.size

  while (pos + 16 <= xmlSize) {
    const nodeType = buf.readUInt16LE(pos)
    const nodeSize = buf.readUInt32LE(pos + 4)
    if (nodeType === START_ELEMENT) {
      const attrExt = pos + 16
      // nsIdx(4) nameIdx(4) attrStart(2) attrSize(2) attrCount(2) idIdx(2) classIdx(2) styleIdx(2)
      const nameIdx = buf.readUInt32LE(attrExt + 4)
      const attrStart = buf.readUInt16LE(attrExt + 8)
      const attrSize = buf.readUInt16LE(attrExt + 10)
      const attrCount = buf.readUInt16LE(attrExt + 12)
      const elemName = sp.get(nameIdx)
      if (elemName === elementName) {
        for (let i = 0; i < attrCount; i++) {
          const aOff = attrExt + 20 + i * attrSize
          const aName = buf.readUInt32LE(aOff + 4)
          // Res_value: size(2) res0(1) dataType(1) data(4)
          const dataType = buf.readUInt8(aOff + 15)
          const data = buf.readUInt32LE(aOff + 16)
          if (sp.get(aName) === attrName) {
            return { type: dataType, data }
          }
        }
      }
    }
    pos += nodeSize
  }
  return null
}

/** 解析 manifest 的 application.icon 资源 ID */
export function parseManifestIcon(buf: Buffer): ResRef | null {
  return findXmlAttr(buf, 'application', 'icon')
}

/** 解析 adaptive icon XML 的 foreground.drawable 资源 ID */
export function parseAdaptiveForeground(buf: Buffer): ResRef | null {
  return findXmlAttr(buf, 'foreground', 'drawable')
}

// ---------------------------------------------------------------------------
// resources.arsc
// ---------------------------------------------------------------------------

const RES_TABLE_PACKAGE = 0x0200
const RES_TABLE_TYPE = 0x0201 // 注意：0x0201 才是存 entry 数据的 TYPE（0x0202 是 spec flags）
const TYPE_STRING = 0x03
const TYPE_REFERENCE = 0x01
const FLAG_SPARSE = 0x01
const FLAG_OFFSET16 = 0x02
const NO_ENTRY = 0xffffffff

function readChunkHeader(buf: Buffer, pos: number): { type: number; headerSize: number; size: number } {
  return {
    type: buf.readUInt16LE(pos),
    headerSize: buf.readUInt16LE(pos + 2),
    size: buf.readUInt32LE(pos + 4)
  }
}

/**
 * 解析 arsc，返回 resId 对应的文件路径（TYPE_STRING 值 = 全局 string pool 里的路径字符串）。
 * 会收集该资源在所有 density/locale config 下的候选，按出现顺序返回。
 */
export function parseArscIconPaths(buf: Buffer, resId: number): string[] {
  const results: string[] = []
  const gsp = readStringPool(buf, 12)
  const { size: gss } = readChunkHeader(buf, 12)
  let pos = 12 + gss

  // 遍历 package chunk
  while (pos + 8 <= buf.length) {
    const pk = readChunkHeader(buf, pos)
    if (pk.type !== RES_TABLE_PACKAGE) {
      pos += pk.size
      continue
    }
    const pkgEnd = pos + pk.size
    const typeId = (resId >> 16) & 0xff
    const entryId = resId & 0xffff
    let p = pos + pk.headerSize

    // 遍历 package 内的 chunk
    while (p + 8 <= pkgEnd) {
      const c = readChunkHeader(buf, p)
      if (c.type === RES_TABLE_TYPE) {
        const tid = buf.readUInt8(p + 8)
        const flags = buf.readUInt8(p + 9)
        const entryCount = buf.readUInt32LE(p + 12)
        const entriesStart = buf.readUInt32LE(p + 16)
        const cfgSize = buf.readUInt32LE(p + 20)
        if (tid === typeId && entryId < entryCount) {
          const eoBase = p + 20 + cfgSize
          let entryPos = -1
          if (flags & FLAG_OFFSET16) {
            const eo = buf.readUInt16LE(eoBase + 2 * entryId)
            entryPos = p + entriesStart + eo * 4
          } else if (flags & FLAG_SPARSE) {
            const n = (c.headerSize - 20 - cfgSize) >> 2
            for (let i = 0; i < n; i++) {
              const idx = buf.readUInt16LE(eoBase + 4 * i)
              const off = buf.readUInt16LE(eoBase + 4 * i + 2)
              if (idx === entryId) {
                entryPos = p + entriesStart + off * 4
                break
              }
            }
          } else {
            const eo = buf.readUInt32LE(eoBase + 4 * entryId)
            if (eo !== NO_ENTRY) entryPos = p + entriesStart + eo
          }
          if (entryPos >= 0) {
            // entry 头: size(2) flags(2) key(4) = 8 字节；value 紧随其后
            const vSize = buf.readUInt16LE(entryPos + 8)
            const vDataType = buf.readUInt8(entryPos + 11)
            const vData = buf.readUInt32LE(entryPos + 12)
            void vSize
            if (vDataType === TYPE_STRING) {
              const s = gsp.get(vData)
              if (s) results.push(s)
            } else if (vDataType === TYPE_REFERENCE) {
              results.push(`@0x${vData.toString(16)}`)
            }
          }
        }
      }
      p += c.size
    }
    pos = pkgEnd
  }
  return results
}

// ---------------------------------------------------------------------------
// 高层组合
// ---------------------------------------------------------------------------

/** 判断路径是否为位图文件（png/webp/jpg），而非 XML / 目录 / 其他 */
export function isBitmapPath(path: string): boolean {
  return /\.(png|webp|jpg|jpeg|gif)$/i.test(path)
}

/**
 * 从 manifest + arsc 组合出最合适的图标路径。
 *
 * 优先策略：
 *  1. 资源 ID 对应的所有候选里，优先选位图（png/webp）——旧 Android 的 legacy 图标常与
 *     adaptive icon XML 并存，直接用位图最省事。
 *  2. 若只有 XML（纯 adaptive icon），返回该 XML 路径，由调用方再解析 foreground。
 */
export function chooseIconPath(candidates: string[]): string | null {
  const bitmaps = candidates.filter(isBitmapPath)
  if (bitmaps.length > 0) return bitmaps[0]
  const xml = candidates.find((c) => c.endsWith('.xml'))
  return xml ?? candidates[0] ?? null
}
