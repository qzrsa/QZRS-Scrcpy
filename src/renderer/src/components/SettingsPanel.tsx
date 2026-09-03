import { useEffect, useState } from 'react'
import type { AppSettings, VideoCodec } from '@shared/types'
import { useApp } from '../store'
import { Drawer } from './Drawer'

export function SettingsPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const { settings, updateSettings } = useApp()
  const [draft, setDraft] = useState<AppSettings>(settings)
  const [resolved, setResolved] = useState<{ adbPath: string; serverPath: string; scrcpyPath: string } | null>(null)

  useEffect(() => {
    void window.api.resolvePaths().then(setResolved)
  }, [])

  const patch = (p: Partial<AppSettings>): void => setDraft((d) => ({ ...d, ...p }))
  const patchSession = (p: Partial<AppSettings['session']>): void =>
    setDraft((d) => ({ ...d, session: { ...d.session, ...p } }))

  const save = (): void => {
    void updateSettings(draft)
    onClose()
  }

  return (
    <Drawer title="设置" wide onClose={onClose}>
      <div className="field">
        <label>ADB 路径</label>
        <input
          className="text-input"
          value={draft.adbPath}
          placeholder="留空自动检测（Android SDK / platform-tools）"
          onChange={(e) => patch({ adbPath: e.target.value })}
        />
        <div className="hint">已检测：{resolved?.adbPath || '未找到'}</div>
      </div>

      <div className="field">
        <label>scrcpy-server 路径</label>
        <input
          className="text-input"
          value={draft.serverPath}
          placeholder="留空使用内置 resources/scrcpy-server"
          onChange={(e) => patch({ serverPath: e.target.value })}
        />
        <div className="hint">已检测：{resolved?.serverPath || '未找到'}</div>
      </div>

      <div className="field">
        <label>scrcpy.exe 路径（备用渲染）</label>
        <input
          className="text-input"
          value={draft.scrcpyPath}
          placeholder="留空自动在 PATH / Program Files / platform-tools 中查找"
          onChange={(e) => patch({ scrcpyPath: e.target.value })}
        />
        <div className="hint">已检测：{resolved?.scrcpyPath || '未找到'}（仅在 WebCodecs 渲染异常时使用）</div>
      </div>

      <div className="field">
        <label>主题</label>
        <select className="select" value={draft.theme} onChange={(e) => patch({ theme: e.target.value as AppSettings['theme'] })}>
          <option value="dark">深色</option>
          <option value="light">浅色</option>
          <option value="system">跟随系统</option>
        </select>
      </div>

      <div className="field">
        <label>视频编码</label>
        <select className="select" value={draft.session.codec} onChange={(e) => patchSession({ codec: e.target.value as VideoCodec })}>
          <option value="h264">H.264（兼容性最好）</option>
          <option value="h265">H.265 / HEVC</option>
          <option value="av1">AV1</option>
        </select>
      </div>

      <div className="field">
        <label>码率（Mbps）</label>
        <input
          className="text-input"
          type="number"
          min={0}
          step={1}
          value={Math.round(draft.session.bitRate / 1000000)}
          onChange={(e) => patchSession({ bitRate: Math.max(0, Number(e.target.value) || 0) * 1000000 })}
        />
        <div className="hint">0 表示使用默认（约 8 Mbps）</div>
      </div>

      <div className="field">
        <label>最大分辨率（长边）</label>
        <input
          className="text-input"
          type="number"
          min={0}
          step={1}
          value={draft.session.maxSize}
          onChange={(e) => patchSession({ maxSize: Math.max(0, Number(e.target.value) || 0) })}
        />
        <div className="hint">0 表示设备原生分辨率，如 1920 / 2560</div>
      </div>

      <div className="field">
        <label>最大帧率（FPS）</label>
        <input
          className="text-input"
          type="number"
          min={0}
          step={1}
          value={draft.session.maxFps}
          onChange={(e) => patchSession({ maxFps: Math.max(0, Number(e.target.value) || 0) })}
        />
        <div className="hint">0 表示不限制</div>
      </div>

      <div className="field row between">
        <label style={{ margin: 0 }}>保持设备屏幕常亮</label>
        <Toggle checked={draft.session.stayAwake} onChange={(v) => patchSession({ stayAwake: v })} />
      </div>

      <div className="field row between">
        <label style={{ margin: 0 }}>显示触摸点</label>
        <Toggle checked={draft.session.showTouches} onChange={(v) => patchSession({ showTouches: v })} />
      </div>

      <div className="field row between">
        <label style={{ margin: 0 }}>关闭时熄灭设备屏幕</label>
        <Toggle checked={draft.session.powerOffOnClose} onChange={(v) => patchSession({ powerOffOnClose: v })} />
      </div>

      <div className="field row between">
        <label style={{ margin: 0 }}>剪贴板自动同步</label>
        <Toggle checked={draft.session.clipboardAutosync} onChange={(v) => patchSession({ clipboardAutosync: v })} />
      </div>

      <div className="field row between">
        <label style={{ margin: 0 }}>允许控制（关闭为只读镜像）</label>
        <Toggle checked={draft.session.control} onChange={(v) => patchSession({ control: v })} />
      </div>

      <div className="row" style={{ marginTop: 20 }}>
        <button className="btn btn-primary btn-block" onClick={save}>
          保存设置
        </button>
      </div>
    </Drawer>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="slider" />
    </label>
  )
}
