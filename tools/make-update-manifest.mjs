#!/usr/bin/env node
/**
 * 生成自更新清单 `update.json`（可选：顺带生成**差量包**）。
 *
 *   node tools/make-update-manifest.mjs \
 *        --new ../release/QZRS-Scrcpy-Green-20261021001 \
 *        --zip ../release/QZRS-Scrcpy-Green-20261021001.zip \
 *        --out ../release \
 *        [--old-zip ../release/prev.zip --from 1.3.0]
 *
 * 为什么需要它：绿色版是"目录即程序"，没有安装器，也就没人帮它算清单。
 * 清单里给出**目标版本每个文件的 sha256** —— 客户端下完 zip 后先验整包哈希，
 * 解包后再按这份清单逐文件核对，才有资格去替换正在运行的程序。
 *
 * ★ 硬校验两条，任何一条不过就退出：
 *   ① 目录必须是完整的打包产物（`QZRS Scrcpy.exe` + `resources/app.asar` 都在）；
 *   ② 顶层不许出现运行时目录（keymaps / scripts / logs / ocr-models / .update）——
 *      它们一旦进了清单，客户端会把用户的私人数据当程序文件去校验/覆盖。
 *   这两条都是"宁可报错，也不要出一份毒清单"。
 *
 * ★ zip 必须已经存在：全量回退路径要能校验。没有 zip 就没有可信的兜底，
 *   客户端拿到它会陷入"包不敢下、清单又对不上"的死角。
 *
 * ---- 差量包（可选）----
 * 给了 `--old-zip`（上一版**绿色版 zip**）+ `--from`（上一版版本号）就额外出一个
 * `QZRS-Scrcpy-Delta-<from>-to-<ver>.bin` 并把它的说明内联进 update.json 的 `patches[]`。
 *
 * ★ 分块算法用的是 `src/main/vcdiff.mjs` —— **和客户端还原时是同一份代码**。
 *   如果这里换一份"差不多"的实现，补丁就会在用户机器上校验失败，
 *   而现象只是"下载成功但更新失败"，极难定位。
 * ★ 差量的一切失败都只 warn 不退出：它是省流量的优化，全量永远是兜底。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { readZip } from '../src/main/zipread.mjs'
import { makeDirPatch, sha256hex } from '../src/main/vcdiff.mjs'

/**
 * 与 `src/main/updater-core.ts` 的 PROTECTED_TOP **必须一致**。
 * （`tools/verify-updater.mjs` 会逐项比对两份名单，漂移了会直接失败。）
 */
const PROTECTED_TOP = ['keymaps', 'scripts', 'logs', 'ocr-models', '.update']

const argv = process.argv.slice(2)
const arg = (name, def = null) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def
}

const NEW_DIR = arg('new')
const ZIP = arg('zip')
const OUT_DIR = arg('out', NEW_DIR ? path.join(NEW_DIR, '..') : '.')
/** 上一版绿色版 zip（差量基准）。给了才会生成差量包 */
const OLD_ZIP = arg('old-zip')
/** 上一版版本号（客户端按 `app.getVersion()` 精确匹配，所以必须一字不差） */
const FROM = arg('from')

if (!NEW_DIR || !ZIP) {
  console.error('用法: node tools/make-update-manifest.mjs --new <绿色版目录> --zip <绿色版zip> [--out <输出目录>] [--old-zip <上一版zip> --from <上一版版本>]')
  process.exit(2)
}
if (!fs.existsSync(NEW_DIR)) {
  console.error(`[清单] 绿色版目录不存在: ${NEW_DIR}`)
  process.exit(1)
}
if (!fs.existsSync(ZIP)) {
  console.error(`[清单] 找不到绿色版 zip: ${ZIP}（先打 zip，全量回退需要它的 sha256）`)
  process.exit(1)
}

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const APP_NAME = pkg.build?.productName || pkg.productName || 'QZRS Scrcpy'
const VERSION = pkg.version

/* ---------------------------------------------------------------- 硬校验 */

for (const need of [`${APP_NAME}.exe`, path.join('resources', 'app.asar')]) {
  if (!fs.existsSync(path.join(NEW_DIR, need))) {
    console.error(`[清单] 绿色版目录不完整，缺少: ${need}`)
    process.exit(1)
  }
}

const topEntries = fs.readdirSync(NEW_DIR, { withFileTypes: true })
const leaked = topEntries.filter((e) => e.isDirectory() && PROTECTED_TOP.includes(e.name)).map((e) => e.name)
if (leaked.length) {
  console.error(
    `[清单] 绿色版目录里出现了运行时目录: ${leaked.join('、')}\n` +
      '       它们属于用户数据，绝不能进程序清单。请用**干净打包**的目录（win-unpacked）重跑。'
  )
  process.exit(1)
}

/* ---------------------------------------------------------------- 收集文件 */

const sha256File = (p) => {
  const h = crypto.createHash('sha256')
  const fd = fs.openSync(p, 'r')
  try {
    const BUF = 1 << 20
    const b = Buffer.allocUnsafe(BUF)
    let n
    while ((n = fs.readSync(fd, b, 0, BUF, null)) > 0) h.update(b.subarray(0, n))
  } finally {
    fs.closeSync(fd)
  }
  return h.digest('hex')
}

const files = []
const walk = (abs, rel) => {
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${e.name}` : e.name
    const childAbs = path.join(abs, e.name)
    if (e.isDirectory()) {
      walk(childAbs, childRel)
      continue
    }
    if (!e.isFile()) continue
    const st = fs.statSync(childAbs)
    files.push({ path: childRel, size: st.size, sha256: sha256File(childAbs) })
  }
}
walk(NEW_DIR, '')
files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

if (!files.length) {
  console.error('[清单] 绿色版目录里没有文件')
  process.exit(1)
}

const zipStat = fs.statSync(ZIP)
const zipSha = sha256File(ZIP)
const mib = (n) => (n / 1048576).toFixed(2) + ' MiB'

const manifest = {
  schema: 1,
  app: APP_NAME,
  channel: 'green',
  version: VERSION,
  unpackedSize: files.reduce((s, f) => s + f.size, 0),
  // 全量路径：直接下这个 zip，解包后按下面的 files 逐个校验
  full: { asset: path.basename(ZIP), size: zipStat.size, sha256: zipSha },
  files
}

/* ---------------------------------------------------------------- 差量包 */

// 差量包要写进这个目录，所以必须先建好（否则 fs.writeFileSync 直接 ENOENT）
fs.mkdirSync(OUT_DIR, { recursive: true })

/** 顶层是不是受保护目录（与 updater-core.PROTECTED_TOP 同一判断） */
const isProtectedRel = (rel) => PROTECTED_TOP.includes(rel.replace(/\\/g, '/').replace(/^\/+/, '').split('/')[0])

/**
 * 生成差量包并挂到 manifest.patches 上。
 * ★ 任何异常都由调用方兜住 —— 差量失败不能让发布失败。
 */
function buildPatch() {
  const t0 = Date.now()

  // 1. 上一版（绿色版 zip 里的样子 = 用户手上的样子）。受保护目录一律不参与。
  const oldFiles = []
  const oldZip = fs.readFileSync(OLD_ZIP)
  readZip(oldZip, ({ name, data }) => {
    const rel = name.replace(/\\/g, '/')
    if (!rel || rel.endsWith('/')) return
    if (isProtectedRel(rel)) return
    oldFiles.push({ path: rel, data })
  })
  if (!oldFiles.length) throw new Error('上一版 zip 里没有可用文件')

  // 2. 目标版本（真正读盘；makeDirPatch 需要字节，不能只给哈希）
  const newFiles = files.map((f) => ({
    path: f.path,
    data: fs.readFileSync(path.join(NEW_DIR, ...f.path.split('/')))
  }))

  // 3. 分块 + 比对（与客户端还原共用 src/main/vcdiff.mjs）
  const { manifest: plan, pack, stats } = makeDirPatch(oldFiles, newFiles, { dropFile: isProtectedRel })
  if (!pack.length) {
    console.warn('[差量] 两版内容完全一致，补丁包为 0 字节 → 跳过')
    return
  }

  // 4. 值不值得：占比超阈值就别发（客户端也会自己再判一次，但发了就是白占 Release 空间）。
  //    ★ 清单 JSON 也算进"要下载的字节"——它内联在 update.json 里，一样要过用户的网。
  const planBytes = Buffer.byteLength(JSON.stringify(plan))
  const ratio = (pack.length + planBytes) / zipStat.size
  if (planBytes > 4 * 1024 * 1024) {
    console.warn(`[差量] 清单本体 ${mib(planBytes)} 太大（>4 MiB），会让 update.json 变得笨重 → 跳过`)
    return
  }
  if (ratio > 0.6) {
    console.warn(`[差量] 差量 ${mib(pack.length)}+清单 ${mib(planBytes)} 占全量 ${(ratio * 100).toFixed(0)}%（>60%）→ 不划算，跳过`)
    return
  }

  const asset = `QZRS-Scrcpy-Delta-${FROM}-to-${VERSION}.bin`
  fs.writeFileSync(path.join(OUT_DIR, asset), pack)
  manifest.patches = [
    {
      from: FROM,
      asset,
      size: pack.length,
      sha256: sha256hex(pack),
      ratio: Number(ratio.toFixed(3)),
      plan
    }
  ]

  console.log(`[差量] ${asset}  ${mib(pack.length)}（全量的 ${(ratio * 100).toFixed(1)}%）`)
  console.log(
    `       复用 ${mib(stats.copyBytes)} / 新增 ${mib(stats.dataBytes)} ｜ 改 ${plan.files.filter((f) => f.action === 'patch').length} 个 / 删 ${plan.removed.length} 个 ｜ 清单 ${mib(planBytes)}`
  )
  console.log(`       用时 ${((Date.now() - t0) / 1000).toFixed(1)} s`)
}

if (!OLD_ZIP || !FROM) {
  console.log('[差量] 没给 --old-zip/--from，只出全量清单')
} else if (!fs.existsSync(OLD_ZIP)) {
  console.warn(`[差量] 找不到上一版 zip: ${OLD_ZIP} → 本次不带差量包（客户端走全量）`)
} else if (FROM === VERSION) {
  console.warn(`[差量] 基准版本与当前版本相同（${VERSION}）→ 跳过`)
} else {
  try {
    buildPatch()
  } catch (e) {
    console.warn(`[差量] 生成失败，本次不带差量包（客户端走全量）：${e && e.message}`)
  }
}

const outJson = path.join(OUT_DIR, 'update.json')
fs.writeFileSync(outJson, JSON.stringify(manifest, null, 2) + '\n')

console.log(`[清单] ${outJson}`)
console.log(`       版本 ${VERSION} / 文件 ${files.length} 个 / 未压缩 ${mib(manifest.unpackedSize)}`)
console.log(`       全量 ${manifest.full.asset} ${mib(zipStat.size)} sha256=${zipSha.slice(0, 16)}…`)
if (manifest.patches) {
  for (const p of manifest.patches) console.log(`       差量 v${p.from} → v${VERSION}  ${p.asset} ${mib(p.size)}`)
}
