import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppInfo, AppListResult } from '@shared/types'
import {
  IconApps,
  IconCheck,
  IconClose,
  IconPlay,
  IconRefresh,
  IconSearch,
  IconStop,
  IconTrash
} from './icons'

type Action = 'launch' | 'stop' | 'clear' | 'uninstall' | 'info'

/** 应用图标缓存：serial|pkg → 图标（null = 加载失败，避免重复请求） */
const iconCache = new Map<string, { mime: string; data: string } | null>()

/** 待确认的危险操作（清数据 / 卸载） */
interface ConfirmState {
  action: 'clear' | 'uninstall'
  app: AppInfo
}

/** 应用详情弹窗内容 */
interface DetailState {
  app: AppInfo
  detail: string
}

/** 设备应用管理：列表 + 搜索 + 启动/停止/清数据/卸载/详情。 */
export function AppManagerPanel({ serial }: { serial: string }): JSX.Element {
  const [apps, setApps] = useState<AppInfo[]>([])
  const [includeSystem, setIncludeSystem] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [busyPkg, setBusyPkg] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [detail, setDetail] = useState<DetailState | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const r: AppListResult = await window.api.listApps(serial, includeSystem)
      if (!r.ok) {
        setError(r.message || '获取应用列表失败')
        return
      }
      setApps(r.apps)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [serial, includeSystem])

  useEffect(() => {
    void load()
  }, [load])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return apps
    return apps.filter((a) => a.pkg.toLowerCase().includes(q) || a.label.toLowerCase().includes(q))
  }, [apps, query])

  const runAction = async (action: Action, app: AppInfo): Promise<void> => {
    setBusyPkg(app.pkg)
    setStatus(null)
    try {
      const r = await window.api.appAction(serial, action, app.pkg)
      if (action === 'info') {
        if (r.ok) setDetail({ app, detail: r.detail || r.message || '' })
        else setStatus(r.message || '获取详情失败')
        return
      }
      setStatus(r.ok ? `「${app.label || app.pkg}」${ACTION_TEXT[action]}成功` : r.message || '操作失败')
      if (action === 'uninstall') await load()
    } finally {
      setBusyPkg(null)
    }
  }

  const doConfirm = async (): Promise<void> => {
    if (!confirm) return
    const { action, app } = confirm
    setConfirm(null)
    await runAction(action, app)
  }

  return (
    <div className="appmgr">
      <div className="appmgr-toolbar">
        <div className="appmgr-search">
          <IconSearch width={14} height={14} />
          <input
            className="text-input"
            value={query}
            placeholder="搜索应用名或包名…"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <label className="appmgr-toggle" title="系统应用数量多，列表会较长">
          <input
            type="checkbox"
            checked={includeSystem}
            onChange={(e) => setIncludeSystem(e.target.checked)}
          />
          显示系统应用
        </label>
        <button className="btn btn-ghost btn-sm" disabled={loading} onClick={() => void load()}>
          <IconRefresh width={14} height={14} className={loading ? 'spin' : undefined} /> 刷新
        </button>
      </div>

      {error && <div className="infopanel-error">{error}</div>}

      <div className="appmgr-list">
        {loading && apps.length === 0 && <div className="hint">读取应用列表…</div>}
        {!loading && !error && filtered.length === 0 && (
          <div className="hint">{query ? '没有匹配的应用' : '没有应用'}</div>
        )}

        {filtered.map((a) => {
          const busy = busyPkg === a.pkg
          const name = a.label || a.pkg
          return (
            <div className="appmgr-row" key={a.pkg}>
              <AppIcon serial={serial} pkg={a.pkg} name={name} />
              <div className="appmgr-row-main">
                <span className="appmgr-name" title={name}>
                  {name}
                </span>
                {a.label && <span className="appmgr-pkg mono">{a.pkg}</span>}
              </div>
              <div className="appmgr-actions">
                <button
                  className="icon-btn"
                  title="启动"
                  disabled={busy}
                  onClick={() => void runAction('launch', a)}
                >
                  <IconPlay width={15} height={15} />
                </button>
                <button
                  className="icon-btn"
                  title="停止"
                  disabled={busy}
                  onClick={() => void runAction('stop', a)}
                >
                  <IconStop width={15} height={15} />
                </button>
                <button
                  className="icon-btn"
                  title="清数据"
                  disabled={busy}
                  onClick={() => setConfirm({ action: 'clear', app: a })}
                >
                  <IconRefresh width={15} height={15} />
                </button>
                <button
                  className="icon-btn appmgr-danger"
                  title="卸载"
                  disabled={busy}
                  onClick={() => setConfirm({ action: 'uninstall', app: a })}
                >
                  <IconTrash width={15} height={15} />
                </button>
                <button
                  className="icon-btn"
                  title="详情"
                  disabled={busy}
                  onClick={() => void runAction('info', a)}
                >
                  <IconApps width={15} height={15} />
                </button>
              </div>
            </div>
          )
        })}
      </div>

      <div className="fm-foot">
        <span className="hint">
          {filtered.length} / {apps.length} 个应用{loading ? ' · 读取中…' : ''}
        </span>
        {status && (
          <span className="fm-status" title={status}>
            {status}
          </span>
        )}
      </div>

      {/* 危险操作二次确认 */}
      {confirm && (
        <div className="appmgr-confirm">
          <span>
            确定{confirm.action === 'uninstall' ? '卸载' : '清除数据'}「
            <b>{confirm.app.label || confirm.app.pkg}</b>」？
            {confirm.action === 'uninstall'
              ? ' 卸载会移除该应用。'
              : ' 清除数据会删除该应用的所有登录状态与本地数据。'}
            此操作不可撤销。
          </span>
          <button className="btn btn-danger btn-sm" onClick={() => void doConfirm()}>
            {confirm.action === 'uninstall' ? '确认卸载' : '确认清除'}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => setConfirm(null)}>
            取消
          </button>
        </div>
      )}

      {/* 应用详情弹窗 */}
      {detail && (
        <>
          <div className="appmgr-modal-backdrop" onClick={() => setDetail(null)} />
          <div className="appmgr-modal" role="dialog" aria-label="应用详情">
            <div className="appmgr-modal-head">
              <span title={detail.app.label || detail.app.pkg}>{detail.app.label || detail.app.pkg}</span>
              <button className="icon-btn" title="关闭" onClick={() => setDetail(null)}>
                <IconClose width={16} height={16} />
              </button>
            </div>
            <div className="appmgr-modal-pkg mono">{detail.app.pkg}</div>
            <pre className="appmgr-modal-body">{detail.detail || '无详情信息'}</pre>
            <div className="appmgr-modal-foot">
              <button className="btn btn-ghost btn-sm" onClick={() => setDetail(null)}>
                <IconCheck width={14} height={14} /> 关闭
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

const ACTION_TEXT: Record<Action, string> = {
  launch: '启动',
  stop: '停止',
  clear: '清数据',
  uninstall: '卸载',
  info: '详情'
}

/**
 * 应用图标（懒加载）：进入视口才从设备拉取图标（主进程解析 APK 的 manifest + arsc
 * 定位真实图标资源，兼容资源混淆的 App），结果进模块级缓存，滚动回来不重复请求；
 * 加载前/失败时显示应用名首字母占位。
 */
function AppIcon({ serial, pkg, name }: { serial: string; pkg: string; name: string }): JSX.Element {
  const key = `${serial}|${pkg}`
  const [icon, setIcon] = useState<{ mime: string; data: string } | null | undefined>(() =>
    iconCache.get(key)
  )
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // 已缓存（含失败 = null）就直接用，不再请求
    if (iconCache.has(key)) {
      setIcon(iconCache.get(key) ?? null)
      return
    }
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect()
          void window.api
            .appIcon(serial, pkg)
            .then((r) => {
              const v = r.ok && r.data ? { mime: r.mime || 'image/png', data: r.data } : null
              iconCache.set(key, v)
              setIcon(v)
            })
            .catch(() => {
              iconCache.set(key, null)
              setIcon(null)
            })
        }
      },
      { rootMargin: '120px' }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [key, serial, pkg])

  return (
    <div className="appmgr-icon" ref={ref}>
      {icon ? (
        <img src={`data:${icon.mime};base64,${icon.data}`} alt="" draggable={false} />
      ) : (
        <span className="appmgr-icon-ph">{name ? name.slice(0, 1).toUpperCase() : '?'}</span>
      )}
    </div>
  )
}
