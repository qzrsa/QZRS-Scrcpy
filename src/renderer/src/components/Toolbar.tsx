import type { ControlCommand } from '@shared/types'
import type { SessionInfo } from '../store'
import {
  IconHome,
  IconBack,
  IconRecent,
  IconPower,
  IconVolume,
  IconRotate,
  IconFullscreen,
  IconCamera,
  IconRecord,
  IconStop,
  IconClipboard,
  IconKeyboard,
  IconTerminal,
  IconSettings,
  IconLayers,
  IconInfo
} from './icons'
import { KEYCODE } from '../keycodes'

interface Props {
  session: SessionInfo | null
  groupControl: boolean
  recording: boolean
  fullscreen: boolean
  infoActive: boolean
  keymapEditing: boolean
  debugActive: boolean
  send: (cmd: ControlCommand) => void
  onToggleGroupControl: () => void
  onToggleFullscreen: () => void
  onToggleInfo: () => void
  onScreenshot: () => void
  onToggleRecord: () => void
  onOpenClipboard: () => void
  onOpenKeymap: () => void
  onToggleKeymapEdit: () => void
  onOpenTools: () => void
  onOpenSettings: () => void
  onToggleDebug: () => void
  onStop: () => void
}

export function Toolbar(p: Props): JSX.Element {
  const key = (code: number, meta = 0): (() => void) => (): void => {
    p.send({ type: 'keycode', action: 0, keycode: code, repeat: 0, metastate: meta })
    p.send({ type: 'keycode', action: 1, keycode: code, repeat: 0, metastate: meta })
  }

  const disabled = !p.session

  return (
    <div className="toolbar">
      <div className="toolbar-title">
        {p.session ? (
          <>
            <span className="live-badge">● LIVE</span>
            <span className="device-label">{p.session.deviceName || p.session.serial}</span>
          </>
        ) : (
          <span className="device-label">未连接</span>
        )}
      </div>

      <div className="toolbar-divider" />

      <button className="icon-btn" disabled={disabled} title="电源键" onClick={key(KEYCODE.POWER)}>
        <IconPower width={19} height={19} />
      </button>
      <button className="icon-btn" disabled={disabled} title="返回" onClick={key(KEYCODE.BACK)}>
        <IconBack width={19} height={19} />
      </button>
      <button className="icon-btn" disabled={disabled} title="主页" onClick={key(KEYCODE.HOME)}>
        <IconHome width={19} height={19} />
      </button>
      <button className="icon-btn" disabled={disabled} title="最近任务" onClick={key(KEYCODE.APP_SWITCH)}>
        <IconRecent width={19} height={19} />
      </button>
      <button className="icon-btn" disabled={disabled} title="音量减" onClick={key(KEYCODE.VOLUME_DOWN)}>
        <IconVolume width={19} height={19} />
      </button>
      <button className="icon-btn" disabled={disabled} title="音量加" onClick={key(KEYCODE.VOLUME_UP)}>
        <IconVolume width={19} height={19} />
      </button>

      <div className="toolbar-divider" />

      <button
        className="icon-btn"
        disabled={disabled}
        title="旋转屏幕"
        onClick={() => p.send({ type: 'rotateDevice' })}
      >
        <IconRotate width={19} height={19} />
      </button>
      <button className="icon-btn" disabled={disabled} title="截屏" onClick={p.onScreenshot}>
        <IconCamera width={19} height={19} />
      </button>
      <button className={`icon-btn ${p.recording ? 'stop' : ''}`} disabled={disabled} title="录屏" onClick={p.onToggleRecord}>
        {p.recording ? <IconStop width={17} height={17} /> : <IconRecord width={19} height={19} />}
      </button>
      <button className="icon-btn" disabled={disabled} title="剪贴板" onClick={p.onOpenClipboard}>
        <IconClipboard width={19} height={19} />
      </button>

      <div className="toolbar-divider" />

      <button
        className={`icon-btn ${p.groupControl ? 'start' : ''}`}
        disabled={disabled}
        title={p.groupControl ? '群控已开启' : '群控'}
        onClick={p.onToggleGroupControl}
      >
        <IconLayers width={19} height={19} />
      </button>

      <button
        className={`icon-btn ${p.infoActive ? 'start' : ''}`}
        disabled={disabled}
        title={p.infoActive ? '关闭实时信息' : '显示实时信息（帧率/网速/解码方式）'}
        onClick={p.onToggleInfo}
      >
        <IconInfo width={19} height={19} />
      </button>

      <div className="spacer" />

      <button className="icon-btn" title="按键映射" onClick={p.onOpenKeymap}>
        <IconKeyboard width={19} height={19} />
      </button>
      <button
        className={`icon-btn ${p.keymapEditing ? 'start' : ''}`}
        title={p.keymapEditing ? '关闭可视化按键编辑' : '可视化编辑按键映射'}
        onClick={p.onToggleKeymapEdit}
      >
        <IconKeyboard width={19} height={19} />
        <span style={{ fontSize: 9, position: 'absolute', bottom: 2, right: 2 }}>✎</span>
      </button>
      <button className="icon-btn" title="终端 / 文件" onClick={p.onOpenTools}>
        <IconTerminal width={19} height={19} />
      </button>
      <button
        className={`icon-btn ${p.debugActive ? 'start' : ''}`}
        title={p.debugActive ? '关闭按键调试日志' : '显示按键调试日志（排查按键映射用）'}
        onClick={p.onToggleDebug}
      >
        <IconTerminal width={19} height={19} />
        <span style={{ fontSize: 9, position: 'absolute', bottom: 2, right: 2 }}>D</span>
      </button>
      <button className="icon-btn" title="设置" onClick={p.onOpenSettings}>
        <IconSettings width={19} height={19} />
      </button>
      <button className="icon-btn" title="全屏" onClick={p.onToggleFullscreen}>
        <IconFullscreen width={19} height={19} />
      </button>

      <div className="toolbar-divider" />

      <button className="btn btn-danger btn-sm" disabled={disabled} onClick={p.onStop}>
        断开
      </button>
    </div>
  )
}
