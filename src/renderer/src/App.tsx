import { useCallback, useEffect, useRef, useState } from 'react'
import type { ControlCommand, KeymapConfig, SessionStats, AppSettings, UpdateSnapshot } from '@shared/types'
import { useApp } from './store'
import { DeviceSidebar } from './components/DeviceSidebar'
import { MirrorView } from './components/MirrorView'
import { Toolbar } from './components/Toolbar'
import { SettingsPanel } from './components/SettingsPanel'
import { ConnectDialog } from './components/ConnectDialog'
import { KeymapPanel } from './components/KeymapPanel'
import { ToolsPanel } from './components/ToolsPanel'
import { ScriptPanel } from './components/ScriptPanel'
import { ClipboardDialog } from './components/ClipboardDialog'
import { StatsOverlay } from './components/StatsOverlay'
import { IconPhone, IconFullscreen } from './components/icons'
import { useStageFileDrop, DROP_TARGET } from './filedrop'

type Panel = 'settings' | 'keymap' | 'tools' | 'script'

interface Toast {
  msg: string
  type: 'info' | 'error' | 'success'
}

export default function App(): JSX.Element {
  const { devices, sessions, settings, activeKeymap, keymaps, startSession, stopSession, updateSettings, updateKeymaps, setActiveKeymapId } = useApp()
  const [activeSerial, setActiveSerial] = useState<string | null>(null)
  const [panel, setPanel] = useState<Panel | null>(null)
  const [keymapEditing, setKeymapEditing] = useState(false)
  const [connectOpen, setConnectOpen] = useState(false)
  const [clipboardOpen, setClipboardOpen] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [recording, setRecording] = useState(false)
  const [screenshot, setScreenshot] = useState<string | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  const [statsOpen, setStatsOpen] = useState(false)
  // 脚本录制：录制中把 MirrorView 的手势转成代码行累积，停止后回传 ScriptPanel
  const [scriptRecording, setScriptRecording] = useState(false)
  const [recordLines, setRecordLines] = useState<string[]>([])
  const [recordedCode, setRecordedCode] = useState<string | null>(null)
  const [netStats, setNetStats] = useState<SessionStats | null>(null)
  const [renderStats, setRenderStats] = useState<{ renderFps: number; hardware: boolean } | null>(null)
  // ---- 自更新：主进程推快照，渲染层只读（不自己拼状态）----
  const [updateSnap, setUpdateSnap] = useState<UpdateSnapshot | null>(null)

  useEffect(() => {
    void window.api.getUpdateState().then(setUpdateSnap).catch(() => undefined)
    return window.api.onUpdateState(setUpdateSnap)
  }, [])

  // 上次更新结果只报一次：主进程用 settings.lastUpdateNotice 去重，跨重启也不会重复弹
  const noticeKeyRef = useRef('')
  useEffect(() => {
    const n = updateSnap?.notice
    if (!n || noticeKeyRef.current === n.key) return
    noticeKeyRef.current = n.key
    setToast({ msg: `${n.title}：${n.text}`, type: n.kind === 'applied' ? 'success' : 'error' })
  }, [updateSnap])

  const activeSession = sessions.find((s) => s.serial === activeSerial) ?? null
  const activeTransport = devices.find((d) => d.serial === activeSession?.serial)?.transport ?? null

  // 侧栏更新提示：只在"有新版本" / "已下好待重启"时出现，其余状态不打扰
  const updateHint =
    updateSnap?.status === 'available'
      ? `发现新版本 v${updateSnap.latest}`
      : updateSnap?.status === 'staged'
        ? `v${updateSnap.latest} 已就绪，重启更新`
        : null

  const showToast = useCallback((msg: string, type: Toast['type'] = 'info') => setToast({ msg, type }), [])

  // 拖文件到投屏区 → adb push 到设备（官方 scrcpy 也是这个交互）
  const drop = useStageFileDrop({ serial: activeSession?.serial ?? null, onToast: showToast })

  // theme
  useEffect(() => {
    const apply = (t: 'dark' | 'light'): void => document.documentElement.setAttribute('data-theme', t)
    if (settings.theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: light)')
      const fn = (e: MediaQueryListEvent): void => apply(e.matches ? 'light' : 'dark')
      apply(mq.matches ? 'light' : 'dark')
      mq.addEventListener('change', fn)
      return () => mq.removeEventListener('change', fn)
    }
    apply(settings.theme)
  }, [settings.theme])

  // toast auto-dismiss
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 3200)
    return () => clearTimeout(t)
  }, [toast])

  // session event toasts (error / clipboard)
  useEffect(() => {
    const off = window.api.onSessionState((e) => {
      if (e.state === 'error') showToast(e.message, 'error')
      else if (e.state === 'clipboard') showToast('设备剪贴板已复制到本机', 'success')
    })
    return off
  }, [showToast])

  // realtime network stats from main process (bitrate / fps)
  useEffect(() => {
    const off = window.api.onSessionStats((e) => {
      if (e.sessionId === activeSession?.sessionId) setNetStats(e)
    })
    return off
  }, [activeSession?.sessionId])

  // F11 enters fullscreen; F12 exits fullscreen.
  // Uses system-level fullscreen when settings.fullscreenMode === 'window'.
  const settingsRef = useRef<AppSettings>(settings)
  settingsRef.current = settings

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // F11: enter fullscreen
      if (e.key === 'F11') {
        e.preventDefault()
        if (!fullscreen) {
          setFullscreen(true)
          if (settingsRef.current.fullscreenMode === 'window') {
            window.api.enterFullscreen().catch(() => { /* ignore */ })
          }
        }
        return
      }
      // F12: exit fullscreen
      if (e.key === 'F12') {
        e.preventDefault()
        if (fullscreen) {
          setFullscreen(false)
          if (settingsRef.current.fullscreenMode === 'window') {
            window.api.exitFullscreen().catch(() => { /* ignore */ })
          }
        }
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen])

  const handleRenderStats = useCallback((s: { renderFps: number; hardware: boolean }) => setRenderStats(s), [])
  const toggleInfo = useCallback(() => setStatsOpen((v) => !v), [])

  const handleStart = useCallback(
    (serial: string): void => {
      setActiveSerial(serial)
      void startSession(serial)
    },
    [startSession]
  )

  // 点击设备卡片：切换到该设备；若尚未连接则顺带建立连接。
  // connecting/streaming 都算"已有会话"（避免重复建立连接）；error 会被 store 按 serial 清掉，故不在此列。
  const handleSelect = useCallback(
    (serial: string): void => {
      setActiveSerial(serial)
      const exists = sessions.some(
        (s) => s.serial === serial && (s.status === 'streaming' || s.status === 'connecting')
      )
      if (!exists) void startSession(serial)
    },
    [sessions, startSession]
  )

  const handleStop = useCallback(async (): Promise<void> => {
    if (activeSession) {
      await stopSession(activeSession.sessionId)
      setActiveSerial(null)
      setRecording(false)
      setNetStats(null)
      setRenderStats(null)
    }
  }, [activeSession, stopSession])

  const send = useCallback(
    (cmd: ControlCommand): void => {
      const s = activeSession
      if (!s) return
      if (settings.groupControl) {
        const ids = sessions.filter((x) => x.status === 'streaming').map((x) => x.sessionId)
        if (ids.length > 1) {
          void window.api.broadcastControl(ids, cmd)
          return
        }
      }
      window.api.sendControl(s.sessionId, cmd)
    },
    [activeSession, sessions, settings.groupControl]
  )

  const handleScreenshot = async (): Promise<void> => {
    if (!activeSession) return
    const r = await window.api.screenshot(activeSession.serial)
    if (r.ok && r.data) setScreenshot(r.data)
    else showToast(r.message || '截图失败', 'error')
  }

  const saveScreenshot = async (): Promise<void> => {
    if (!screenshot) return
    const r = await window.api.saveFile(`screenshot_${Date.now()}.png`, screenshot)
    if (r.ok) showToast(`已保存：${r.path}`, 'success')
    else showToast(r.message || '保存失败', 'error')
  }

  const handleToggleRecord = async (): Promise<void> => {
    if (!activeSession) return
    if (recording) {
      const r = await window.api.stopRecord(activeSession.serial)
      setRecording(false)
      if (r.ok) showToast(`录屏已保存：${r.path || ''}`, 'success')
      else showToast(r.message || '停止录制失败', 'error')
    } else {
      const r = await window.api.startRecord(activeSession.serial, settings.session.bitRate)
      if (r.ok) {
        setRecording(true)
        showToast('开始录屏', 'success')
      } else showToast(r.message || '开始录制失败', 'error')
    }
  }

  const handleKeymapChange = useCallback(
    (k: KeymapConfig) => {
      const next = keymaps.map((c) => (c.id === k.id ? k : c))
      void updateKeymaps(next)
      // If no active keymap, auto-activate the edited one.
      if (!settings.activeKeymapId && k.bindings.length > 0) {
        void setActiveKeymapId(k.id)
      }
    },
    [keymaps, settings.activeKeymapId, updateKeymaps, setActiveKeymapId]
  )

  const handleToggleKeymapEdit = useCallback(() => {
    setKeymapEditing((v) => {
      if (v) return false
      // If no active keymap, auto create one so the visual editor has something to edit.
      if (!activeKeymap) {
        const newMap: KeymapConfig = { id: `km${Date.now().toString(36)}`, name: '默认方案', bindings: [], overlays: [] }
        void updateKeymaps([...keymaps, newMap])
        void setActiveKeymapId(newMap.id)
      }
      return true
    })
  }, [activeKeymap, keymaps, updateKeymaps, setActiveKeymapId])

  const toggleGroupControl = (): void => {
    const next = !settings.groupControl
    void updateSettings({ ...settings, groupControl: next })
    showToast(next ? '群控已开启（输入将广播到所有会话）' : '群控已关闭', 'success')
  }

  // ---- 脚本录制 ----
  const startScriptRecord = useCallback((): void => {
    setRecordLines([])
    setRecordedCode(null)
    setScriptRecording(true)
    setPanel(null) // 面板遮罩会挡投屏操作，录制时收起
    showToast('录制中：在投屏窗口里操作，点击/滑动会转成脚本', 'info')
  }, [showToast])

  const handleRecordGesture = useCallback((line: string): void => {
    setRecordLines((l) => [...l, line])
  }, [])

  const stopScriptRecord = useCallback((): void => {
    setScriptRecording(false)
    setRecordLines((lines) => {
      if (lines.length === 0) {
        showToast('没有录到任何操作', 'error')
        return lines
      }
      setRecordedCode(lines.join('\n'))
      setPanel('script')
      showToast(`已录制 ${lines.length} 个动作，回填到脚本编辑器`, 'success')
      return lines
    })
  }, [showToast])

  return (
    <div className={`app ${fullscreen ? 'fullscreen' : ''}`}>
      {/* Custom frameless title bar with macOS-style traffic lights */}
      <div className="window-titlebar">
        <div className="titlebar-drag-region" />
        <div className="titlebar-buttons">
          <button className="titlebar-btn minimize" title="最小化" onClick={() => void window.api.minimizeWindow()} />
          <button className="titlebar-btn maximize" title="最大化" onClick={() => void window.api.maximizeWindow()} />
          <button className="titlebar-btn close" title="关闭 (Alt+F4)" onClick={() => void window.api.closeWindow()} />
        </div>
      </div>
      <DeviceSidebar
        activeSessionSerial={activeSerial}
        onStart={handleStart}
        onSelect={handleSelect}
        onOpenConnect={() => setConnectOpen(true)}
        onOpenSettings={() => setPanel('settings')}
        updateHint={updateHint}
      />

      <main className="main">
        <Toolbar
          session={activeSession}
          groupControl={settings.groupControl}
          recording={recording}
          fullscreen={fullscreen}
          infoActive={statsOpen}
          keymapEditing={keymapEditing}
          send={send}
          onToggleGroupControl={toggleGroupControl}
          onToggleFullscreen={() => setFullscreen((f) => !f)}
          onToggleInfo={toggleInfo}
          onScreenshot={() => void handleScreenshot()}
          onToggleRecord={() => void handleToggleRecord()}
          onOpenClipboard={() => setClipboardOpen(true)}
          onOpenKeymap={() => setPanel('keymap')}
          onToggleKeymapEdit={handleToggleKeymapEdit}
          onOpenTools={() => setPanel('tools')}
          onOpenScript={() => setPanel('script')}
          onOpenSettings={() => setPanel('settings')}
          onStop={() => void handleStop()}
        />

        <div className={`stage ${drop.dragging ? 'drop-active' : ''}`} {...drop.handlers}>
          {activeSession ? (
          <MirrorView
            session={activeSession}
            send={send}
            onError={(m) => showToast(m, 'error')}
            decoderAcceleration={settings.decoderAcceleration}
            onStats={handleRenderStats}
            autoFit={settings.mirrorAutoFit !== false}
            keymap={activeKeymap}
            editing={keymapEditing}
            // 按键调试日志：设置项（原先工具栏的「D」按钮），保存后生效
            debug={settings.debugLog === true}
            fileLog={settings.debugLogToFile}
            recording={scriptRecording}
            onRecordGesture={handleRecordGesture}
            onEditClose={() => setKeymapEditing(false)}
            onKeymapChange={handleKeymapChange}
          />
          ) : (
            <div className="empty-state">
              <div className="big-phone">
                <IconPhone width={44} height={44} />
              </div>
              <h2>开始远程控制你的手机</h2>
              <p>在左侧选择一台已连接的设备并点击开始，即可投屏并实时操控；支持无线连接、群控、按键映射、录屏、文件传输。</p>
            </div>
          )}

          {activeSession && statsOpen && (
            <StatsOverlay session={activeSession} transport={activeTransport} net={netStats} render={renderStats} />
          )}

          {scriptRecording && (
            <div className="record-bar">
              <span className="record-dot" />
              <span>录制脚本中 · 已录 {recordLines.length} 个动作（键盘操作不录制）</span>
              <button className="btn btn-danger btn-sm" onClick={stopScriptRecord}>
                停止并生成
              </button>
            </div>
          )}

          {/* 拖文件进来的落点提示。pointer-events:none 让它不挡住真正的 drop 事件 */}
          {drop.dragging && (
            <div className="stage-drop">
              <div className="stage-drop-card">
                <div className="stage-drop-title">{activeSession ? '松手传到手机' : '当前没有连接的设备'}</div>
                <div className="stage-drop-sub">
                  {activeSession ? `文件会放进设备的 ${DROP_TARGET}` : '先开始投屏，再拖文件进来'}
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {fullscreen && (
        <button className="icon-btn float-exit" title="退出全屏 (F12)" onClick={() => setFullscreen(false)}>
          <IconFullscreen width={20} height={20} />
        </button>
      )}

      {panel === 'settings' && <SettingsPanel onClose={() => setPanel(null)} />}
      {panel === 'keymap' && (
        <KeymapPanel
          onClose={() => setPanel(null)}
          onOpenVisualEditor={handleToggleKeymapEdit}
          onToast={showToast}
        />
      )}
      {panel === 'tools' && <ToolsPanel serial={activeSession?.serial ?? null} onClose={() => setPanel(null)} />}
      {panel === 'script' && (
        <ScriptPanel
          sessionId={activeSession?.sessionId ?? null}
          sessionLabel={activeSession ? activeSession.deviceName || activeSession.serial : null}
          serial={activeSession?.serial ?? null}
          onClose={() => setPanel(null)}
          onToast={showToast}
          onStartRecord={startScriptRecord}
          recordedCode={recordedCode}
          onRecordedConsumed={() => setRecordedCode(null)}
        />
      )}
      {connectOpen && <ConnectDialog onClose={() => setConnectOpen(false)} />}
      {clipboardOpen && activeSession && <ClipboardDialog send={send} onClose={() => setClipboardOpen(false)} />}

      {screenshot && (
        <div className="modal-backdrop" onClick={() => setScreenshot(null)}>
          <div className="modal" style={{ width: 'min(70vw, 520px)' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>截屏预览</h2>
              <button className="icon-btn" onClick={() => setScreenshot(null)}>
                <IconPhone width={18} height={18} />
              </button>
            </div>
            <div className="modal-body">
              <img className="screenshot-preview" src={`data:image/png;base64,${screenshot}`} alt="截图" />
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setScreenshot(null)}>
                关闭
              </button>
              <button className="btn btn-primary" onClick={() => void saveScreenshot()}>
                保存图片
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className={`toast ${toast.type}`}>{toast.msg}</div>}
    </div>
  )
}
