import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { PyRunEvent, PyScriptFile, ScriptInfo, ScriptRunEvent } from '@shared/types'
import { Drawer } from './Drawer'
import { IconCamera, IconClose, IconFolder, IconPlay, IconPlus, IconRecord, IconRefresh, IconScript, IconStop, IconTrash } from './icons'

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
  ts: string
  /** 错误行携带：点击可跳到编辑器对应行 */
  line?: number
}

interface TplItem {
  name: string
  png: string
}

const TEMPLATE = `// 设备 API（坐标 = 视频像素坐标，与调试浮层一致）：
//   tap(x, y, duration=60)          点按；duration 大 = 长按
//   swipe(x1, y1, x2, y2, ms=300)   滑动
//   stick(xc, yc, xd, yd, ms)       推摇杆（DOWN 中心 → 推到方向 → 保持）
//   text('hello')                   输入文本（≤300 字节）
//   setClipboard('长文本', true)    写剪贴板 / 并粘贴（长文本用这个）
//   key('BACK') / key(4)            按键（BACK HOME ENTER VOLUME_UP ... 或数字 keycode）
//   wait(ms)                        等待
//   waitImage('模板名')              截屏找图，等到出现（先点「截取模板」）
//   getPixelColor(x, y)             读像素颜色 → { r, g, b, hex }
//   findColor('#ff0000', {tolerance, region})  找色 → { found, x, y }
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
/** 编辑器行高（px）——行号/滚动定位都按它算，CSS 里必须一致 */
const EDITOR_LINE_H = 19

// ---- 语法高亮（轻量 tokenizer：注释 / 字符串 / 关键字 / 数字 / API 名）----
const TOKEN_RE =
  /(\/\/[^\n]*)|(\/\*[\s\S]*?\*\/)|('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|\b(await|async|const|let|var|function|return|if|else|for|while|do|break|continue|new|true|false|null|undefined|try|catch|finally|throw|typeof|of|in|switch|case|default)\b|\b(\d+(?:\.\d+)?)\b|\b(tap|swipe|stick|text|setClipboard|key|wait|waitImage|getPixelColor|findColor|touchDown|touchMove|touchUp|log|console)\b/g

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function highlight(code: string): string {
  let out = ''
  let last = 0
  for (const m of code.matchAll(TOKEN_RE)) {
    const i = m.index ?? 0
    out += escapeHtml(code.slice(last, i))
    const cls = m[1] || m[2] ? 'tk-cmt' : m[3] ? 'tk-str' : m[4] ? 'tk-kw' : m[5] ? 'tk-num' : 'tk-api'
    out += `<span class="${cls}">${escapeHtml(m[0])}</span>`
    last = i + m[0].length
  }
  out += escapeHtml(code.slice(last))
  return out
}

const nowTs = (): string => {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 把录制出来的代码接到编辑器现有内容后面（编辑器本来就空时就不加分隔注释） */
function appendRecorded(base: string, rec: string): string {
  return base.trim() ? `${base.trimEnd()}\n\n// —— 以下是录制的操作 ——\n${rec}` : rec
}

export function ScriptPanel({ sessionId, sessionLabel, serial, onClose, onToast, onStartRecord, recordedCode, onRecordedConsumed }: Props): JSX.Element {
  const [scripts, setScripts] = useState<ScriptInfo[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [dirty, setDirty] = useState(false)
  const [lines, setLines] = useState<LogLine[]>([])
  const [templates, setTemplates] = useState<TplItem[]>([])
  // ---- 循环（录制宏）：整段跑完等 N 秒再从头跑，直到点「停止」----
  // 存 localStorage：同一台机器上"我习惯 30 秒一轮"这种偏好没必要进脚本本身。
  const [loopOn, setLoopOn] = useState<boolean>(() => {
    try {
      return localStorage.getItem('script-loop-on') === '1'
    } catch {
      return false
    }
  })
  const [loopSecText, setLoopSecText] = useState<string>(() => {
    try {
      return localStorage.getItem('script-loop-sec') || '30'
    } catch {
      return '30'
    }
  })
  /** 秒 → ms（1 秒 ~ 24 小时；空/非法回落到 30 秒） */
  const loopMs = loopOn
    ? Math.max(1, Math.min(86400, Math.round(Number(loopSecText) || 30))) * 1000
    : 0
  // ---- Python 脚本（scripts/python/*.py，独立进程运行）----
  const [pyScripts, setPyScripts] = useState<PyScriptFile[]>([])
  const [pyDir, setPyDir] = useState('')
  const [pythonPath, setPythonPath] = useState('')
  /** Python 运行状态：runId -> file */
  const pyRunsRef = useRef(new Map<string, string>())
  const [pyRunFiles, setPyRunFiles] = useState<Set<string>>(new Set())
  /** 本面板关心的运行状态：runId -> {scriptId, state} */
  const runsRef = useRef(new Map<string, { scriptId: string; state: string; startedAt: number }>())
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set())
  const logRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  /**
   * 录制结果是"边录边攒"的状态放在 App 里，停止录制才把整段代码传进来。
   * 但面板是那一刻才挂载的：listScripts() 是异步的，它回来之后会用
   * `setCode(脚本原文)` **把刚回填的录制内容整个覆盖掉**（探针实测过）。
   * 所以先把录制内容存进 ref，等脚本列表回来时再合并。
   */
  const pendingRecordRef = useRef<string | null>(null)
  const preRef = useRef<HTMLPreElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)

  const pushLine = useCallback((kind: LogLine['kind'], text: string, line?: number): void => {
    setLines((l) => {
      const next = [...l, { kind, text, ts: nowTs(), line }]
      return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next
    })
  }, [])

  useEffect(() => {
    void window.api.listScripts().then((list) => {
      setScripts(list)
      if (list.length > 0) {
        setSelectedId(list[0].id)
        setName(list[0].name)
        const rec = pendingRecordRef.current
        pendingRecordRef.current = null
        setCode(rec ? appendRecorded(list[0].code, rec) : list[0].code)
      }
    })
    void window.api.listTemplates().then(setTemplates)
    void refreshPyScripts()
    void window.api.getSettings().then((s) => setPythonPath(s.pythonPath || ''))
  }, [])

  // 录制生成的代码回填：追加到当前编辑器内容后
  useEffect(() => {
    if (!recordedCode) return
    pendingRecordRef.current = recordedCode
    setCode((prev) => appendRecorded(prev, recordedCode))
    setDirty(true)
    onRecordedConsumed()
  }, [recordedCode, onRecordedConsumed])

  // 面板可能在脚本运行时被关掉再打开：`started` 事件早就发过了，本地 runsRef 是空的
  // → 按钮会显示「运行」而不是「停止」，用户就没法停了。主进程才是运行状态的唯一真相，
  //   每次挂载都拉一次。（2026-10-27 用户报「运行后没法停止」就是这条）
  const syncRuns = useCallback(async (): Promise<void> => {
    try {
      const list = await window.api.runningScripts()
      const runs = runsRef.current
      for (const r of list) {
        if (!runs.has(r.runId)) runs.set(r.runId, { scriptId: r.scriptId, state: 'running', startedAt: Date.now() })
      }
      // 主进程说没在跑的一律清掉：面板关着的时候 stopped 事件也丢了
      const alive = new Set(list.map((r) => r.runId))
      for (const [id, r] of [...runs]) if (r.state === 'running' && !alive.has(id)) runs.delete(id)
      setRunningIds(new Set([...runs.values()].filter((r) => r.state === 'running').map((r) => r.scriptId)))
    } catch {
      /* 拉不到就维持现状，不影响运行/停止主流程 */
    }
  }, [])

  useEffect(() => {
    void syncRuns()
  }, [syncRuns])

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
        pushLine('err', `✘ ${e.message}`, e.line)
        runs.delete(e.runId)
      }
      setRunningIds(new Set([...runs.values()].filter((r) => r.state === 'running').map((r) => r.scriptId)))
    })
    return off
  }, [pushLine])

  // Python 脚本运行事件 → 同一日志区 + 运行状态
  useEffect(() => {
    const off = window.api.onPyScriptEvent((e: PyRunEvent) => {
      if (e.state === 'started') {
        pyRunsRef.current.set(e.runId, e.file)
        pushLine('sys', `▶ Python「${e.name}」已启动（独立进程）`)
      } else if (e.state === 'log') {
        pushLine(e.stream === 'err' ? 'err' : 'log', e.line)
      } else if (e.state === 'done') {
        const tail = e.code === 0 ? '正常' : `退出码 ${e.code ?? '?'}`
        pushLine(e.code === 0 ? 'sys' : 'err', `${e.code === 0 ? '✔' : '✘'} Python「${e.name}」已退出（${tail}，${e.elapsedMs}ms）`)
        pyRunsRef.current.delete(e.runId)
      } else if (e.state === 'stopped') {
        pushLine('sys', `■ Python「${e.name}」已停止`)
        pyRunsRef.current.delete(e.runId)
      } else if (e.state === 'error') {
        pushLine('err', `✘ Python「${e.name}」：${e.message}`)
        pyRunsRef.current.delete(e.runId)
      }
      setPyRunFiles(new Set(pyRunsRef.current.values()))
    })
    return off
  }, [pushLine])

  // 日志跟随滚动到底部
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  // ---- Python 脚本操作 ----
  function refreshPyScripts(): void {
    void window.api.listPyScripts().then((r) => {
      setPyDir(r.dir)
      setPyScripts(r.scripts)
    })
  }

  const runPy = async (file: string): Promise<void> => {
    const r = await window.api.runPyScript(file)
    if (!r.ok) onToast(r.message || '运行失败', 'error')
  }

  const stopPy = (file: string): void => {
    for (const [runId, f] of pyRunsRef.current) {
      if (f === file) void window.api.stopPyScript(runId)
    }
  }

  /** Python 解释器路径失焦时持久化（空串 = 用 PATH 里的 python） */
  const savePythonPath = (): void => {
    const v = pythonPath.trim()
    void window.api.getSettings().then((s) => window.api.setSettings({ ...s, pythonPath: v }))
  }

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
    // ⚠️ 不能直接读 selectedId：新建脚本时它是 null，保存后才拿到 id，
    // 而 setSelectedId 是异步的 —— 用旧值 run 会静默什么都不做。
    let target = selectedId
    if (dirty) {
      const r = await window.api.saveScript(selectedId ?? '', name, code)
      if (!r.ok) {
        onToast(r.message || '保存失败', 'error')
        return
      }
      setScripts(r.scripts ?? [])
      setSelectedId(r.id!)
      setDirty(false)
      target = r.id ?? target
    }
    if (!target) return
    const r = await window.api.runScript(target, sessionId, loopMs)
    if (!r.ok) onToast(r.message || '运行失败', 'error')
    else if (loopMs > 0) onToast(`开始循环：每 ${loopMs / 1000} 秒执行一遍，点停止结束`, 'info')
    void syncRuns()
  }

  const stop = async (): Promise<void> => {
    const hits = [...runsRef.current].filter(([, r]) => r.scriptId === selectedId && r.state === 'running')
    if (hits.length > 0) {
      for (const [runId] of hits) void window.api.stopScript(runId)
      return
    }
    // 本地没有记录（面板是运行中途才打开的）→ 直接问主进程要 runId
    try {
      const list = await window.api.runningScripts()
      for (const r of list) if (r.scriptId === selectedId) void window.api.stopScript(r.runId)
    } catch {
      /* 拉不到就算了，至少不会把面板卡住 */
    }
  }

  const runningThis = selectedId !== null && runningIds.has(selectedId)

  // ---- 编辑器：滚动同步 + 行号 + 快捷键 ----
  const syncScroll = (): void => {
    const ta = taRef.current
    if (!ta) return
    if (preRef.current) {
      preRef.current.scrollTop = ta.scrollTop
      preRef.current.scrollLeft = ta.scrollLeft
    }
    if (gutterRef.current) gutterRef.current.scrollTop = ta.scrollTop
  }

  /** 跳到指定行并选中该行（点错误日志用） */
  const jumpToLine = (line: number): void => {
    const ta = taRef.current
    if (!ta) return
    const ls = code.split('\n')
    const target = Math.max(1, Math.min(ls.length, line))
    const start = ls.slice(0, target - 1).reduce((acc, l) => acc + l.length + 1, 0)
    ta.focus()
    ta.selectionStart = start
    ta.selectionEnd = start + (ls[target - 1]?.length ?? 0)
    ta.scrollTop = Math.max(0, (target - 1) * EDITOR_LINE_H - ta.clientHeight / 2)
    syncScroll()
  }

  // ---- 模板管理器：插入 waitImage 调用 / 删除模板 ----
  const insertWaitImage = (tplName: string): void => {
    const snip = `await waitImage('${tplName}')`
    const ta = taRef.current
    const at = ta ? ta.selectionStart : code.length
    const end = ta ? ta.selectionEnd : at
    setCode(code.slice(0, at) + snip + code.slice(end))
    setDirty(true)
    requestAnimationFrame(() => {
      if (!ta) return
      ta.focus()
      ta.selectionStart = ta.selectionEnd = at + snip.length
    })
  }

  const removeTemplate = async (tplName: string): Promise<void> => {
    if (!window.confirm(`删除模板「${tplName}」？正在使用它的脚本会报「模板不存在」。`)) return
    const r = await window.api.deleteTemplate(tplName)
    if (r.templates) setTemplates(r.templates)
    onToast(`模板「${tplName}」已删除`, 'success')
  }

  // ---- 日志区高度拖拽 ----
  const [logH, setLogH] = useState(160)
  const logDragRef = useRef<{ y: number; h: number } | null>(null)
  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      const d = logDragRef.current
      if (!d) return
      setLogH(Math.max(80, Math.min(420, d.h + (d.y - e.clientY))))
    }
    const onUp = (): void => {
      logDragRef.current = null
      document.body.classList.remove('drawer-resizing')
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

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
      if (r.templates) setTemplates(r.templates)
      onToast(`模板「${tplName.trim()}」已保存`, 'success')
      setTplOpen(false)
    } else {
      onToast(r.message || '保存失败', 'error')
    }
  }

  const lineCount = code.split('\n').length

  return (
    <>
    <Drawer title="脚本自动化" wide resizableKey="script" onClose={onClose}>
      {!sessionId ? (
        <div className="hint">请先连接一台设备（投屏开启）再运行脚本。脚本编辑不受影响。</div>
      ) : null}

      <div className="script-layout">
        {/* 左：脚本列表 + 模板 */}
        <div className="script-list">
          <div className="script-list-head">
            <span>脚本（{scripts.length}）</span>
            <button className="icon-btn" title="新建脚本" onClick={newScript}>
              <IconPlus width={15} height={15} />
            </button>
          </div>
          {scripts.length === 0 && <div className="hint">还没有脚本，点 + 新建</div>}
          <div className="script-list-scroll">
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
          </div>
          <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => void window.api.openScriptsDir()}>
            打开脚本目录
          </button>

          <div className="script-list-head" style={{ marginTop: 10 }}>
            <span>模板（{templates.length}）</span>
            <button className="icon-btn" title="截取一块屏幕区域作为新模板" onClick={() => void openTplCapture()}>
              <IconCamera width={15} height={15} />
            </button>
          </div>
          <div className="script-list-scroll tpl-list">
            {templates.length === 0 && <div className="hint">还没有模板。点相机图标截取，或在脚本里用 waitImage 前先截一块</div>}
            {templates.map((t) => (
              <div key={t.name} className="tpl-item" onClick={() => insertWaitImage(t.name)} title={`点击插入 waitImage('${t.name}')`}>
                {t.png ? <img className="tpl-thumb" src={`data:image/png;base64,${t.png}`} alt={t.name} draggable={false} /> : <span className="tpl-thumb tpl-thumb-empty" />}
                <span className="script-item-name">{t.name}</span>
                <button
                  className="icon-btn tpl-del"
                  title="删除模板"
                  onClick={(e) => {
                    e.stopPropagation()
                    void removeTemplate(t.name)
                  }}
                >
                  <IconTrash width={13} height={13} />
                </button>
              </div>
            ))}
          </div>

          <div className="script-list-head" style={{ marginTop: 10 }}>
            <span>Python 脚本（{pyScripts.length}）</span>
            <span style={{ display: 'flex', gap: 2 }}>
              <button className="icon-btn" title="重新扫描目录" onClick={refreshPyScripts}>
                <IconRefresh width={14} height={14} />
              </button>
              <button className="icon-btn" title={`打开目录${pyDir ? `：${pyDir}` : ''}`} onClick={() => void window.api.openPyScriptsDir()}>
                <IconFolder width={15} height={15} />
              </button>
            </span>
          </div>
          <div className="script-list-scroll tpl-list">
            {pyScripts.length === 0 && <div className="hint">把 .py 放进 scripts\python 目录后点刷新即自动列出；脚本通过 Python 桥（qzrs.py）控制设备，日志走下方同一块运行日志</div>}
            {pyScripts.map((p) => (
              <div key={p.file} className="script-item" title={`${p.file}（${(p.sizeBytes / 1024).toFixed(0)} KB）`}>
                <IconScript width={14} height={14} />
                <span className="script-item-name">{p.name}</span>
                {pyRunFiles.has(p.file) && <span className="script-run-dot" title="运行中" />}
                {pyRunFiles.has(p.file) ? (
                  <button className="icon-btn tpl-del" title="停止（结束进程树）" onClick={() => stopPy(p.file)}>
                    <IconStop width={13} height={13} />
                  </button>
                ) : (
                  <button className="icon-btn tpl-del" title="运行（独立 Python 进程）" onClick={() => void runPy(p.file)}>
                    <IconPlay width={13} height={13} />
                  </button>
                )}
              </div>
            ))}
          </div>
          <input
            className="text-input"
            style={{ marginTop: 8, fontSize: 12 }}
            value={pythonPath}
            placeholder="Python 解释器（空 = PATH 里的 python）"
            title="如 C:\\Python313\\python.exe 或某个 venv 的 python.exe；失焦自动保存"
            onChange={(e) => setPythonPath(e.target.value)}
            onBlur={savePythonPath}
          />
        </div>

        {/* 右：编辑器 + 日志（编辑器吃满剩余高度，日志高度可拖） */}
        <div className="script-main">
          <div className="script-toolbar">
            <div className="script-name-wrap">
              <input
                className="text-input"
                value={name}
                placeholder="脚本名称"
                onChange={(e) => {
                  setName(e.target.value)
                  setDirty(true)
                }}
              />
              {dirty && <span className="dirty-dot" title="有未保存的修改" />}
            </div>
            <button className="btn btn-ghost" onClick={() => void save()} disabled={!dirty && !!selectedId} title="保存（Ctrl+S）">
              保存
            </button>
            {runningThis ? (
              <button className="btn btn-danger" onClick={() => void stop()}>
                <IconStop width={15} height={15} /> 停止
              </button>
            ) : (
              <button
                className="btn btn-primary"
                onClick={() => void run()}
                disabled={!code.trim() || !sessionId}
                title={loopMs > 0 ? `运行（循环：每 ${loopMs / 1000} 秒一遍）Ctrl+Enter` : '运行（Ctrl+Enter）'}
              >
                运行
              </button>
            )}
            {/* 循环：录制完直接勾上就能"每隔 N 秒重播"，不用写 while/await */}
            <label
              className={`loop-box ${loopOn ? 'on' : ''}`}
              title="整段脚本跑完后等 N 秒，再从头跑一遍；点「停止」结束（录制宏用）"
            >
              <input
                type="checkbox"
                checked={loopOn}
                onChange={(e) => {
                  const v = e.target.checked
                  setLoopOn(v)
                  try {
                    localStorage.setItem('script-loop-on', v ? '1' : '0')
                  } catch {
                    /* ignore */
                  }
                }}
              />
              循环
              <input
                className="loop-sec"
                type="number"
                min={1}
                max={86400}
                value={loopSecText}
                disabled={!loopOn}
                aria-label="循环间隔（秒）"
                onChange={(e) => {
                  setLoopSecText(e.target.value)
                  try {
                    localStorage.setItem('script-loop-sec', e.target.value)
                  } catch {
                    /* ignore */
                  }
                }}
              />
              秒
            </label>
            <span className="toolbar-sep" />
            <button className="icon-btn" onClick={onStartRecord} title="录制：在投屏窗口里操作，自动转成脚本代码">
              <IconRecord width={16} height={16} />
            </button>
            <button className="icon-btn" onClick={() => void openTplCapture()} title="截取模板：从当前屏幕框一块图，给 waitImage 用">
              <IconCamera width={16} height={16} />
            </button>
            <button className="icon-btn" onClick={() => void remove()} disabled={!selectedId} title="删除脚本">
              <IconTrash width={16} height={16} />
            </button>
          </div>

          <div className="editor-wrap">
            <div className="editor-gutter" ref={gutterRef} aria-hidden>
              {Array.from({ length: lineCount }, (_, i) => (
                <div key={i} className="editor-ln">
                  {i + 1}
                </div>
              ))}
            </div>
            <div className="editor-body">
              <pre className="editor-highlight" ref={preRef} aria-hidden>
                <code dangerouslySetInnerHTML={{ __html: highlight(code) + '\n' }} />
              </pre>
              <textarea
                ref={taRef}
                className="editor-input"
                spellCheck={false}
                wrap="off"
                value={code}
                placeholder={'// 在这里写脚本，顶层可直接 await\nawait tap(540, 1200)'}
                onChange={(e) => {
                  setCode(e.target.value)
                  setDirty(true)
                }}
                onScroll={syncScroll}
                onKeyDown={(e) => {
                  if (e.key === 'Tab') {
                    // Tab 插入两个空格而不是跳出焦点
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
                  } else if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                    e.preventDefault()
                    void save()
                  } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault()
                    void run()
                  }
                }}
              />
            </div>
          </div>

          <div
            className="log-resize"
            title="拖拽调整日志高度"
            onMouseDown={(e) => {
              e.preventDefault()
              logDragRef.current = { y: e.clientY, h: logH }
              document.body.classList.add('drawer-resizing')
            }}
          />

          <div className="script-log" style={{ height: logH }}>
            <div className="script-log-head">
              <span>运行日志{sessionLabel ? ` · ${sessionLabel}` : ''}</span>
              {lines.length > 0 && (
                <button className="icon-btn" title="清空日志" onClick={() => setLines([])}>
                  <IconClose width={13} height={13} />
                </button>
              )}
            </div>
            <div className="script-log-body" ref={logRef}>
              {lines.length === 0 && <span className="out">运行日志会显示在这里…（错误日志可点击跳到对应行）</span>}
              {lines.map((l, i) => (
                <div
                  key={i}
                  className={`${l.kind} ${l.kind === 'err' && l.line ? 'jump' : ''}`}
                  onClick={l.kind === 'err' && l.line ? () => jumpToLine(l.line!) : undefined}
                  title={l.kind === 'err' && l.line ? `点击跳到第 ${l.line} 行` : undefined}
                >
                  <span className="lts">{l.ts}</span>
                  {l.text}
                </div>
              ))}
            </div>
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
            <div className="hint">在截图上拖一个框（框住要找的按钮/图标），保存后点左侧模板项即可插入 waitImage 调用。名字会自动清理非法字符。</div>
          </div>
        </div>
      </div>
    )}
    </>
  )
}
