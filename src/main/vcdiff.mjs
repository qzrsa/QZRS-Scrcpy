/**
 * 差量引擎（纯函数，**不碰 fs、不碰网络**，所以能离线测）。
 *
 * ★ 为什么是 .mjs 而不是 .ts：这份代码要同时被两个世界用 ——
 *   ① 客户端（`src/main/updater.ts`，TS，经 Vite 打包）；
 *   ② 发布工具（`tools/make-update-manifest.mjs`，纯 Node ESM，CI 里直接跑，不能编译 TS）。
 *   两边各写一份的下场是"补丁生成器和补丁应用者慢慢对不上"——那是最难查的一类 bug
 *   （现象是"下载成功但还原结果校验失败"，看不出是谁的错）。所以只留**一份实现**，
 *   TS 侧通过 tsconfig 的 allowJs 直接 import，类型由下面的 JSDoc 提供。
 *
 * ★ 为什么必须是**块级**而不是文件级：
 *   一次真实更新里 42 个文件只有 2 个变了，而其中一个（`QZRS Scrcpy.exe`）有 180 MB，
 *   两版之间往往只差 VERSIONINFO 里几个版本号字节。文件级会把整份 exe 算进差量；
 *   块级只下真正不同的那几十 KiB。**数量级的差别就在这儿。**
 *
 * 分块用内容定义（CDC，Gear 滚动哈希），不用固定长度：
 * 固定长度遇到「中间插入几个字节」会让后面**全部错位**，复用率瞬间归零。
 *
 * 补丁 = 一串**统一 4 元组**指令 `[type, a, b, len]`（len **恒在 index 3**）：
 *   [0, oldIdx, start, len]  从「旧文件列表」第 oldIdx 个文件的 start 处拷 len 字节
 *   [1, packOffset, 0, len]  从补丁包 packOffset 处取 len 字节
 * ★ 一定统一：COPY 用 4 元组、DATA 用 3 元组的话，长度落在不同下标上，
 *   合并与还原各读各的 → 还原时算出 NaN 直接炸。**长度只用 index 3 表达。**
 * 相邻同类指令会合并，所以「只改了几处的大文件」只有寥寥几条指令。
 */
import { createHash } from 'node:crypto'

/* ---- 分块参数：平均约 10 KiB，最小 2 KiB，最大 32 KiB ---- */
export const MIN_CHUNK = 2048
export const MAX_CHUNK = 32768

/**
 * 切割条件用的掩码 —— **必须取哈希的高位，不能取低位**。
 * Gear 的递推是 `h = (h<<1) + GEAR[byte]`，左移意味着 h 的**最低位只由最后一个字节决定**，
 * 低位根本没被混匀。实测（目标都是平均 8192 字节切一次）：
 *   mask = 0x1FFF（低位）→ asar 每 41994 字节才切一次；换成高位后 9999，贴近期望值。
 * 切得比预期稀疏的后果很直接：块又大又粗，里面随便改一个字节整块作废
 * （用低位掩码时 app.asar 只切出 11 块，复用率 0/11 —— 差量对该文件完全失效）。
 */
export const MASK = 0x1fff0000

/**
 * Gear 表：用固定种子现场生成，保证**跨机器、跨版本可复现**。
 * ★ 绝不能写成随机值 —— 否则 CI 与本地算出的分块边界不同，补丁互相不认。
 */
const GEAR = (() => {
  const t = new Uint32Array(256)
  let h = 0x9e3779b9
  for (let i = 0; i < 256; i++) {
    h = (h ^ (h << 13)) >>> 0
    h = (h ^ (h >>> 17)) >>> 0
    h = (h ^ (h << 5)) >>> 0
    t[i] = h >>> 0
  }
  return t
})()

/**
 * @param {Buffer} buf
 * @returns {string}
 */
export const sha256hex = (buf) => createHash('sha256').update(buf).digest('hex')

/**
 * @param {Buffer} buf
 * @param {number} s
 * @param {number} e
 * @returns {string}
 */
const sha1hex = (buf, s, e) => createHash('sha1').update(buf.subarray(s, e)).digest('hex')

/**
 * 入口先校验形状。不校验的话，传错形状（比如把裸 Buffer 当 `{path,data}` 塞进来）
 * 会在很深的 crypto 里炸出一句 `Received undefined`，根本看不出是谁传错了。
 * @param {any} list
 * @param {string} who
 * @returns {{path:string,data:Buffer}[]}
 */
export function checkFiles(list, who) {
  if (!Array.isArray(list)) throw new TypeError(who + ' 必须是数组')
  list.forEach((f, i) => {
    if (!f || typeof f.path !== 'string' || !f.path) {
      throw new TypeError(`${who}[${i}] 缺少 path（每一项都要是 {path, data}）`)
    }
    if (!Buffer.isBuffer(f.data)) {
      throw new TypeError(`${who}[${i}]="${f.path}" 的 data 不是 Buffer（每一项都要是 {path, data}）`)
    }
  })
  return list
}

/**
 * 逐字节比两段区间（确认块匹配，顺带把哈希碰撞的可能性彻底消掉）
 * @param {Buffer} a
 * @param {number} aStart
 * @param {Buffer} b
 * @param {number} bStart
 * @param {number} len
 * @returns {boolean}
 */
export function regionEqual(a, aStart, b, bStart, len) {
  if (aStart + len > a.length || bStart + len > b.length) return false
  for (let i = 0; i < len; i++) if (a[aStart + i] !== b[bStart + i]) return false
  return true
}

/**
 * 内容定义分块。
 * @param {Buffer} buf
 * @returns {{start:number,len:number,h:string}[]}
 */
export function chunkify(buf) {
  /** @type {{start:number,len:number,h:string}[]} */
  const out = []
  let start = 0
  while (start < buf.length) {
    const hardEnd = Math.min(start + MAX_CHUNK, buf.length)
    let h = 0
    let cut = -1
    for (let i = start; i < hardEnd; i++) {
      h = (((h << 1) >>> 0) + GEAR[buf[i]]) >>> 0
      if (i - start + 1 >= MIN_CHUNK && (h & MASK) === 0) {
        cut = i + 1
        break
      }
    }
    const stop = cut === -1 ? hardEnd : cut
    out.push({ start, len: stop - start, h: sha1hex(buf, start, stop) })
    start = stop
  }
  return out
}

/**
 * 给「旧文件列表」建块索引：块哈希 -> 候选位置
 * @param {{path:string,data:Buffer}[]} oldFiles
 * @param {{maxCandidates?:number}} [opts]
 */
export function buildIndex(oldFiles, opts = {}) {
  const maxCandidates = opts.maxCandidates ?? 64
  /** @type {Map<string,{key:number,start:number,len:number}[]>} */
  const idx = new Map()
  checkFiles(oldFiles, 'oldFiles').forEach((f, key) => {
    for (const c of chunkify(f.data)) {
      let arr = idx.get(c.h)
      if (!arr) {
        arr = []
        idx.set(c.h, arr)
      }
      // 同一段内容在旧版本里重复很多次时（比如一堆零字节区），候选封顶，
      // 否则每个块的确认比对会退化成 O(n²)。
      if (arr.length < maxCandidates) arr.push({ key, start: c.start, len: c.len })
    }
  })
  return idx
}

/**
 * 生成「整个目录」的差量：一个 manifest（进 update.json）+ 一个 pack（二进制数据段）。
 * @param {{path:string,data:Buffer}[]} oldFiles 基准版本的文件（客户端本地的样子）
 * @param {{path:string,data:Buffer}[]} newFiles 目标版本的文件
 * @param {{dropFile?:(p:string)=>boolean}} [opts] dropFile 返回 true 表示整体跳过该路径
 * @returns {{manifest:any, pack:Buffer, stats:{oldFiles:number,newFiles:number,copyBytes:number,dataBytes:number}}}
 */
export function makeDirPatch(oldFiles, newFiles, opts = {}) {
  const drop = opts.dropFile || (() => false)
  const olds = checkFiles(oldFiles, 'oldFiles').filter((f) => !drop(f.path))
  const news = checkFiles(newFiles, 'newFiles').filter((f) => !drop(f.path))

  /** @type {Map<string,{i:number,data:Buffer,hash:string}>} */
  const oldByPath = new Map()
  olds.forEach((f, i) => oldByPath.set(f.path, { i, data: f.data, hash: sha256hex(f.data) }))
  const idx = buildIndex(olds)

  /** @type {Buffer[]} */
  const dataSegs = []
  let packSize = 0
  /** @param {Buffer} buf @param {number} s @param {number} e */
  const pushData = (buf, s, e) => {
    const seg = Buffer.from(buf.subarray(s, e))
    dataSegs.push(seg)
    const off = packSize
    packSize += seg.length
    return off
  }

  /** @type {any[]} */
  const files = []
  let copyBytes = 0
  let dataBytes = 0

  for (const nf of news) {
    const prev = oldByPath.get(nf.path)
    const nh = sha256hex(nf.data)
    if (prev && prev.data.length === nf.data.length && prev.hash === nh) {
      files.push({ path: nf.path, size: nf.data.length, sha256: nh, action: 'same' })
      continue
    }

    /** @type {number[][]} */
    const ops = []
    // 只在「紧邻的同类型指令」上合并；COPY 必须**同源同连续**才能并，
    // 否则会把两段不相邻的旧数据缝在一起，还原出来是错的。
    /** @param {number[]} op */
    const pushOp = (op) => {
      const last = ops[ops.length - 1]
      if (last && last[0] === op[0]) {
        if (op[0] === 0 && last[1] === op[1] && last[2] + last[3] === op[2]) {
          last[3] += op[3]
          return
        }
        if (op[0] === 1 && last[1] + last[3] === op[1]) {
          last[3] += op[3]
          return
        }
      }
      ops.push(op)
    }

    for (const c of chunkify(nf.data)) {
      /** @type {{key:number,start:number,len:number}|null} */
      let hit = null
      const cands = idx.get(c.h)
      if (cands) {
        for (const cd of cands) {
          if (cd.len !== c.len) continue
          const src = olds[cd.key].data
          if (regionEqual(src, cd.start, nf.data, c.start, c.len)) {
            hit = cd
            break
          }
        }
      }
      if (hit) {
        pushOp([0, hit.key, hit.start, c.len])
        copyBytes += c.len
      } else {
        pushOp([1, pushData(nf.data, c.start, c.start + c.len), 0, c.len])
        dataBytes += c.len
      }
    }

    files.push({ path: nf.path, size: nf.data.length, sha256: nh, action: 'patch', ops })
  }

  const newPaths = new Set(news.map((f) => f.path))
  const removed = olds.map((f) => f.path).filter((p) => !newPaths.has(p))
  const pack = Buffer.concat(dataSegs)

  return {
    manifest: {
      version: 1,
      olds: olds.map((f) => ({ path: f.path, size: f.data.length, sha256: oldByPath.get(f.path).hash })),
      files,
      removed,
      pack: { size: pack.length, sha256: sha256hex(pack) }
    },
    pack,
    stats: { oldFiles: olds.length, newFiles: news.length, copyBytes, dataBytes }
  }
}

/**
 * 应用差量补丁。
 *
 * ★ 基准文件的哈希**必须**先验：本地文件被动过 / 版本对不上就打不上，
 *   必须在这里抛错让上层**退回全量下载**，绝不能硬打出一个半残的程序。
 *
 * @param {{get:(p:string)=>Buffer|null, release?:(p:string)=>void}} localStore
 *        按 manifest.olds 的 path 取本机字节。可选 `release(p)`：
 *        每个目标文件还原完之后会调用它，让调用方放掉缓存 ——
 *        这样峰值内存只跟"单个文件 + 它的源"有关，而不是整个程序目录（实测 355 MB）。
 * @param {any} manifest makeDirPatch 产出的 manifest
 * @param {Buffer} pack
 * @param {{skipOldVerify?:boolean, onFile?:(path:string,data:Buffer)=>void}} [opts]
 *        skipOldVerify：调用方已经用**流式**哈希验过基准（不占内存），这里就不必把
 *        42 个文件全读进内存再拼起来；onFile：边还原边交出（立刻写盘），不累积結果。
 * @returns {{path:string,data:Buffer}[]} 需要写盘的文件（给了 onFile 时恒为空数组）
 */
export function applyDirPatch(localStore, manifest, pack, opts = {}) {
  if (manifest.version !== 1) throw new Error('差量清单版本不支持: ' + manifest.version)
  if (!Buffer.isBuffer(pack)) throw new TypeError('pack 必须是 Buffer')
  const got = sha256hex(pack)
  if (manifest.pack && manifest.pack.sha256 !== got) {
    throw new Error('补丁包校验失败：期望 ' + manifest.pack.sha256 + '，实际 ' + got)
  }

  if (!opts.skipOldVerify) {
    manifest.olds.forEach((o) => {
      const buf = localStore.get(o.path)
      if (!buf) throw new Error('缺少基准文件: ' + o.path)
      if (buf.length !== o.size) throw new Error('基准文件大小不符: ' + o.path)
      if (sha256hex(buf) !== o.sha256) throw new Error('基准文件已被改动: ' + o.path)
    })
  }

  const onFile = typeof opts.onFile === 'function' ? opts.onFile : null
  const release = typeof localStore.release === 'function' ? localStore.release.bind(localStore) : null

  /** @type {{path:string,data:Buffer}[]} */
  const out = []
  for (const f of manifest.files) {
    if (f.action !== 'patch') continue
    const buf = Buffer.allocUnsafe(f.size)
    let pos = 0
    /** 这一份文件用到的源（还原完就放掉） @type {Set<string>} */
    const touched = new Set()
    for (const op of f.ops) {
      if (op.length !== 4) throw new Error('指令格式错误（应为 4 元组）: ' + f.path)
      if (op[0] === 0) {
        const srcPath = manifest.olds[op[1]].path
        const src = localStore.get(srcPath)
        if (!src) throw new Error('缺少 COPY 源文件: ' + srcPath)
        src.copy(buf, pos, op[2], op[2] + op[3])
        touched.add(srcPath)
      } else if (op[0] === 1) {
        if (op[1] + op[3] > pack.length) throw new Error('补丁包越界: ' + f.path)
        pack.copy(buf, pos, op[1], op[1] + op[3])
      } else {
        throw new Error('未知指令类型 ' + op[0] + ': ' + f.path)
      }
      pos += op[3]
    }
    if (pos !== f.size) throw new Error('指令流长度不符: ' + f.path + ' (' + pos + ' != ' + f.size + ')')
    // ★ 逐文件校验：这是整条链上唯一能证明"还原对了"的地方。
    //   放过了它，就等于把一份看起来像程序、其实拼错的东西写进用户的安装目录。
    if (sha256hex(buf) !== f.sha256) throw new Error('还原结果校验失败: ' + f.path)

    if (onFile) onFile(f.path, buf)
    else out.push({ path: f.path, data: buf })

    if (release) touched.forEach((p) => release(p))
  }
  return out
}

/**
 * 判定「值不值得走增量」：差量包占全量比例超过阈值就老实下全量。
 * ★ 判据是**占比**而不是「文件大不大」—— 实测里 180 MB 的 exe 可能只差几十 KiB。
 * @param {number} packSize
 * @param {number} fullSize
 * @param {number} [limit]
 * @returns {boolean}
 */
export function shouldUseDelta(packSize, fullSize, limit = 0.6) {
  if (!(fullSize > 0) || !(packSize >= 0)) return false
  return packSize / fullSize <= limit
}
