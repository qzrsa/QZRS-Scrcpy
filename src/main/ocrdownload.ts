import { createWriteStream, existsSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { net } from 'electron'
import { OCR_GITHUB_URL_TEMPLATE, OCR_MODELS, resolveOcrModelDir, verifyModelFile, type OcrModelEntry } from './ocrmodels'

/**
 * OCR 模型下载器：从 GitHub Release（默认源）拉模型到本地模型目录。
 *
 * 关键选型：
 * - **electron.net 而非 node:https**：走 Chromium 网络栈，自动继承系统代理
 *   （"代理环境"不需要我们写任何代码），重定向（GitHub → objects.githubusercontent.com）
 *   也默认跟随。
 * - **散文件逐个下**：每个模型单独校验、单独重试，10.9MB 的 rec 失败不用重拉 4.7MB 的 det。
 * - **.part 临时文件**：下完校验通过才 rename 成正式名，半截文件永远不会被误判为已就绪。
 * - **SHA256 兜底**：大小对上了但内容坏（代理注入页面等）也会在校验环节拦下重下。
 *
 * 进度事件 phase: downloading → verifying → done | error。
 */

export type OcrProgressPhase = 'downloading' | 'verifying' | 'done' | 'error'

export interface OcrProgress {
  phase: OcrProgressPhase
  /** 0..100，总体进度（按字节加权） */
  percent: number
  /** 当前文件名 */
  file?: string
  /** 本文件的 0..100 */
  filePercent?: number
  message?: string
}

const RETRIES_PER_FILE = 3
const RETRY_BASE_MS = 1500
const DOWNLOAD_TIMEOUT_MS = 120_000

export class OcrModelDownloader {
  private busy = false
  private progressCb: ((p: OcrProgress) => void) | null = null

  /** 注册进度回调（渲染层 'ocr:progress' 通道） */
  onProgress(cb: (p: OcrProgress) => void): void {
    this.progressCb = cb
  }

  get running(): boolean {
    return this.busy
  }

  private emit(p: OcrProgress): void {
    try {
      this.progressCb?.(p)
    } catch {
      /* 进度回调不能拖垮下载 */
    }
  }

  /** 下载全部缺失/损坏的模型；全部就绪返回 true */
  async downloadAll(): Promise<boolean> {
    if (this.busy) {
      this.emit({ phase: 'error', percent: 0, message: '已有下载在进行中' })
      return false
    }
    this.busy = true
    try {
      const dir = resolveOcrModelDir()
      const todo: OcrModelEntry[] = []
      for (const m of OCR_MODELS) {
        if (!(await verifyModelFile(dir, m))) todo.push(m)
      }
      if (todo.length === 0) {
        this.emit({ phase: 'done', percent: 100, message: '模型已就绪' })
        return true
      }
      const totalBytes = todo.reduce((s, m) => s + m.size, 0)
      let doneBytes = 0
      for (let i = 0; i < todo.length; i++) {
        const m = todo[i]
        this.emit({ phase: 'downloading', percent: (doneBytes / totalBytes) * 100, file: m.file, filePercent: 0 })
        await this.downloadOne(dir, m, (filePercent) => {
          this.emit({
            phase: 'downloading',
            percent: ((doneBytes + (filePercent / 100) * m.size) / totalBytes) * 100,
            file: m.file,
            filePercent
          })
        })
        doneBytes += m.size
      }
      this.emit({ phase: 'verifying', percent: (doneBytes / totalBytes) * 100 })
      // 终检：全部文件哈希过关才算 done
      for (const m of OCR_MODELS) {
        if (!(await verifyModelFile(dir, m))) {
          throw new Error(`校验失败：${m.file}（下载源内容与清单不符，请稍后重试或用手动下载）`)
        }
      }
      this.emit({ phase: 'done', percent: 100, message: 'OCR 模型已就绪' })
      return true
    } catch (err) {
      this.emit({ phase: 'error', percent: 0, message: err instanceof Error ? err.message : String(err) })
      return false
    } finally {
      this.busy = false
    }
  }

  /** 单文件下载：3 次指数退避；每次先下 .part 再校验，通过后 rename */
  private async downloadOne(dir: string, m: OcrModelEntry, onFilePercent: (p: number) => void): Promise<void> {
    const url = OCR_GITHUB_URL_TEMPLATE.replace('{file}', m.file)
    const finalPath = join(dir, m.file)
    const partPath = finalPath + '.part'
    let lastErr = ''
    for (let attempt = 1; attempt <= RETRIES_PER_FILE; attempt++) {
      try {
        await this.fetchToFile(url, partPath, m.size, onFilePercent)
        if (statSync(partPath).size !== m.size) {
          throw new Error(`大小不符：收到 ${statSync(partPath).size}，期望 ${m.size}`)
        }
        if (!(await verifyModelFile(dir, { ...m, file: `${m.file}.part` }))) {
          throw new Error('SHA256 校验失败（下载内容与清单不符）')
        }
        try {
          unlinkSync(finalPath)
        } catch {
          /* 原本就不存在 */
        }
        renameSync(partPath, finalPath)
        return
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err)
        try {
          unlinkSync(partPath)
        } catch {
          /* ignore */
        }
        if (attempt < RETRIES_PER_FILE) {
          this.emit({ phase: 'downloading', percent: 0, file: m.file, message: `${lastErr}，${Math.round(RETRY_BASE_MS * attempt) / 1000}s 后重试（${attempt}/${RETRIES_PER_FILE - 1}）` })
          await new Promise((r) => setTimeout(r, RETRY_BASE_MS * attempt))
        }
      }
    }
    throw new Error(`${m.file} 下载失败（重试 ${RETRIES_PER_FILE} 次）：${lastErr}`)
  }

  /** electron.net 单文件下载（跟随重定向、自动系统代理、120s 超时） */
  private fetchToFile(url: string, dest: string, expectedSize: number, onPercent: (p: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = net.request({ method: 'GET', url, redirect: 'follow' })
      let settled = false
      const fail = (msg: string): void => {
        if (settled) return
        settled = true
        try {
          request.abort()
        } catch {
          /* ignore */
        }
        reject(new Error(msg))
      }
      const timer = setTimeout(() => fail(`下载超时（>${DOWNLOAD_TIMEOUT_MS / 1000}s）`), DOWNLOAD_TIMEOUT_MS)
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }

      request.on('response', (response) => {
        if (response.statusCode !== 200) {
          fail(`HTTP ${response.statusCode}（${url}）`)
          return
        }
        const total = Number(response.headers['content-length'] ?? 0) || expectedSize
        let received = 0
        const out = createWriteStream(dest)
        response.on('data', (chunk: Uint8Array) => {
          received += chunk.length
          out.write(Buffer.from(chunk))
          if (total > 0) onPercent(Math.min(100, (received / total) * 100))
        })
        response.on('end', () => {
          out.end(() => {
            if (received === 0) fail('服务器返回空内容')
            else finish()
          })
        })
        response.on('error', (e) => fail(`下载流中断: ${e.message}`))
      })
      request.on('error', (e) => fail(`网络错误: ${e.message}`))
      request.end()
    })
  }
}
