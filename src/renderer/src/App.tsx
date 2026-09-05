import { useCallback, useEffect, useState } from 'react'
import type { ControlCommand, KeymapConfig, SessionStats } from '@shared/types'
import { useApp } from './store'
import { DeviceSidebar } from './components/DeviceSidebar'
import { MirrorView } from './components/MirrorView'
import { EmbeddedScrcpy } from './components/EmbeddedScrcpy'
import { Toolbar } from './components/Toolbar'
import { SettingsPanel } from './components/SettingsPanel'
import { ConnectDialog } from './components/ConnectDialog'
import { KeymapPanel } from './components/KeymapPanel'
import { ToolsPanel } from './components/ToolsPanel'
import { ClipboardDialog } from './components/ClipboardDialog'
import { StatsOverlay } from './components/StatsOverlay'
import { IconPhone, IconFullscreen } from './components/icons'

type Panel = 'settings' | 'keymap' | 'tools'

interface Toast {
  msg: string
  type: 'info' | 'error' | 'success'
}

export default function App(): JSX.Element {
  const { devices, sessions, settings, activeKeymap, keymaps, startSession, stopSession, updateSettings, updateKeymaps, setActiveKeymapId } = useApp()
  const [activeSerial, setActiveSerial] = useState<string | null>(null)
  const [embedSerial, setEmbedSerial] = useState<string | null>(null)
  const [panel, setPanel] = useState<Panel | null>(null)
  const [keymapEditing, setKeymapEditing] = useState(false)
  const [debugOverlay, setDebugOverlay] = useState(false)
  const [connectOpen, setConnectOpen] = useState(false)
  const [clipboardOpen, setClipboardOpen] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [recording, setRecording] = useState(false)
  const [screenshot, setScreenshot] = useState<string | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  const [statsOpen, setStatsOpen] = useState(false)
  const [netStats, setNetStats] = useState<SessionStats | null>(null)
  const [renderStats, setRenderStats] = useState<{ renderFps: number; hardware: boolean } | null>(null)

  const activeSession = sessions.find((s) => s.serial === activeSerial) ?? null
  const activeTransport = devices.find((d) => d.serial === activeSession?.serial)?.transport ?? null

  const showToast = useCallback((msg: string, type: Toast['type'] = 'info') => setToast({ msg, type }), [])

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

  // ESC exits fullscreen; F12 toggles fullscreen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setFullscreen(false)
      else if (e.key === 'F12') { e.preventDefault(); setFullscreen((f) => !f) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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
      setEmbedSerial(null)
      setRecording(false)
      setNetStats(null)
      setRenderStats(null)
    }
  }, [activeSession, stopSession])

  // 切换"嵌入 scrcpy"回退模式：内置 WebCodecs 渲染异常（绿屏/竖屏裁切）时，
  // 用官方 scrcpy.exe 的 SDL 窗口嵌入到 MirrorView 区域看画面。
  const toggleEmbed = useCallback((): void => {
    if (!activeSession) return
    setEmbedSerial((prev) => (prev === activeSession.serial ? null : activeSession.serial))
  }, [activeSession])

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

  return (
    <div className={`app ${fullscreen ? 'fullscreen' : ''}`}>
      <DeviceSidebar
        activeSessionSerial={activeSerial}
        onStart={handleStart}
        onSelect={handleSelect}
        onOpenConnect={() => setConnectOpen(true)}
        onOpenSettings={() => setPanel('settings')}
      />

      <main className="main">
        <Toolbar
          session={activeSession}
          groupControl={settings.groupControl}
          recording={recording}
          fullscreen={fullscreen}
          embedActive={embedSerial === activeSession?.serial}
          infoActive={statsOpen}
          keymapEditing={keymapEditing}
          debugActive={debugOverlay}
          send={send}
          onToggleGroupControl={toggleGroupControl}
          onToggleFullscreen={() => setFullscreen((f) => !f)}
          onToggleEmbed={toggleEmbed}
          onToggleInfo={toggleInfo}
          onScreenshot={() => void handleScreenshot()}
          onToggleRecord={() => void handleToggleRecord()}
          onOpenClipboard={() => setClipboardOpen(true)}
          onOpenKeymap={() => setPanel('keymap')}
          onToggleKeymapEdit={handleToggleKeymapEdit}
          onOpenTools={() => setPanel('tools')}
          onOpenSettings={() => setPanel('settings')}
          onToggleDebug={() => setDebugOverlay((v) => !v)}
          onStop={() => void handleStop()}
        />

        <div className="stage">
          {activeSession ? (
            embedSerial === activeSession.serial ? (
              <EmbeddedScrcpy serial={activeSession.serial} onError={(m) => showToast(m, 'error')} />
            ) : (
              <MirrorView
              session={activeSession}
              send={send}
              onError={(m) => showToast(m, 'error')}
              onFullscreen={() => setFullscreen((f) => !f)}
              decoderAcceleration={settings.decoderAcceleration}
              onStats={handleRenderStats}
              keymap={activeKeymap}
              editing={keymapEditing}
              debug={debugOverlay}
              onEditClose={() => setKeymapEditing(false)}
              onKeymapChange={handleKeymapChange}
            />
            )
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
        </div>
      </main>

      {fullscreen && (
        <button className="icon-btn float-exit" title="退出全屏 (Esc)" onClick={() => setFullscreen(false)}>
          <IconFullscreen width={20} height={20} />
        </button>
      )}

      {panel === 'settings' && <SettingsPanel onClose={() => setPanel(null)} />}
      {panel === 'keymap' && <KeymapPanel onClose={() => setPanel(null)} onOpenVisualEditor={handleToggleKeymapEdit} />}
      {panel === 'tools' && <ToolsPanel serial={activeSession?.serial ?? null} onClose={() => setPanel(null)} />}
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
