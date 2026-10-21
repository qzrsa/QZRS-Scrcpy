#!/usr/bin/env node
/**
 * 生成自更新清单 `update.json`。
 *
 *   node tools/make-update-manifest.mjs \
 *        --new ../release/QZRS-Scrcpy-Green-20261021001 \
 *        --zip ../release/QZRS-Scrcpy-Green-20261021001.zip \
 *        --out ../release
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
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

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

if (!NEW_DIR || !ZIP) {
  console.error('用法: node tools/make-update-manifest.mjs --new <绿色版目录> --zip <绿色版zip> [--out <输出目录>]')
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

fs.mkdirSync(OUT_DIR, { recursive: true })
const outJson = path.join(OUT_DIR, 'update.json')
fs.writeFileSync(outJson, JSON.stringify(manifest, null, 2) + '\n')

console.log(`[清单] ${outJson}`)
console.log(`       版本 ${VERSION} / 文件 ${files.length} 个 / 未压缩 ${mib(manifest.unpackedSize)}`)
console.log(`       全量 ${manifest.full.asset} ${mib(zipStat.size)} sha256=${zipSha.slice(0, 16)}…`)
