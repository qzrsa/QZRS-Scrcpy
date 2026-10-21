import { useState } from 'react'
import type { AdbShellResult } from '@shared/types'
import { Drawer } from './Drawer'
import { FileManager } from './FileManager'
import { IconFolder, IconTerminal } from './icons'

interface Props {
  serial: string | null
  onClose: () => void
}

interface LogLine {
  kind: 'cmd' | 'out' | 'err'
  text: string
}

type Tab = 'term' | 'files'

export function ToolsPanel({ serial, onClose }: Props): JSX.Element {
  const [tab, setTab] = useState<Tab>('term')
  const [command, setCommand] = useState('')
  const [lines, setLines] = useState<LogLine[]>([])

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

  return (
    <Drawer
      title="终端与文件"
      wide
      resizableKey="tools"
      defaultWidth={720}
      onClose={onClose}
    >
      {!serial ? (
        <div className="hint">请先连接一台设备以使用终端与文件管理</div>
      ) : (
        <>
          <div className="seg">
            <button className={tab === 'term' ? 'active' : undefined} onClick={() => setTab('term')}>
              <IconTerminal width={15} height={15} /> 终端
            </button>
            <button className={tab === 'files' ? 'active' : undefined} onClick={() => setTab('files')}>
              <IconFolder width={15} height={15} /> 文件管理
            </button>
          </div>

          {tab === 'term' ? (
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
            </>
          ) : (
            <FileManager serial={serial} />
          )}
        </>
      )}
    </Drawer>
  )
}
