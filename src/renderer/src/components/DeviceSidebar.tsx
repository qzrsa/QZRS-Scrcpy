import { useState } from 'react'
import type { DeviceInfo } from '@shared/types'
import { useApp } from '../store'
import { IconRefresh, IconWifi, IconUsb, IconPhone, IconPlay, IconSettings, IconMonitorPlay } from './icons'

interface Props {
  activeSessionSerial: string | null
  onStart: (serial: string) => void
  onSelect: (serial: string) => void
  onOpenConnect: () => void
  onOpenSettings: () => void
}

export function DeviceSidebar({ activeSessionSerial, onStart, onSelect, onOpenConnect, onOpenSettings }: Props): JSX.Element {
  const { devices, sessions, refreshDevices, stopSession } = useApp()
  const [busy, setBusy] = useState<string | null>(null)

  const runningFor = (serial: string): string | null => {
    const s = sessions.find((x) => x.serial === serial)
    return s ? s.sessionId : null
  }

  const handleToggle = async (device: DeviceInfo): Promise<void> => {
    const running = runningFor(device.serial)
    if (running) {
      await stopSession(running)
    } else {
      setBusy(device.serial)
      try {
        await onStart(device.serial)
      } finally {
        setBusy(null)
      }
    }
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="brand">
          <span className="brand-logo">
            <IconPhone width={18} height={18} />
          </span>
          <div className="brand-text">
            <div className="brand-name">QZRS Scrcpy</div>
            <div className="brand-sub">手机远程控制</div>
          </div>
        </div>
      </div>

      <div className="sidebar-actions">
        <button className="btn btn-primary btn-block" onClick={onOpenConnect}>
          <IconWifi width={16} height={16} /> 无线连接
        </button>
        <button className="btn btn-ghost btn-block" onClick={() => void refreshDevices()}>
          <IconRefresh width={16} height={16} /> 刷新设备
        </button>
      </div>

      <div className="sidebar-section-title">设备列表 <span className="count">{devices.filter((d) => d.state === 'device').length}</span></div>

      <div className="device-list">
        {devices.length === 0 && (
          <div className="empty-devices">
            <IconPhone width={32} height={32} />
            <p>暂无设备</p>
            <span>通过 USB 连接手机，或点击上方“无线连接”</span>
          </div>
        )}
        {devices.map((d) => {
          const running = runningFor(d.serial)
          const isBusy = busy === d.serial
          const isSelected = activeSessionSerial === d.serial
          return (
            <div
              key={d.serial}
              className={`device-card ${isSelected ? 'active' : ''}`}
              onClick={() => {
                if (d.state === 'device' && !isBusy) onSelect(d.serial)
              }}
              title={running ? '点击切换到此设备' : '点击开始镜像'}
            >
              <div className={`device-dot ${d.state}`} />
              <div className="device-info">
                <div className="device-name" title={d.serial}>{d.model || d.serial}</div>
                <div className="device-serial">
                  {d.transport === 'tcpip' ? <IconWifi width={11} height={11} /> : <IconUsb width={11} height={11} />}
                  {d.serial}
                </div>
              </div>
              <button
                className={`icon-btn ${running ? 'stop' : 'start'}`}
                disabled={isBusy || d.state !== 'device'}
                onClick={(e) => {
                  e.stopPropagation()
                  void handleToggle(d)
                }}
                title={running ? '断开' : '开始镜像'}
              >
                {running ? <span className="stop-square" /> : <IconPlay width={15} height={15} />}
              </button>
              <button
                className="icon-btn"
                disabled={isBusy || d.state !== 'device'}
                onClick={async (e) => {
                  e.stopPropagation()
                  const r = await window.api.launchExternalScrcpy(d.serial)
                  if (!r.ok) alert(r.message || '启动 scrcpy 失败')
                }}
                title="在 Scrcpy 独立窗口中查看（WebCodecs 渲染异常时的回退方案）"
              >
                <IconMonitorPlay width={13} height={13} />
              </button>
            </div>
          )
        })}
      </div>

      <div className="sidebar-footer">
        <button className="btn btn-ghost btn-block" onClick={onOpenSettings}>
          <IconSettings width={16} height={16} /> 设置
        </button>
      </div>
    </aside>
  )
}
