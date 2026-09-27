import { useState, type MouseEvent } from 'react'
import type { DeviceInfo } from '@shared/types'
import { useApp } from '../store'
import { IconRefresh, IconWifi, IconUsb, IconPhone, IconPlay, IconSettings } from './icons'
import { ContextMenu, type MenuItem, type MenuState } from './ContextMenu'

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
  const [menu, setMenu] = useState<MenuState | null>(null)

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

  const launchExternal = async (serial: string): Promise<void> => {
    const r = await window.api.launchExternalScrcpy(serial)
    if (!r.ok) alert(r.message || '启动 scrcpy 失败')
  }

  const reconnect = async (serial: string): Promise<void> => {
    const r = await window.api.connectDevice(serial)
    if (!r.ok) alert(r.message || `重新连接 ${serial} 失败`)
  }

  const forget = async (serial: string): Promise<void> => {
    const r = await window.api.forgetDevice(serial)
    if (!r.ok) alert(r.message || '删除设备失败')
  }

  /** 右键菜单：原设备行右侧的「显示器+播放」图标按钮已收进这里 */
  const openMenu = (e: MouseEvent<HTMLDivElement>, d: DeviceInfo): void => {
    e.preventDefault()
    e.stopPropagation()
    const online = d.state === 'device'
    // tcpip 设备的 serial 就是 host:port，可直接用 serial 做 adb connect / disconnect
    const isTcpip = /:\d+$/.test(d.serial)
    const running = runningFor(d.serial)
    const items: MenuItem[] = [
      {
        key: 'scrcpy',
        label: '通过 Scrcpy 打开',
        disabled: !online,
        hint: online
          ? '用官方 scrcpy.exe 在独立窗口里打开该设备（内置渲染异常时的回退方案）'
          : '设备当前未连接，无法启动 scrcpy',
        onClick: () => void launchExternal(d.serial)
      }
    ]
    if (isTcpip && !online) {
      items.push({
        key: 'reconnect',
        label: '重新连接',
        hint: `执行 adb connect ${d.serial}`,
        onClick: () => void reconnect(d.serial)
      })
    }
    if (running) {
      items.push({
        key: 'stop',
        label: '断开镜像',
        hint: '停止当前正在运行的镜像会话',
        onClick: () => void stopSession(running)
      })
    }
    items.push({
      key: 'forget',
      label: isTcpip && online ? '断开连接并删除' : '删除设备',
      danger: true,
      hint: isTcpip
        ? '先执行 adb disconnect，再从历史列表中移除'
        : '从历史列表中移除；设备仍插着 USB 时会在下次刷新（约 3s）后重新出现',
      onClick: () => void forget(d.serial)
    })
    setMenu({ x: e.clientX, y: e.clientY, title: d.model || d.serial, items })
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

      <div className="device-list" onScroll={() => setMenu(null)}>
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
              className={`device-card ${isSelected ? 'active' : ''} ${d.known ? 'known' : ''}`}
              onClick={() => {
                if (d.state === 'device' && !isBusy) onSelect(d.serial)
              }}
              onContextMenu={(e) => openMenu(e, d)}
              title={
                running
                  ? '点击切换到此设备（右键更多操作）'
                  : d.known
                    ? '历史设备（当前未连接）· 右键可重连或删除'
                    : '点击开始镜像（右键更多操作）'
              }
            >
              <div className={`device-dot ${d.state}`} />
              <div className="device-info">
                <div className="device-name" title={d.serial}>{d.model || d.serial}</div>
                <div className="device-serial">
                  {d.transport === 'tcpip' ? <IconWifi width={11} height={11} /> : <IconUsb width={11} height={11} />}
                  {d.serial}
                  {d.known && <span className="device-tag">历史</span>}
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
            </div>
          )
        })}
      </div>

      <div className="sidebar-footer">
        <button className="btn btn-ghost btn-block" onClick={onOpenSettings}>
          <IconSettings width={16} height={16} /> 设置
        </button>
      </div>

      <ContextMenu state={menu} onClose={() => setMenu(null)} />
    </aside>
  )
}
