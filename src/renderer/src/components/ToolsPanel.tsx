import { useState } from 'react'
import type { AdbShellResult } from '@shared/types'
import { Drawer } from './Drawer'
import { FileManager } from './FileManager'
import { SystemInfoPanel } from './SystemInfoPanel'
import { NetworkInfoPanel } from './NetworkInfoPanel'
import { AppManagerPanel } from './AppManagerPanel'
import { LogcatPanel } from './LogcatPanel'
import { IconApps, IconCpu, IconFolder, IconGlobe, IconScroll, IconTerminal } from './icons'

interface Props {
  serial: string | null
  onClose: () => void
}

interface LogLine {
  kind: 'cmd' | 'out' | 'err'
  text: string
}

type Tab = 'term' | 'files' | 'sys' | 'net' | 'apps' | 'log'

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
      title="终端与工具"
      wide
      resizableKey="tools"
      defaultWidth={760}
      onClose={onClose}
    >
      {!serial ? (
        <div className="hint">请先连接一台设备以使用终端与工具</div>
      ) : (
        <div className="tools-layout">
          <div className="seg">
            <button className={tab === 'term' ? 'active' : undefined} onClick={() => setTab('term')}>
              <IconTerminal width={15} height={15} /> 终端
            </button>
            <button className={tab === 'files' ? 'active' : undefined} onClick={() => setTab('files')}>
              <IconFolder width={15} height={15} /> 文件
            </button>
            <button className={tab === 'sys' ? 'active' : undefined} onClick={() => setTab('sys')}>
              <IconCpu width={15} height={15} /> 系统
            </button>
            <button className={tab === 'net' ? 'active' : undefined} onClick={() => setTab('net')}>
              <IconGlobe width={15} height={15} /> 网络
            </button>
            <button className={tab === 'apps' ? 'active' : undefined} onClick={() => setTab('apps')}>
              <IconApps width={15} height={15} /> 应用
            </button>
            <button className={tab === 'log' ? 'active' : undefined} onClick={() => setTab('log')}>
              <IconScroll width={15} height={15} /> 日志
            </button>
          </div>

          {tab === 'term' && (
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
          )}

          {tab === 'files' && <FileManager serial={serial} />}
          {tab === 'sys' && <SystemInfoPanel serial={serial} />}
          {tab === 'net' && <NetworkInfoPanel serial={serial} />}
          {tab === 'apps' && <AppManagerPanel serial={serial} />}
          {tab === 'log' && <LogcatPanel serial={serial} />}
        </div>
      )}
    </Drawer>
  )
}
