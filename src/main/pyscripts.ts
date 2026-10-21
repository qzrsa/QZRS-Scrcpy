import { spawn, type ChildProcess } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { delimiter } from 'node:path'
import type { PyScriptFile, PyRunEvent } from '@shared/types'

/**
 * Python 脚本管理器：扫描 scripts/python/*.py 列表 + 独立进程运行/停止。
 *
 * 与 JS 脚本引擎（node:vm 沙箱）不同，Python 脚本是**完全独立的进程**：
 * app 只负责 spawn / kill / 转发 stdout/stderr 日志，脚本自己通过 Python 桥
 * （qzrs.py → 127.0.0.1 HTTP）控制投屏会话。好处：
 *   - 重依赖（numpy/rapidocr/opencv）不进 app 进程，崩溃互不影响；
 *   - 7×24 挂机脚本与 app 生命周期解耦；
 *   - 沙箱/打包环境对 vm 沙箱的限制不再适用于 Python 生态。
 *
 * 环境注入（spawn 时）：
 *   - QZRS_TOKEN：当前桥 Token（未开桥则不注入），脚本可 `os.environ['QZRS_TOKEN']` 直取；
 *   - PYTHONPATH：前置桥客户端目录（qzrs.py 所在），脚本无需复制 qzrs.py 即可 import。
 *
 * 进程退出（含被杀）后统一调 hooks.releasePointers()：脚本可能死在
 * touch_down 之后没来得及 touch_up，桥上会留下悬挂的虚拟手指。
 */

export interface PyScriptManagerHooks {
  onEvent(evt: PyRunEvent): void
  /** 进程退出后释放桥上可能仍按住的手指（防虚拟手指悬挂） */
  releasePointers(): void
}

export interface PyRunHandle {
  runId: string
  file: string
  name: string
}

interface PyRunInternal extends PyRunHandle {
  child: ChildProcess
  startedAt: number
  /** 用户主动停止过（exit 事件据此区分 stopped / done） */
  stopping: boolean
}

/** 单行日志上限（超长截断，防止一行 base64 之类刷爆渲染层） */
const MAX_LINE_LENGTH = 2000

export class PyScriptManager {
  private runs = new Map<string, PyRunInternal>()

  constructor(private readonly hooks: PyScriptManagerHooks) {}

  /** 扫描目录下的 .py（一层，不递归）；目录不存在/不可读返回空数组 */
  list(dir: string): PyScriptFile[] {
    try {
      return readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith('.py'))
        .map((f) => {
          const st = statSync(join(dir, f))
          return {
            file: f,
            name: f.replace(/\.py$/i, ''),
            sizeBytes: st.size,
            updatedAt: st.mtimeMs
          }
        })
        .sort((a, b) => b.updatedAt - a.updatedAt)
    } catch {
      return []
    }
  }

  running(): PyRunHandle[] {
    return [...this.runs.values()].map(({ runId, file, name }) => ({ runId, file, name }))
  }

  /** 指定脚本（按文件名）是否正在运行 */
  isRunning(file: string): boolean {
    const f = basename(String(file))
    return [...this.runs.values()].some((r) => r.file === f)
  }

  /**
   * 运行一个 .py（file 传文件名，仅允许 dir 下直接命中的文件，防目录穿越）。
   * pythonPath 为空串/undefined 时用 PATH 里的 `python`。
   * extraPythonPath 会前置到子进程 PYTHONPATH（桥客户端 qzrs.py 所在目录）。
   */
  run(
    dir: string,
    file: string,
    pythonPath: string,
    extraPythonPath?: string,
    env?: Record<string, string>
  ): { ok: boolean; runId?: string; message?: string } {
    const name = basename(String(file ?? ''))
    if (!name.toLowerCase().endsWith('.py')) {
      return { ok: false, message: '只能运行 .py 文件' }
    }
    const abs = join(dir, name)
    try {
      statSync(abs)
    } catch {
      return { ok: false, message: `脚本不存在：${name}` }
    }
    if (this.isRunning(name)) {
      return { ok: false, message: `「${name}」已在运行` }
    }
    const py = String(pythonPath ?? '').trim() || 'python'
    const displayName = name.replace(/\.py$/i, '')

    let child: ChildProcess
    try {
      const pythonPathEnv = [extraPythonPath, process.env.PYTHONPATH].filter(Boolean).join(delimiter)
      child = spawn(py, [abs], {
        cwd: dir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...(pythonPathEnv ? { PYTHONPATH: pythonPathEnv } : {}),
          ...(env ?? {})
        }
      })
    } catch (err) {
      return { ok: false, message: `启动 Python 失败：${err instanceof Error ? err.message : String(err)}` }
    }

    const runId = randomUUID()
    const rec: PyRunInternal = { runId, file: name, name: displayName, child, startedAt: Date.now(), stopping: false }
    this.runs.set(runId, rec)
    this.hooks.onEvent({ runId, file: name, name: displayName, state: 'started' })

    const pump = (stream: 'out' | 'err'): ((chunk: Buffer | string) => void) => {
      let buf = ''
      return (chunk: Buffer | string): void => {
        buf += chunk.toString('utf8')
        let idx = buf.indexOf('\n')
        while (idx >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, '')
          buf = buf.slice(idx + 1)
          if (line) {
            this.hooks.onEvent({
              runId,
              file: name,
              name: displayName,
              state: 'log',
              line: line.slice(0, MAX_LINE_LENGTH),
              stream
            })
          }
          idx = buf.indexOf('\n')
        }
        // 半行留在 buf 里等下一段拼完整行
      }
    }
    child.stdout?.on('data', pump('out'))
    child.stderr?.on('data', pump('err'))

    // spawn 失败（典型：ENOENT，python 不在 PATH）→ error 事件，进程从未起来
    child.on('error', (err) => {
      if (!this.runs.has(runId)) return
      this.hooks.onEvent({
        runId,
        file: name,
        name: displayName,
        state: 'error',
        message: `启动 Python 失败（${err.message}）；检查「Python 解释器」路径设置`
      })
      this.finish(runId)
    })

    child.on('exit', (code, signal) => {
      if (!this.runs.has(runId)) return
      const stopped = rec.stopping || signal === 'SIGTERM' || signal === 'SIGKILL'
      if (stopped) {
        this.hooks.onEvent({ runId, file: name, name: displayName, state: 'stopped' })
      } else {
        this.hooks.onEvent({
          runId,
          file: name,
          name: displayName,
          state: 'done',
          code: code ?? null,
          elapsedMs: Date.now() - rec.startedAt
        })
      }
      this.finish(runId)
    })

    return { ok: true, runId }
  }

  /** 停止一个运行；Windows 用 taskkill /T 连子进程一起杀（python 可能拉起 adb 子进程） */
  stop(runId: string): boolean {
    const rec = this.runs.get(String(runId ?? ''))
    if (!rec) return false
    if (rec.child.pid && rec.child.exitCode === null) {
      rec.stopping = true
      if (process.platform === 'win32') {
        // kill() 只杀本体，杀不掉 python 的子进程树
        try {
          spawn('taskkill', ['/pid', String(rec.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        } catch {
          rec.child.kill()
        }
      } else {
        rec.child.kill('SIGTERM')
      }
    }
    return true
  }

  stopAll(): void {
    for (const r of [...this.runs.values()]) this.stop(r.runId)
  }

  /** 收尾：从运行表移除 + 释放桥上悬挂的手指（幂等） */
  private finish(runId: string): void {
    if (!this.runs.delete(runId)) return
    this.hooks.releasePointers()
  }
}
