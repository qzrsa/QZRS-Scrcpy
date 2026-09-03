import { useState } from 'react'
import type { ControlCommand } from '@shared/types'
import { IconClipboard } from './icons'

interface Props {
  send: (cmd: ControlCommand) => void
  onClose: () => void
}

export function ClipboardDialog({ send, onClose }: Props): JSX.Element {
  const [text, setText] = useState('')
  const [msg, setMsg] = useState<string | null>(null)

  const sendText = (): void => {
    if (!text) return
    send({ type: 'setClipboard', text, paste: true })
    setMsg('已发送到设备剪贴板并粘贴')
  }

  const getDeviceClipboard = (): void => {
    send({ type: 'getClipboard', copyKey: 0 })
    setMsg('已请求设备剪贴板（成功后自动写入本机剪贴板）')
  }

  const sendLocalClipboard = async (): Promise<void> => {
    const local = await window.api.readClipboard()
    if (!local) {
      setMsg('本机剪贴板为空')
      return
    }
    send({ type: 'setClipboard', text: local, paste: false })
    setMsg('已将本机剪贴板内容写入设备剪贴板')
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>剪贴板同步</h2>
          <button className="icon-btn" onClick={onClose}>
            <IconClipboard width={18} height={18} />
          </button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>要发送到设备的文本</label>
            <textarea className="textarea" value={text} placeholder="输入文本…" onChange={(e) => setText(e.target.value)} />
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-primary" onClick={sendText}>
              发送并粘贴
            </button>
            <button className="btn btn-ghost" onClick={() => void sendLocalClipboard()}>
              粘贴本机剪贴板
            </button>
            <button className="btn btn-ghost" onClick={getDeviceClipboard}>
              读取设备剪贴板
            </button>
          </div>
          {msg && <div className="hint" style={{ marginTop: 10 }}>{msg}</div>}
        </div>
      </div>
    </div>
  )
}
