import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react'
import type { DeviceInfo, AppSettings, KeymapConfig, SessionOptions } from '@shared/types'

export interface SessionInfo {
  sessionId: string
  serial: string
  deviceName: string
  width: number
  height: number
  codec: string
  status: 'connecting' | 'streaming' | 'error'
  error?: string
}

interface Store {
  devices: DeviceInfo[]
  sessions: SessionInfo[]
  settings: AppSettings
  keymaps: KeymapConfig[]
  refreshDevices: () => void
  startSession: (serial: string, overrides?: Partial<SessionOptions>) => Promise<void>
  stopSession: (sessionId: string) => Promise<void>
  updateSettings: (s: AppSettings) => Promise<void>
  updateKeymaps: (k: KeymapConfig[]) => Promise<void>
}

const Ctx = createContext<Store | null>(null)

export function AppProvider({ children }: { children: ReactNode }): JSX.Element {
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [keymaps, setKeymaps] = useState<KeymapConfig[]>([])

  useEffect(() => {
    void window.api.getSettings().then(setSettings)
    void window.api.getKeymaps().then(setKeymaps)
    void window.api.listDevices().then(setDevices)

    const offDev = window.api.onDevicesChanged(setDevices)
    const offState = window.api.onSessionState((e) => {
      if (e.state === 'started') {
        setSessions((prev) => [
          // 按 serial 去重：替换掉 pending 占位会话（其 sessionId 是 pending-...，
          // 与真实 id 不同，必须按 serial 过滤，否则列表会残留占位导致 find 拿错）
          ...prev.filter((s) => s.serial !== e.serial),
          {
            sessionId: e.sessionId,
            serial: e.serial,
            deviceName: e.deviceName,
            width: e.width,
            height: e.height,
            codec: 'h264',
            status: 'streaming'
          }
        ])
      } else if (e.state === 'error') {
        // 主进程 sessionId(sXXXX) 与 pending 占位(pending-${serial}-...) 不一致，
        // 必须按 serial 清理，否则连接失败后僵尸占位永远卡在 connecting，
        // 卡片显示"运行中"却收不到帧（表现为"点了没反应"）。
        setSessions((prev) => prev.filter((s) => s.serial !== e.serial))
      } else if (e.state === 'stopped') {
        setSessions((prev) => prev.filter((s) => s.sessionId !== e.sessionId))
      }
    })
    const offMeta = window.api.onStreamMeta((m) => {
      setSessions((prev) =>
        prev.map((s) => (s.sessionId === m.sessionId ? { ...s, width: m.width, height: m.height, codec: m.codec } : s))
      )
    })
    return () => {
      offDev()
      offState()
      offMeta()
    }
  }, [])

  const refreshDevices = useCallback(() => {
    void window.api.refreshDevices().then(setDevices)
  }, [])

  const startSession = useCallback(async (serial: string, overrides?: Partial<SessionOptions>) => {
    const opts: SessionOptions = {
      ...defaultSession(),
      ...(settings?.session ?? {}),
      ...overrides
    }
    setSessions((prev) => [
      ...prev,
      {
        sessionId: `pending-${serial}-${Date.now()}`,
        serial,
        deviceName: serial,
        width: 0,
        height: 0,
        codec: opts.codec,
        status: 'connecting'
      }
    ])
    await window.api.startSession(serial, opts)
  }, [settings])

  const stopSession = useCallback(async (sessionId: string) => {
    await window.api.stopSession(sessionId)
    setSessions((prev) => prev.filter((s) => s.sessionId !== sessionId))
  }, [])

  const updateSettings = useCallback(async (s: AppSettings) => {
    setSettings(s)
    await window.api.setSettings(s)
  }, [])

  const updateKeymaps = useCallback(async (k: KeymapConfig[]) => {
    setKeymaps(k)
    await window.api.setKeymaps(k)
  }, [])

  if (!settings) return <></>

  return (
    <Ctx.Provider
      value={{
        devices,
        sessions,
        settings,
        keymaps,
        refreshDevices,
        startSession,
        stopSession,
        updateSettings,
        updateKeymaps
      }}
    >
      {children}
    </Ctx.Provider>
  )
}

function defaultSession(): SessionOptions {
  return {
    bitRate: 8000000,
    maxFps: 0,
    maxSize: 1920,
    codec: 'h264',
    control: true,
    stayAwake: true,
    showTouches: false,
    powerOffOnClose: false,
    clipboardAutosync: true,
    audio: false
  }
}

export function useApp(): Store {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useApp must be used within AppProvider')
  return ctx
}
