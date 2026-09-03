import { useState } from 'react'
import type { AdbShellResult } from '@shared/types'
import { Drawer } from './Drawer'
import { IconTerminal, IconUpload } from './icons'

interface Props {
  serial: string | null
  onClose: () => void
}

interface LogLine {
  kind: 'cmd' | 'out' | 'err'
  text: string
}

export function ToolsPanel({ serial, onClose }: Props): JSX.Element {
  const [command, setCommand] = useState('')
  const [lines, setLines] = useState<LogLine[]>([])
  const [remotePush, setRemotePush] = useState('/sdcard/Download/')
  const [remotePull, setRemotePull] = useState('/sdcard/')
  const [status, setStatus] = useState<string | null>(null)

  const run = async (): Promise<void> => {
    if (!serial || !command.trim()) return
    const cmd = command.trim()
    setLines((l) => [...l, { kind: 'cmd', text: `$ ${cmd}` }])
    setCommand('')
    const r: AdbShellResult = await window.api.runShell(serial, cmd)
    const out: LogLine[] = []
    if (r.stdout) out.push({ kind: 'out', text: r.stdout.replace(/\n$/, '') })
    if (r.stderr) out.push({ kind: 'err', text: r.stderr.replace(/\n$/, '') })
    if (!r.stdout && !r.stderr) out.push({ kind: 'out', text: `[exit ${r.code}]` })
    setLines((l) => [...l, ...out])
  }

  const push = async (): Promise<void> => {
    if (!serial) return
    const local = await window.api.openFileDialog()
    if (!local) return
    const remote = remotePush.trim() || '/sdcard/Download/'
    setStatus(`推送中… ${local}`)
    const r = await window.api.pushFile(serial, local, remote)
    setStatus(r.ok ? `已推送到 ${remote}` : r.message || '推送失败')
  }

  const pull = async (): Promise<void> => {
    if (!serial) return
    const remote = remotePull.trim()
    if (!remote) return
    setStatus('拉取中…')
    const r = await window.api.pullFile(serial, remote)
    setStatus(r.ok ? `已保存到 ${r.message}` : r.message || '拉取失败')
  }

  const disabled = !serial

  return (
    <Drawer title="终端与文件" wide onClose={onClose}>
      {disabled ? (
        <div className="hint">请先连接一台设备以使用终端与文件传输</div>
      ) : (
        <>
          <div className="field">
            <label>ADB Shell</label>
            <div className="row">
              <input
                className="text-input"
                value={command}
                placeholder="输入 shell 命令，如：getprop ro.product.model"
                onChange={(e) => setCommand(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void run()}
              />
              <button className="btn btn-primary" onClick={() => void run()}>
                <IconTerminal width={16} height={16} /> 执行
              </button>
            </div>
          </div>

          <div className="terminal">
            {lines.length === 0 && <span className="out">等待输入命令…</span>}
            {lines.map((l, i) => (
              <div key={i} className={l.kind}>
                {l.text}
              </div>
            ))}
          </div>

          <div style={{ height: 20 }} />

          <div className="field">
            <label>文件推送到设备</label>
            <div className="row">
              <input className="text-input" value={remotePush} placeholder="设备端目标路径" onChange={(e) => setRemotePush(e.target.value)} />
              <button className="btn btn-ghost" onClick={() => void push()}>
                <IconUpload width={16} height={16} /> 推送文件
              </button>
            </div>
          </div>

          <div className="field">
            <label>从设备拉取文件</label>
            <div className="row">
              <input className="text-input" value={remotePull} placeholder="设备端文件路径" onChange={(e) => setRemotePull(e.target.value)} />
              <button className="btn btn-ghost" onClick={() => void pull()}>
                拉取文件
              </button>
            </div>
          </div>

          {status && <div className="hint" style={{ marginTop: 8 }}>{status}</div>}
        </>
      )}
    </Drawer>
  )
}
