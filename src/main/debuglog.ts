import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 本地日期 YYYY-MM-DD（日志文件名，跨天自动切新文件） */
function localDate(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 本地时间 HH:MM:SS.mmm（行前缀，方便对时间线） */
function localTime(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

/**
 * 调试日志落盘器。
 *
 * - 目录按候选顺序在首次写入时确定：第一个能成功 mkdir 的目录胜出
 *   （安装目录/logs → userData/logs 兜底）；此后固定使用该目录。
 * - 文件名 = 本地日期（如 2026-09-29.log），跨天自动切新文件。
 * - 写入串行化：queue + flushing 标志，避免 appendFile 乱序。
 * - 目录未启用（setDir 未调用 / 传 null）时写入直接丢弃，零开销。
 * - 写盘失败静默放弃（日志是辅助功能，不能反过来影响投屏主流程）。
 */
export class DebugFileLogger {
  private queue: string[] = []
  private flushing = false
  private activeDir: string | null = null
  private candidates: string[]
  private failed = false

  constructor(candidates: string[]) {
    this.candidates = candidates
  }

  /** 当前实际使用的日志目录；尚未写过任何日志时返回 null */
  get dir(): string | null {
    return this.activeDir
  }

  /** 追加一行正文（不含时间戳，落盘时统一加 [HH:MM:SS.mmm] 前缀） */
  write(line: string): void {
    if (this.failed) return
    this.queue.push(line)
    if (!this.flushing) void this.flush()
  }

  private async flush(): Promise<void> {
    this.flushing = true
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0)
        const dir = this.resolveDir()
        if (!dir) return
        const file = join(dir, `${localDate(new Date())}.log`)
        const body = batch.map((l) => `[${localTime(new Date())}] ${l}`).join('\n') + '\n'
        await appendFile(file, body, 'utf8')
      }
    } catch {
      // 写不进去（磁盘满/权限等）就永久放弃，别让日志拖垮主流程
      this.failed = true
    } finally {
      this.flushing = false
    }
  }

  /** 退出前把队列里剩余的行同步写完（尽力而为） */
  flushSync(): void {
    if (this.failed || this.queue.length === 0) return
    try {
      const batch = this.queue.splice(0)
      const dir = this.resolveDir()
      if (!dir) return
      const file = join(dir, `${localDate(new Date())}.log`)
      const body = batch.map((l) => `[${localTime(new Date())}] ${l}`).join('\n') + '\n'
      writeFileSync(file, body, { encoding: 'utf8', flag: 'a' })
    } catch {
      /* ignore */
    }
  }

  /** 首次调用时按候选顺序选定目录并 mkdir；成功后缓存 */
  private resolveDir(): string | null {
    if (this.activeDir) return this.activeDir
    for (const dir of this.candidates) {
      try {
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        this.activeDir = dir
        return dir
      } catch {
        /* 尝试下一个候选 */
      }
    }
    this.failed = true
    return null
  }
}
