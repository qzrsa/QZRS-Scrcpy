import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react'
import type { DeviceInfo, AppSettings, KeymapConfig, SessionOptions } from '@shared/types'
import { playerFor, disposePlayer, disposeAllPlayers } from './audio/player'

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
  /** the keymap referenced by settings.activeKeymapId, or null if none */
  activeKeymap: KeymapConfig | null
  refreshDevices: () => void
  startSession: (serial: string, overrides?: Partial<SessionOptions>) => Promise<void>
  stopSession: (sessionId: string) => Promise<void>
  updateSettings: (s: AppSettings) => Promise<void>
  updateKeymaps: (k: KeymapConfig[]) => Promise<void>
  setActiveKeymapId: (id: string | null) => Promise<void>
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
          // 按 serial 去重并置为 streaming：连接中占位无论 id 是否已换成真实 id，都统一按 serial 替换
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
        // 主进程 sessionId(sXXXX) 与占位 id 不同，按 serial 清理（连接失败时避免僵尸占位卡 connecting）。
        setSessions((prev) => prev.filter((s) => s.serial !== e.serial))
        disposePlayer(e.sessionId)
      } else if (e.state === 'stopped') {
        // 与 started/error 保持一致，按 serial 清理：连接中服务器断开时，占位 id 可能与真实 id 不同，
        // 若仍按 sessionId 过滤会漏掉占位，导致卡片永久显示"运行中"却收不到帧。
        setSessions((prev) => prev.filter((s) => s.serial !== e.serial))
        disposePlayer(e.sessionId)
      }
    })
    const offMeta = window.api.onStreamMeta((m) => {
      setSessions((prev) =>
        prev.map((s) => (s.sessionId === m.sessionId ? { ...s, width: m.width, height: m.height, codec: m.codec } : s))
      )
    })
    // ---- 音频 ----
    // 播放器按会话独立：群控时多台设备各自出声，互不干扰。
    const offAudioMeta = window.api.onAudioMeta((m) => {
      playerFor(m.sessionId).configure(m.codec, m.sampleRate, m.channels)
    })
    const offAudioFrame = window.api.onAudioFrame((e) => {
      playerFor(e.sessionId).feed(e.data, e.isConfig, e.pts)
    })
    // 主进程已判定音频不可用（Android < 11 / 采集被占用 / 解析错），只关声音不动视频。
    const offAudioOff = window.api.onAudioDisabled((e) => {
      disposePlayer(e.sessionId)
    })
    return () => {
      offDev()
      offState()
      offMeta()
      offAudioMeta()
      offAudioFrame()
      offAudioOff()
      disposeAllPlayers()
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
    // 先用临时 id 占位（立即给用户"连接中"反馈），拿到主进程返回的真实 sessionId 后再替换。
    // 这样后续 started/error/stopped、stopSession、sendControl 都使用同一套真实 id，避免双 id 错配。
    const tempId = `pending-${serial}-${Date.now()}`
    setSessions((prev) => [
      // 按 serial 去重，防止同一设备残留旧占位导致重复建连
      ...prev.filter((s) => s.serial !== serial),
      {
        sessionId: tempId,
        serial,
        deviceName: serial,
        width: 0,
        height: 0,
        codec: opts.codec,
        status: 'connecting'
      }
    ])
    const { sessionId } = await window.api.startSession(serial, opts)
    // 主进程同步失败时返回空 id（此时已通过 error 事件按 serial 清掉占位），无需替换
    if (sessionId) {
      setSessions((prev) => prev.map((s) => (s.sessionId === tempId ? { ...s, sessionId } : s)))
    }
  }, [settings])

  const stopSession = useCallback(async (sessionId: string) => {
    await window.api.stopSession(sessionId)
    disposePlayer(sessionId)
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

  const setActiveKeymapId = useCallback(
    async (id: string | null) => {
      if (!settings) return
      const next = { ...settings, activeKeymapId: id }
      setSettings(next)
      await window.api.setSettings(next)
    },
    [settings]
  )

  if (!settings) return <></>

  const activeKeymap = settings.activeKeymapId ? keymaps.find((k) => k.id === settings.activeKeymapId) ?? null : null

  return (
    <Ctx.Provider
      value={{
        devices,
        sessions,
        settings,
        keymaps,
        activeKeymap,
        refreshDevices,
        startSession,
        stopSession,
        updateSettings,
        updateKeymaps,
        setActiveKeymapId
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
    videoEncoder: '',
    control: true,
    stayAwake: true,
    showTouches: false,
    powerOffOnClose: false,
    clipboardAutosync: true,
    audio: false,
    audioSource: 'output',
    audioCodec: 'opus',
    audioBitRate: 0
  }
}

export function useApp(): Store {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useApp must be used within AppProvider')
  return ctx
}
