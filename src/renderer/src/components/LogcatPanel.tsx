import { useCallback, useEffect, useRef, useState } from 'react'
import { IconRefresh, IconScroll, IconStop } from './icons'

/** 日志级别过滤预设（tag:level 语法，空 = 全部） */
const PRESETS: Array<{ label: string; value: string }> = [
  { label: '全部', value: '' },
  { label: '错误', value: '*:E' },
  { label: '警告+', value: '*:W' },
  { label: '信息+', value: '*:I' },
  { label: '调试', value: '*:D' },
  { label: '详细', value: '*:V' }
]

const MAX_LINES = 5000

/**
 * 系统日志面板：logcat 流式逐行输出。
 *
 * 行由主进程 `device:logcat:start` 起子进程流式推送，经 onLogcatLine 转发到这里。
 * 关闭抽屉时卸载组件会顺带停掉该设备的 logcat 子进程（避免后台空转）。
 */
export function LogcatPanel({ serial }: { serial: string }): JSX.Element {
  const [running, setRunning] = useState(false)
  const [lines, setLines] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const [filterInput, setFilterInput] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // 订阅 logcat 行：只收本设备（logcat:line 是全局事件，多设备并发时按 serial 过滤）
  useEffect(() => {
    const off = window.api.onLogcatLine((e) => {
      if (e.serial !== serial) return
      setLines((prev) => {
        const next = prev.length >= MAX_LINES ? prev.slice(prev.length - MAX_LINES + 1) : prev
        return [...next, e.line]
      })
    })
    return off
  }, [serial])

  // 卸载时停掉该设备的 logcat（进程在主进程由 logcatProcs 管理）
  useEffect(() => {
    return () => {
      void window.api.stopLogcat(serial)
    }
  }, [serial])

  // 自动滚动到底
  useEffect(() => {
    if (!autoScroll || !listRef.current) return
    listRef.current.scrollTop = listRef.current.scrollHeight
  }, [lines, autoScroll])

  const start = useCallback(async (): Promise<void> => {
    setError(null)
    setLines([])
    const r = await window.api.startLogcat(serial, filter)
    if (!r.ok) {
      setError(r.message || '启动日志失败')
      setRunning(false)
      return
    }
    setRunning(true)
  }, [serial, filter])

  const stop = useCallback(async (): Promise<void> => {
    setRunning(false)
    await window.api.stopLogcat(serial)
  }, [serial])

  const clear = useCallback(async (): Promise<void> => {
    setLines([])
    await window.api.clearLogcat(serial)
  }, [serial])

  const applyFilter = (v: string): void => {
    setFilter(v)
    setFilterInput(v)
    if (running) {
      // 换过滤条件：停掉旧流，用新条件重启（后端 start 会先 kill 旧的）
      void (async () => {
        await window.api.stopLogcat(serial)
        setLines([])
        const r = await window.api.startLogcat(serial, v)
        if (!r.ok) setError(r.message || '切换过滤失败')
      })()
    }
  }

  return (
    <div className="logcat">
      <div className="logcat-toolbar">
        <input
          className="text-input logcat-filter"
          value={filterInput}
          placeholder='过滤条件，如 ActivityManager:V 或 *:E'
          onChange={(e) => setFilterInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') applyFilter(filterInput.trim())
          }}
        />
        <button className="btn btn-ghost btn-sm" onClick={() => applyFilter(filterInput.trim())}>
          应用
        </button>
        {!running ? (
          <button className="btn btn-primary btn-sm" onClick={() => void start()}>
            <IconScroll width={14} height={14} /> 开始
          </button>
        ) : (
          <button className="btn btn-danger btn-sm" onClick={() => void stop()}>
            <IconStop width={14} height={14} /> 停止
          </button>
        )}
        <button className="btn btn-ghost btn-sm" title="清空日志缓冲区（设备端 + 本地显示）" onClick={() => void clear()}>
          <IconRefresh width={14} height={14} /> 清空
        </button>
      </div>

      <div className="logcat-presets">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            className={`logcat-chip ${filter === p.value ? 'active' : ''}`}
            onClick={() => applyFilter(p.value)}
          >
            {p.label}
          </button>
        ))}
        <label className="logcat-autoscroll">
          <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
          自动滚动
        </label>
      </div>

      {error && <div className="infopanel-error">{error}</div>}

      <div className="logcat-view" ref={listRef}>
        {lines.length === 0 && (
          <span className="hint">{running ? '等待日志输出…' : '点击「开始」拉取系统日志'}</span>
        )}
        {lines.map((l, i) => (
          <div className="logcat-line" key={i}>
            {l}
          </div>
        ))}
      </div>

      <div className="fm-foot">
        <span className="hint">
          {lines.length} 行{running ? ' · 收集中' : ''}
          {lines.length >= MAX_LINES ? ` · 已达上限（保留最近 ${MAX_LINES} 行）` : ''}
        </span>
        {running && (
          <span className="fm-status">
            <span className="logcat-dot" /> 实时
          </span>
        )}
      </div>
    </div>
  )
}
