import { useState } from 'react'
import { useApp } from '../store'
import { IconClose, IconWifi, IconUsb, IconPhone } from './icons'

export function ConnectDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const { devices, refreshDevices } = useApp()
  const [hostPort, setHostPort] = useState('192.168.11.111:5555')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [switching, setSwitching] = useState<string | null>(null)

  const usbDevices = devices.filter((d) => d.transport !== 'tcpip' && d.state === 'device')

  const connect = async (): Promise<void> => {
    setBusy(true)
    setMsg(null)
    const r = await window.api.connectDevice(hostPort.trim())
    setMsg(r.ok ? `已连接 ${hostPort.trim()}` : r.message || '连接失败')
    if (r.ok) void refreshDevices()
    setBusy(false)
  }

  const switchWireless = async (serial: string): Promise<void> => {
    setSwitching(serial)
    setMsg(null)
    const r = await window.api.setTcpip(serial, 5555)
    setMsg(r.ok ? `设备已切换无线：${r.message}` : r.message || '切换失败')
    void refreshDevices()
    setSwitching(null)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>无线连接</h2>
          <button className="icon-btn" onClick={onClose}>
            <IconClose width={18} height={18} />
          </button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>设备地址（IP:端口）</label>
            <div className="row">
              <input
                className="text-input"
                value={hostPort}
                placeholder="例如 192.168.11.111:5555"
                onChange={(e) => setHostPort(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void connect()}
              />
              <button className="btn btn-primary" disabled={busy} onClick={() => void connect()}>
                <IconWifi width={16} height={16} /> 连接
              </button>
            </div>
            <div className="hint">需设备与电脑在同一网络，且已开启无线调试（adb tcpip 5555）</div>
          </div>

          {usbDevices.length > 0 && (
            <div className="field">
              <label>USB 设备切换为无线</label>
              {usbDevices.map((d) => (
                <div key={d.serial} className="row between" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                  <span className="device-name" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <IconUsb width={14} height={14} /> {d.model || d.serial}
                  </span>
                  <button className="btn btn-ghost btn-sm" disabled={switching === d.serial} onClick={() => void switchWireless(d.serial)}>
                    {switching === d.serial ? '切换中…' : '切换无线'}
                  </button>
                </div>
              ))}
            </div>
          )}

          {devices.filter((d) => d.transport === 'tcpip').length > 0 && (
            <div className="field">
              <label>已连接的无线设备</label>
              {devices
                .filter((d) => d.transport === 'tcpip')
                .map((d) => (
                  <div key={d.serial} className="row" style={{ padding: '4px 0', color: 'var(--text-dim)' }}>
                    <IconPhone width={14} height={14} /> {d.serial}
                  </div>
                ))}
            </div>
          )}

          {msg && <div className="hint" style={{ marginTop: 8 }}>{msg}</div>}
        </div>
      </div>
    </div>
  )
}
