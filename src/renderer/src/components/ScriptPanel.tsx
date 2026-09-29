import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { ScriptInfo, ScriptRunEvent } from '@shared/types'
import { Drawer } from './Drawer'
import { IconPlus, IconScript, IconStop, IconTrash } from './icons'

interface Props {
  /** 当前活跃会话（投屏开着才有）；脚本通过它把指令发到设备 */
  sessionId: string | null
  sessionLabel: string | null
  /** 设备 serial（截取 waitImage 模板要截屏） */
  serial: string | null
  onClose: () => void
  onToast: (msg: string, type?: 'info' | 'error' | 'success') => void
  /** 开始录制：由 App 关闭本面板并进入录制模式 */
  onStartRecord: () => void
  /** 录制生成的代码（App 在停止录制后回传）；消费后调 onRecordedConsumed */
  recordedCode: string | null
  onRecordedConsumed: () => void
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
//   waitImage('模板名')              截屏找图，等到出现（先点「截取模板」）
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

export function ScriptPanel({ sessionId, sessionLabel, serial, onClose, onToast, onStartRecord, recordedCode, onRecordedConsumed }: Props): JSX.Element {
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

  // 录制生成的代码回填：追加到当前编辑器内容后
  useEffect(() => {
    if (!recordedCode) return
    setCode((prev) => (prev.trim() ? `${prev.trimEnd()}\n\n// —— 以下是录制的操作 ——\n${recordedCode}` : recordedCode))
    setDirty(true)
    onRecordedConsumed()
  }, [recordedCode, onRecordedConsumed])

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
        pushLine('err', e.line ? `✘ 第 ${e.line} 行：${e.message}` : `✘ ${e.message}`)
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

  // ---- waitImage 模板截取：截屏 → 拖框 → 裁剪保存 ----
  const [tplOpen, setTplOpen] = useState(false)
  const [tplShot, setTplShot] = useState<string | null>(null)
  const [tplName, setTplName] = useState('')
  const [tplRect, setTplRect] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const tplImgRef = useRef<HTMLImageElement | null>(null)
  const tplDragRef = useRef(false)

  const openTplCapture = async (): Promise<void> => {
    if (!serial) {
      onToast('请先连接设备再截取模板', 'error')
      return
    }
    const r = await window.api.screenshot(serial)
    if (!r.ok || !r.data) {
      onToast(r.message || '截屏失败', 'error')
      return
    }
    setTplShot(r.data)
    setTplRect(null)
    setTplName(`tpl_${Date.now().toString(36)}`)
    setTplOpen(true)
  }

  const tplPos = (e: ReactMouseEvent<HTMLDivElement>): { x: number; y: number } => {
    const rect = e.currentTarget.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(rect.width, e.clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, e.clientY - rect.top))
    }
  }

  const saveTpl = async (): Promise<void> => {
    const img = tplImgRef.current
    if (!img || !tplRect) {
      onToast('请先在截图上拖出一个框', 'error')
      return
    }
    const dispW = img.clientWidth
    const dispH = img.clientHeight
    const scale = img.naturalWidth / dispW
    const sx = Math.round(Math.min(tplRect.x0, tplRect.x1) * scale)
    const sy = Math.round(Math.min(tplRect.y0, tplRect.y1) * scale)
    const cw = Math.max(8, Math.round(Math.abs(tplRect.x1 - tplRect.x0) * scale))
    const ch = Math.max(8, Math.round(Math.abs(tplRect.y1 - tplRect.y0) * scale))
    if (sx + cw > img.naturalWidth || sy + ch > img.naturalHeight) {
      onToast('选区超出截图范围', 'error')
      return
    }
    const canvas = document.createElement('canvas')
    canvas.width = cw
    canvas.height = ch
    canvas.getContext('2d')!.drawImage(img, sx, sy, cw, ch, 0, 0, cw, ch)
    const base64 = canvas.toDataURL('image/png').split(',')[1] ?? ''
    const r = await window.api.saveTemplate(tplName.trim(), base64)
    if (r.ok) {
      onToast(`模板「${tplName.trim()}」已保存`, 'success')
      setTplOpen(false)
    } else {
      onToast(r.message || '保存失败', 'error')
    }
  }

  return (
    <>
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
            <button className="btn btn-ghost" onClick={onStartRecord} title="关闭面板后在投屏窗口里操作，操作会转成脚本代码">
              ● 录制
            </button>
            <button className="btn btn-ghost" onClick={() => void openTplCapture()} title="从当前屏幕截一块图作为 waitImage 模板">
              截取模板
            </button>
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

    {tplOpen && tplShot && (
      <div className="modal-backdrop" onClick={() => setTplOpen(false)}>
        <div className="modal" style={{ width: 'min(84vw, 680px)' }} onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h2>截取 waitImage 模板</h2>
            <button className="icon-btn" onClick={() => setTplOpen(false)} title="关闭">
              ✕
            </button>
          </div>
          <div className="modal-body">
            <div
              className="tpl-stage"
              onMouseDown={(e) => {
                const p = tplPos(e)
                tplDragRef.current = true
                setTplRect({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
              }}
              onMouseMove={(e) => {
                if (!tplDragRef.current) return
                const p = tplPos(e)
                setTplRect((r) => (r ? { ...r, x1: p.x, y1: p.y } : r))
              }}
              onMouseUp={() => (tplDragRef.current = false)}
              onMouseLeave={() => (tplDragRef.current = false)}
            >
              <img
                ref={tplImgRef}
                src={`data:image/png;base64,${tplShot}`}
                alt="设备截图"
                draggable={false}
              />
              {tplRect && (
                <div
                  className="tpl-rect"
                  style={{
                    left: Math.min(tplRect.x0, tplRect.x1),
                    top: Math.min(tplRect.y0, tplRect.y1),
                    width: Math.abs(tplRect.x1 - tplRect.x0),
                    height: Math.abs(tplRect.y1 - tplRect.y0)
                  }}
                />
              )}
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <input
                className="text-input"
                value={tplName}
                placeholder="模板名，如 start_btn"
                onChange={(e) => setTplName(e.target.value)}
              />
              <button className="btn btn-primary" onClick={() => void saveTpl()} disabled={!tplRect || Math.abs(tplRect.x1 - tplRect.x0) < 8 || Math.abs(tplRect.y1 - tplRect.y0) < 8}>
                保存模板
              </button>
              <button className="btn btn-ghost" onClick={() => setTplOpen(false)}>
                取消
              </button>
            </div>
            <div className="hint">在截图上拖一个框（框住要找的按钮/图标），保存后脚本里用 waitImage('模板名') 等它出现。名字会自动清理非法字符。</div>
          </div>
        </div>
      </div>
    )}
    </>
  )
}
