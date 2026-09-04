import type { SessionStats } from '@shared/types'
import type { SessionInfo } from '../store'

interface Props {
  session: SessionInfo
  transport: string | null
  net: SessionStats | null
  render: { renderFps: number; hardware: boolean } | null
}

function transportLabel(t: string | null): string {
  if (t === 'usb') return 'USB 连接'
  if (t === 'tcpip') return 'WiFi 连接'
  if (t === 'local') return '本地'
  return '未知'
}

function codecLabel(c: string): string {
  if (c === 'h265') return 'H.265'
  if (c === 'av1') return 'AV1'
  return 'H.264'
}

function fps(v: number | undefined | null): string {
  return typeof v === 'number' && isFinite(v) ? `${v.toFixed(0)} fps` : '—'
}

/** 视频画面左上角半透明信息面板：实时显示视频源/连接方式/解码方式/网速/三档帧率。 */
export function StatsOverlay({ session, transport, net, render }: Props): JSX.Element {
  const rows: { label: string; value: string }[] = [
    { label: '视频源', value: `${codecLabel(session.codec)} · ${session.width}x${session.height}` },
    { label: '连接方式', value: transportLabel(transport) },
    { label: '解码方式', value: render ? (render.hardware ? '硬件解码' : '软件解码') : '—' },
    { label: '网速', value: net ? `${(net.bitrate / 1e6).toFixed(1)} Mbps` : '—' },
    { label: '采集帧率', value: fps(net?.captureFps) },
    { label: '接收帧率', value: fps(net?.recvFps) },
    { label: '渲染帧率', value: fps(render?.renderFps) }
  ]

  return (
    <div className="stats-overlay">
      {rows.map((r) => (
        <div className="stats-row" key={r.label}>
          <span className="stats-label">{r.label}</span>
          <span className="stats-value">{r.value}</span>
        </div>
      ))}
    </div>
  )
}
