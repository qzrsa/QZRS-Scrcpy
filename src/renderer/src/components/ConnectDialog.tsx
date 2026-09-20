import { useCallback, useEffect, useState } from 'react'
import { useApp } from '../store'
import { IconClose, IconWifi, IconUsb, IconPhone, IconRefresh } from './icons'

interface ScanResult {
  ok: boolean
  ips: string[]
  subnets: string[]
  message?: string
}

export function ConnectDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const { devices, refreshDevices } = useApp()
  const [hostPort, setHostPort] = useState('192.168.11.111:5555')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [switching, setSwitching] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [deep, setDeep] = useState(false)
  const [scanned, setScanned] = useState<ScanResult | null>(null)

  const usbDevices = devices.filter((d) => d.transport !== 'tcpip' && d.state === 'device')

  /**
   * 扫描局域网内开放 5555 端口的设备。adb tcpip 模式不发 mDNS 广播，只能扫端口。
   * all=false 扫物理网卡网段 + 本机回环 127.0.0.0/24（快）；all=true 额外再扫虚拟网卡（VMware/VPN）网段。
   */
  const scan = useCallback(async (all = false): Promise<void> => {
    setDeep(all)
    setScanning(true)
    const r = await window.api.scanLanDevices(5555, all)
    setScanned(r)
    setScanning(false)
    if (!r.ok) setMsg(r.message || '扫描失败')
  }, [])

  // 打开对话框时自动扫一次
  useEffect(() => {
    void scan()
  }, [scan])

  const connect = async (): Promise<void> => {
    setBusy(true)
    setMsg(null)
    const r = await window.api.connectDevice(hostPort.trim())
    setMsg(r.ok ? `已连接 ${hostPort.trim()}` : r.message || '连接失败')
    if (r.ok) void refreshDevices()
    setBusy(false)
  }

  const connectIp = async (ip: string): Promise<void> => {
    setBusy(true)
    setMsg(null)
    const r = await window.api.connectDevice(`${ip}:5555`)
    setMsg(r.ok ? `已连接 ${ip}:5555` : r.message || '连接失败')
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

          <div className="field">
            <div className="row between">
              <label style={{ marginBottom: 0 }}>局域网设备（扫描 5555 端口）</label>
              <div className="row" style={{ gap: 6 }}>
                <button className="btn btn-ghost btn-sm" disabled={scanning} onClick={() => void scan(false)}>
                  <IconRefresh width={14} height={14} className={scanning && !deep ? 'spin' : undefined} />
                  {scanning && !deep ? '扫描中…' : '重新扫描'}
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={scanning}
                  title="额外扫描 VMware / VPN 等虚拟网卡网段（回环 127.0.0.1 两种模式都会扫），覆盖更全但耗时更长"
                  onClick={() => void scan(true)}
                >
                  <IconRefresh width={14} height={14} className={scanning && deep ? 'spin' : undefined} />
                  {scanning && deep ? '深度扫描中…' : '深度扫描'}
                </button>
              </div>
            </div>

            {scanning && (
              <div className="hint" style={{ marginTop: 6 }}>
                正在{deep ? '深度' : ''}扫描（{deep ? '全部网卡网段 + 127.0.0.1' : '仅物理网卡网段'}），请稍候…
              </div>
            )}

            {!scanning && scanned?.ok && scanned.ips.length === 0 && (
              <div className="hint" style={{ marginTop: 6 }}>
                未发现设备。请确认手机已开启无线调试（adb tcpip 5555）且与电脑在同一网段；
                若手机在其它网段，可试用「深度扫描」（额外扫虚拟网卡网段）。
              </div>
            )}

            {!scanning && scanned?.ok && scanned.ips.length > 0 && (
              <div style={{ marginTop: 6 }}>
                <div className="hint" style={{ marginBottom: 4 }}>
                  已扫描 {scanned.subnets.length ? scanned.subnets.map((s) => `${s}.0/24`).join('、') : '局域网'}
                  ，发现 {scanned.ips.length} 台
                </div>
                {scanned.ips.map((ip) => {
                  const connected = devices.some((d) => d.serial.startsWith(ip))
                  return (
                    <div
                      key={ip}
                      className="row between"
                      style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}
                    >
                      <span className="device-name" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <IconWifi width={14} height={14} /> {ip}:5555
                        {ip.startsWith('127.') && (
                          <span
                            className="hint"
                            title="本机回环地址：来自端口转发 / 内网穿透 / 本机模拟器，不是局域网设备"
                            style={{ border: '1px solid var(--border)', borderRadius: 4, padding: '0 4px' }}
                          >
                            本机
                          </span>
                        )}
                      </span>
                      {connected ? (
                        <span className="hint" style={{ color: 'var(--green)' }}>已连接</span>
                      ) : (
                        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void connectIp(ip)}>
                          连接
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
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
