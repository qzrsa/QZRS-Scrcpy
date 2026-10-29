import { useCallback, useEffect, useState } from 'react'
import type { SystemInfo } from '@shared/types'
import { IconCpu, IconRefresh } from './icons'

/** 设备系统信息面板：一条组合命令拉回结构化数据，按分区卡片展示。 */
export function SystemInfoPanel({ serial }: { serial: string }): JSX.Element {
  const [info, setInfo] = useState<SystemInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const r = await window.api.getSystemInfo(serial)
      if (!r.ok) {
        setError(r.message || '获取系统信息失败')
        return
      }
      setInfo(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [serial])

  useEffect(() => {
    void load()
  }, [load])

  if (loading && !info) return <div className="hint">读取系统信息…</div>

  if (error && !info)
    return (
      <div className="infopanel-error">
        <span>{error}</span>
        <button className="btn btn-ghost btn-sm" onClick={() => void load()}>
          <IconRefresh width={14} height={14} /> 重试
        </button>
      </div>
    )

  if (!info) return <div className="hint">暂无数据</div>

  const rows: Array<[string, string]> = [
    ['品牌', info.brand || '—'],
    ['型号', info.model || '—'],
    ['设备代号', info.device || '—'],
    ['系统版本', info.android ? `Android ${info.android}` : '—'],
    ['SDK', info.sdk || '—'],
    ['构建号', info.build || '—'],
    ['序列号', info.serial || '—']
  ]

  return (
    <div className="infopanel">
      <div className="infopanel-toolbar">
        <span className="infopanel-title">
          <IconCpu width={15} height={15} /> {info.model || info.device || '设备'}
        </span>
        <button className="btn btn-ghost btn-sm" disabled={loading} onClick={() => void load()}>
          <IconRefresh width={14} height={14} className={loading ? 'spin' : undefined} /> 刷新
        </button>
      </div>

      {error && <div className="infopanel-error">{error}</div>}

      <section className="infopanel-section">
        <h3>基本信息</h3>
        <div className="infopanel-grid">
          {rows.map(([k, v]) => (
            <div className="infopanel-item" key={k}>
              <span className="infopanel-k">{k}</span>
              <span className="infopanel-v" title={v}>
                {v}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="infopanel-section">
        <h3>硬件与运行</h3>
        <div className="infopanel-grid">
          <div className="infopanel-item">
            <span className="infopanel-k">CPU</span>
            <span className="infopanel-v" title={info.cpu}>
              {info.cpu || '—'}
            </span>
          </div>
          <div className="infopanel-item">
            <span className="infopanel-k">核心数</span>
            <span className="infopanel-v">{info.cores || '—'}</span>
          </div>
          <div className="infopanel-item">
            <span className="infopanel-k">内存总量</span>
            <span className="infopanel-v">{info.memTotal || '—'}</span>
          </div>
          <div className="infopanel-item">
            <span className="infopanel-k">可用内存</span>
            <span className="infopanel-v">{info.memAvail || '—'}</span>
          </div>
          <div className="infopanel-item">
            <span className="infopanel-k">运行时长</span>
            <span className="infopanel-v">{info.uptime || '—'}</span>
          </div>
          <div className="infopanel-item">
            <span className="infopanel-k">屏幕分辨率</span>
            <span className="infopanel-v">{info.resolution || '—'}</span>
          </div>
          <div className="infopanel-item">
            <span className="infopanel-k">屏幕密度</span>
            <span className="infopanel-v">{info.density || '—'}</span>
          </div>
          <div className="infopanel-item">
            <span className="infopanel-k">Root</span>
            <span className={`infopanel-v ${info.root ? 'ok' : 'dim'}`}>{info.root ? '已获取' : '未获取'}</span>
          </div>
        </div>
      </section>

      <section className="infopanel-section">
        <h3>电池</h3>
        <div className="infopanel-grid">
          <div className="infopanel-item">
            <span className="infopanel-k">电量</span>
            <span className="infopanel-v">{info.battery || '—'}</span>
          </div>
          <div className="infopanel-item">
            <span className="infopanel-k">状态</span>
            <span className="infopanel-v">{info.batteryStatus || '—'}</span>
          </div>
          <div className="infopanel-item">
            <span className="infopanel-k">温度</span>
            <span className="infopanel-v">{info.batteryTemp || '—'}</span>
          </div>
        </div>
      </section>

      {info.storage.length > 0 && (
        <section className="infopanel-section">
          <h3>存储分区</h3>
          <div className="infopanel-table">
            <div className="infopanel-table-head">
              <span>挂载点</span>
              <span style={{ textAlign: 'right' }}>总量</span>
              <span style={{ textAlign: 'right' }}>已用</span>
              <span style={{ textAlign: 'right' }}>可用</span>
              <span style={{ textAlign: 'right' }}>使用率</span>
            </div>
            {info.storage.map((s) => (
              <div className="infopanel-table-row" key={s.mount}>
                <span className="mono">{s.mount}</span>
                <span style={{ textAlign: 'right' }}>{s.total}</span>
                <span style={{ textAlign: 'right' }}>{s.used}</span>
                <span style={{ textAlign: 'right' }}>{s.avail}</span>
                <span style={{ textAlign: 'right' }}>{s.usePercent}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
