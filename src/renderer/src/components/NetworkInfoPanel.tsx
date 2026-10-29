import { useCallback, useEffect, useState } from 'react'
import type { NetworkInfo } from '@shared/types'
import { IconGlobe, IconRefresh, IconWifi } from './icons'

/** 设备网络信息面板：IP 接口 / WiFi / 网关 / DNS / 运营商。 */
export function NetworkInfoPanel({ serial }: { serial: string }): JSX.Element {
  const [info, setInfo] = useState<NetworkInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const r = await window.api.getNetworkInfo(serial)
      if (!r.ok) {
        setError(r.message || '获取网络信息失败')
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

  if (loading && !info) return <div className="hint">读取网络信息…</div>

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

  return (
    <div className="infopanel">
      <div className="infopanel-toolbar">
        <span className="infopanel-title">
          <IconGlobe width={15} height={15} /> 网络
        </span>
        <button className="btn btn-ghost btn-sm" disabled={loading} onClick={() => void load()}>
          <IconRefresh width={14} height={14} className={loading ? 'spin' : undefined} /> 刷新
        </button>
      </div>

      {error && <div className="infopanel-error">{error}</div>}

      <section className="infopanel-section">
        <h3>
          <IconWifi width={13} height={13} /> WiFi
        </h3>
        <div className="infopanel-grid">
          <div className="infopanel-item">
            <span className="infopanel-k">SSID</span>
            <span className="infopanel-v" title={info.wifiSsid}>
              {info.wifiSsid || '—'}
            </span>
          </div>
          <div className="infopanel-item">
            <span className="infopanel-k">BSSID</span>
            <span className="infopanel-v mono" title={info.wifiBssid}>
              {info.wifiBssid || '—'}
            </span>
          </div>
          <div className="infopanel-item">
            <span className="infopanel-k">信号强度</span>
            <span className="infopanel-v">{info.wifiRssi ? `${info.wifiRssi} dBm` : '—'}</span>
          </div>
        </div>
      </section>

      <section className="infopanel-section">
        <h3>IP 地址</h3>
        {info.interfaces.length === 0 ? (
          <div className="hint">未获取到网卡地址</div>
        ) : (
          <div className="infopanel-grid">
            {info.interfaces.map((it) => (
              <div className="infopanel-item" key={it.name}>
                <span className="infopanel-k mono">{it.name}</span>
                <span className="infopanel-v mono">{it.ip}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="infopanel-section">
        <h3>路由与解析</h3>
        <div className="infopanel-grid">
          <div className="infopanel-item">
            <span className="infopanel-k">默认网关</span>
            <span className="infopanel-v mono">{info.gateway || '—'}</span>
          </div>
          <div className="infopanel-item">
            <span className="infopanel-k">DNS</span>
            <span className="infopanel-v mono" title={info.dns.join('、')}>
              {info.dns.length > 0 ? info.dns.join('、') : '—'}
            </span>
          </div>
          <div className="infopanel-item">
            <span className="infopanel-k">运营商</span>
            <span className="infopanel-v">{info.carrier || '—'}</span>
          </div>
        </div>
      </section>
    </div>
  )
}
