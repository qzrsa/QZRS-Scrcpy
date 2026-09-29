import { useCallback, useEffect, useRef, useState } from 'react'
import type { ScriptInfo, ScriptRunEvent } from '@shared/types'
import { Drawer } from './Drawer'
import { IconPlus, IconScript, IconStop, IconTrash } from './icons'

interface Props {
  /** 当前活跃会话（投屏开着才有）；脚本通过它把指令发到设备 */
  sessionId: string | null
  sessionLabel: string | null
  onClose: () => void
  onToast: (msg: string, type?: 'info' | 'error' | 'success') => void
}

interface LogLine {
  kind: 'sys' | 'log' | 'err'
  text: string
}

const TEMPLATE = `// 设备 API（坐标 = 视频像素坐标，与调试浮层一致）：
//   tap(x, y, duration=60)          点按；duration 大 = 长按
//   swipe(x1, y1, x2, y2, ms=300)   滑动
//   text('hello')                   输入文本（支持中文）
//   key('BACK') / key(4)            按键（BACK HOME ENTER VOLUME_UP ... 或数字 keycode）
//   wait(ms)                        等待
//   log('...') / console.log('...') 输出日志
// 顶层可直接 await，例：

log('开始执行')
await tap(540, 1200)
await wait(500)
await swipe(540, 1500, 540, 800, 300)
await key('BACK')
log('完成')
`

const MAX_LOG_LINES = 500

export function ScriptPanel({ sessionId, sessionLabel, onClose, onToast }: Props): JSX.Element {
  const [scripts, setScripts] = useState<ScriptInfo[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [dirty, setDirty] = useState(false)
  const [lines, setLines] = useState<LogLine[]>([])
  /** 本面板关心的运行状态：runId -> {scriptId, state} */
  const runsRef = useRef(new Map<string, { scriptId: string; state: string; startedAt: number }>())
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set())
  const logRef = useRef<HTMLDivElement>(null)

  const pushLine = useCallback((kind: LogLine['kind'], text: string): void => {
    setLines((l) => {
      const next = [...l, { kind, text }]
      return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next
    })
  }, [])

  useEffect(() => {
    void window.api.listScripts().then((list) => {
      setScripts(list)
      if (list.length > 0) {
        setSelectedId(list[0].id)
        setName(list[0].name)
        setCode(list[0].code)
      }
    })
  }, [])

  // 脚本运行事件 → 日志区 + 运行状态
  useEffect(() => {
    const off = window.api.onScriptEvent((e: ScriptRunEvent) => {
      const runs = runsRef.current
      if (e.state === 'started') {
        runs.set(e.runId, { scriptId: e.scriptId, state: 'running', startedAt: Date.now() })
        pushLine('sys', `▶ 开始运行「${e.name}」`)
      } else if (e.state === 'log') {
        pushLine('log', e.line)
      } else if (e.state === 'done') {
        pushLine('sys', `✔ 运行完成（${e.elapsedMs}ms）`)
        runs.delete(e.runId)
      } else if (e.state === 'stopped') {
        pushLine('sys', '■ 已停止')
        runs.delete(e.runId)
      } else if (e.state === 'error') {
        pushLine('err', `✘ ${e.message}`)
        runs.delete(e.runId)
      }
      setRunningIds(new Set([...runs.values()].filter((r) => r.state === 'running').map((r) => r.scriptId)))
    })
    return off
  }, [pushLine])

  // 日志跟随滚动到底部
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  const select = (s: ScriptInfo): void => {
    if (dirty && !window.confirm('当前脚本有未保存的修改，切换将丢失，确定？')) return
    setSelectedId(s.id)
    setName(s.name)
    setCode(s.code)
    setDirty(false)
  }

  const newScript = (): void => {
    if (dirty && !window.confirm('当前脚本有未保存的修改，新建将丢失，确定？')) return
    setSelectedId(null)
    setName('新脚本')
    setCode(TEMPLATE)
    setDirty(true)
  }

  const save = async (): Promise<void> => {
    const r = await window.api.saveScript(selectedId ?? '', name, code)
    if (!r.ok) {
      onToast(r.message || '保存失败', 'error')
      return
    }
    setScripts(r.scripts ?? [])
    setSelectedId(r.id!)
    setDirty(false)
    onToast('脚本已保存', 'success')
  }

  const remove = async (): Promise<void> => {
    if (!selectedId) return
    if (!window.confirm(`删除脚本「${name}」？`)) return
    const r = await window.api.deleteScript(selectedId)
    if (r.ok) {
      const next = r.scripts ?? []
      setScripts(next)
      setSelectedId(next.length > 0 ? next[0].id : null)
      setName(next.length > 0 ? next[0].name : '')
      setCode(next.length > 0 ? next[0].code : '')
      setDirty(false)
      onToast('已删除', 'success')
    } else {
      onToast(r.message || '删除失败', 'error')
    }
  }

  const run = async (): Promise<void> => {
    if (!sessionId) return
    if (dirty) {
      const r = await window.api.saveScript(selectedId ?? '', name, code)
      if (!r.ok) {
        onToast(r.message || '保存失败', 'error')
        return
      }
      setScripts(r.scripts ?? [])
      setSelectedId(r.id!)
      setDirty(false)
    }
    const target = selectedId
    if (!target) return
    const r = await window.api.runScript(target, sessionId)
    if (!r.ok) onToast(r.message || '运行失败', 'error')
  }

  const stop = (): void => {
    for (const [runId, r] of runsRef.current) {
      if (r.scriptId === selectedId && r.state === 'running') void window.api.stopScript(runId)
    }
  }

  const runningThis = selectedId !== null && runningIds.has(selectedId)

  return (
    <Drawer title="脚本自动化" wide onClose={onClose}>
      {!sessionId ? (
        <div className="hint">请先连接一台设备（投屏开启）再运行脚本。脚本编辑不受影响。</div>
      ) : null}

      <div className="script-layout">
        {/* 左：脚本列表 */}
        <div className="script-list">
          <div className="script-list-head">
            <span>脚本（{scripts.length}）</span>
            <button className="icon-btn" title="新建脚本" onClick={newScript}>
              <IconPlus width={15} height={15} />
            </button>
          </div>
          {scripts.length === 0 && <div className="hint">还没有脚本，点 + 新建</div>}
          {scripts.map((s) => (
            <div
              key={s.id}
              className={`script-item ${s.id === selectedId ? 'active' : ''}`}
              onClick={() => select(s)}
            >
              <IconScript width={14} height={14} />
              <span className="script-item-name">{s.name}</span>
              {runningIds.has(s.id) && <span className="script-run-dot" title="运行中" />}
            </div>
          ))}
          <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => void window.api.openScriptsDir()}>
            打开脚本目录
          </button>
        </div>

        {/* 右：编辑器 + 日志 */}
        <div className="script-main">
          <div className="row">
            <input
              className="text-input"
              value={name}
              placeholder="脚本名称"
              onChange={(e) => {
                setName(e.target.value)
                setDirty(true)
              }}
            />
            <button className="btn btn-ghost" onClick={() => void save()} disabled={!dirty && !!selectedId}>
              保存
            </button>
            {runningThis ? (
              <button className="btn btn-danger" onClick={stop}>
                <IconStop width={15} height={15} /> 停止
              </button>
            ) : (
              <button className="btn btn-primary" onClick={() => void run()} disabled={!code.trim()}>
                运行
              </button>
            )}
            <button className="btn btn-ghost" onClick={() => void remove()} disabled={!selectedId} title="删除脚本">
              <IconTrash width={15} height={15} />
            </button>
          </div>

          <textarea
            className="script-editor"
            spellCheck={false}
            value={code}
            placeholder={'// 在这里写脚本，顶层可直接 await\nawait tap(540, 1200)'}
            onChange={(e) => {
              setCode(e.target.value)
              setDirty(true)
            }}
            onKeyDown={(e) => {
              // Tab 键插入两个空格而不是跳出焦点
              if (e.key === 'Tab') {
                e.preventDefault()
                const el = e.currentTarget
                const start = el.selectionStart
                const end = el.selectionEnd
                const next = code.slice(0, start) + '  ' + code.slice(end)
                setCode(next)
                setDirty(true)
                requestAnimationFrame(() => {
                  el.selectionStart = el.selectionEnd = start + 2
                })
              }
            }}
          />

          {sessionLabel && <div className="hint">目标设备：{sessionLabel}</div>}

          <div className="script-log" ref={logRef}>
            {lines.length === 0 && <span className="out">运行日志会显示在这里…</span>}
            {lines.map((l, i) => (
              <div key={i} className={l.kind}>
                {l.text}
              </div>
            ))}
          </div>
        </div>
      </div>
    </Drawer>
  )
}
