import { useEffect, useState } from 'react'
import type { AppSettings, VideoCodec, DecoderAcceleration } from '@shared/types'
import { useApp } from '../store'
import { Drawer } from './Drawer'

export function SettingsPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const { settings, updateSettings } = useApp()
  const [draft, setDraft] = useState<AppSettings>(settings)
  const [resolved, setResolved] = useState<{ adbPath: string; serverPath: string; scrcpyPath: string } | null>(null)
  const [hevc, setHevc] = useState<'checking' | 'yes' | 'no'>('checking')

  useEffect(() => {
    void window.api.resolvePaths().then(setResolved)
  }, [])

  // 检测内核是否支持 HEVC(H.265) 硬解（依赖主进程开启的 PlatformHEVCDecoderSupport）。
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const r = await VideoDecoder.isConfigSupported({
          codec: 'hvc1.1.6.L120.B0',
          codedWidth: 1920,
          codedHeight: 1080,
          hardwareAcceleration: 'prefer-hardware'
        })
        if (alive) setHevc(r.supported ? 'yes' : 'no')
      } catch {
        if (alive) setHevc('no')
      }
    })()
    return () => {
      alive = false
    }
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
          <option value="h264">H.264（内置渲染，推荐）</option>
          <option value="h265">H.265 / HEVC（需官方 scrcpy 窗口）</option>
          <option value="av1">AV1（暂不支持）</option>
        </select>
        <div className="hint">
          {draft.session.codec === 'h264'
            ? '内置 WebCodecs 渲染仅支持 H.264'
            : '内置渲染不支持该编码（Electron 内核无 HEVC 解码器）。请改用设备卡片的 ⚙️ 独立窗口，或工具栏「嵌入 Scrcpy」'}
        </div>
        <div className="hint" style={{ fontWeight: 600 }}>
          HEVC 硬解内核检测：{' '}
          <span style={{ color: hevc === 'yes' ? '#2ecc71' : hevc === 'no' ? '#e74c3c' : 'inherit' }}>
            {hevc === 'checking' ? '检测中…' : hevc === 'yes' ? '✅ 支持（内核已启用）' : '❌ 不支持（驱动/硬件受限）'}
          </span>
        </div>
      </div>

      <div className="field">
        <label>编码器名称（可选）</label>
        <input
          className="text-input"
          value={draft.session.videoEncoder}
          placeholder="留空自动选择（如 c2.android.avc.encoder）"
          onChange={(e) => patchSession({ videoEncoder: e.target.value })}
        />
        <div className="hint">指定设备端 MediaCodec 编码器，留空由 scrcpy 自动选择。常用：c2.android.avc.encoder（软件）、c2.qti.avc.encoder（高通硬编）</div>
      </div>

      <div className="field">
        <label>解码器（硬件加速）</label>
        <select
          className="select"
          value={draft.decoderAcceleration}
          onChange={(e) => patch({ decoderAcceleration: e.target.value as DecoderAcceleration })}
        >
          <option value="auto">自动（推荐）</option>
          <option value="hardware">优先硬件</option>
          <option value="software">强制软件（绿屏时选这个）</option>
        </select>
        <div className="hint">PC 端解码策略。遇到绿屏/花屏（AMD 等驱动不稳）时选"强制软件"</div>
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

      <div className="field">
        <label>全屏模式</label>
        <select
          className="select"
          value={draft.fullscreenMode}
          onChange={(e) => patch({ fullscreenMode: e.target.value as AppSettings['fullscreenMode'] })}
        >
          <option value="overlay">覆盖层（仅隐藏侧边栏和工具栏）</option>
          <option value="window">系统级全屏（F12 进入独占全屏）</option>
        </select>
        <div className="hint">覆盖层：适合投屏小窗；系统级全屏：按 F12 让窗口独占整个显示器（含任务栏消失）</div>
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
