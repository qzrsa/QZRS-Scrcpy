import { useCallback, useEffect, useState } from 'react'
import type { RemoteEntry } from '@shared/types'
import { IconChevron, IconDownload, IconFile, IconFolder, IconRefresh, IconTrash, IconUpload } from './icons'

const DEFAULT_PATH = '/sdcard'

function formatSize(n: number | null): string {
  if (n === null) return '—'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`
}

function formatTime(ms: number | null): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const p = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 设备端文件管理器：可视化浏览 Android 文件系统，支持上传（多选）、下载、删除（二次确认）。
 *
 * 所有文件操作都走 `adb shell stat / rm -rf` 与 `adb push / pull`，
 * 因此只能访问 adb shell 有权限的路径（未 root 时 /data 等目录会提示权限不足）。
 */
export function FileManager({ serial }: { serial: string }): JSX.Element {
  const [path, setPath] = useState(DEFAULT_PATH)
  const [parent, setParent] = useState<string | null>(null)
  const [entries, setEntries] = useState<RemoteEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  /** 正在执行操作（下载/删除）的条目路径 */
  const [busy, setBusy] = useState<string | null>(null)
  /** 待二次确认删除的条目 */
  const [pending, setPending] = useState<RemoteEntry | null>(null)
  const [uploading, setUploading] = useState(false)

  const load = useCallback(
    async (dir: string): Promise<void> => {
      setLoading(true)
      setError(null)
      try {
        const r = await window.api.listDir(serial, dir)
        if (!r.ok) {
          // 保持当前目录不变，避免用户被困在进不去的路径里
          setError(r.message || '无法读取该目录')
          return
        }
        setPath(r.path)
        setParent(r.parent)
        setEntries(r.entries)
        setPending(null)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    },
    [serial]
  )

  useEffect(() => {
    void load(DEFAULT_PATH)
  }, [load])

  const enter = (e: RemoteEntry): void => {
    if (e.kind === 'file') return
    void load(e.path)
  }

  const upload = async (): Promise<void> => {
    const files = await window.api.openFilesDialog()
    if (!files.length) return
    setUploading(true)
    setError(null)
    let ok = 0
    const failed: string[] = []
    for (let i = 0; i < files.length; i++) {
      setStatus(`上传中 ${i + 1}/${files.length}：${files[i].split(/[\\/]/).pop()}`)
      // eslint-disable-next-line no-await-in-loop
      const r = await window.api.pushFile(serial, files[i], path)
      if (r.ok) ok++
      else failed.push(`${files[i].split(/[\\/]/).pop()}（${r.message || '失败'}）`)
    }
    setUploading(false)
    setStatus(
      failed.length === 0
        ? `已上传 ${ok} 个文件到 ${path}`
        : `上传完成 ${ok}/${files.length}，失败：${failed.join('、')}`
    )
    await load(path)
  }

  const download = async (e: RemoteEntry): Promise<void> => {
    setBusy(e.path)
    setStatus(e.kind === 'dir' ? `正在下载文件夹 ${e.name}…` : `正在下载 ${e.name}…`)
    const r = await window.api.pullRemoteTo(serial, e.path)
    setBusy(null)
    setStatus(r.ok ? `已保存到 ${r.message}` : r.message || '下载失败')
  }

  const doDelete = async (): Promise<void> => {
    if (!pending) return
    const target = pending
    setBusy(target.path)
    const r = await window.api.deleteRemote(serial, target.path)
    setBusy(null)
    setPending(null)
    setStatus(r.ok ? `已删除 ${target.name}` : r.message || '删除失败')
    if (r.ok) await load(path)
  }

  const crumbs = path.split('/').filter(Boolean)

  return (
    <div className="fm">
      <div className="fm-toolbar">
        <button
          className="icon-btn"
          title="上级目录"
          disabled={!parent || loading}
          onClick={() => parent && void load(parent)}
        >
          <IconChevron width={16} height={16} style={{ transform: 'rotate(180deg)' }} />
        </button>

        <div className="fm-path" title={path}>
          <button className="fm-crumb" onClick={() => void load('/')}>
            /
          </button>
          {crumbs.map((c, i) => {
            const to = '/' + crumbs.slice(0, i + 1).join('/')
            const last = i === crumbs.length - 1
            return (
              <span key={to} className="fm-crumb-wrap">
                <span className="fm-crumb-sep">›</span>
                <button
                  className={`fm-crumb ${last ? 'current' : ''}`}
                  disabled={last}
                  onClick={() => void load(to)}
                >
                  {c}
                </button>
              </span>
            )
          })}
        </div>

        <button className="icon-btn" title="刷新" disabled={loading} onClick={() => void load(path)}>
          <IconRefresh width={16} height={16} className={loading ? 'spin' : undefined} />
        </button>
        <button className="btn btn-ghost btn-sm" title="上传文件到当前目录" disabled={uploading} onClick={() => void upload()}>
          <IconUpload width={14} height={14} /> 上传
        </button>
      </div>

      {error && <div className="fm-error">{error}</div>}

      <div className="fm-head fm-grid">
        <span>名称</span>
        <span style={{ textAlign: 'right' }}>大小</span>
        <span>修改时间</span>
        <span style={{ textAlign: 'right' }}>操作</span>
      </div>

      <div className="fm-list">
        {loading && entries.length === 0 && <div className="hint">读取中…</div>}
        {!loading && !error && entries.length === 0 && <div className="hint">此目录为空</div>}

        {entries.map((e) => {
          const isDir = e.kind === 'dir'
          const rowBusy = busy === e.path
          return (
            <div key={e.path}>
              <div className="fm-row fm-grid">
                <button
                  className={`fm-name ${isDir ? 'is-dir' : ''}`}
                  title={isDir ? `进入 ${e.name}` : e.name}
                  onClick={() => enter(e)}
                >
                  {isDir ? <IconFolder width={15} height={15} /> : <IconFile width={15} height={15} />}
                  <span className="fm-name-text">{e.name}</span>
                  {e.kind === 'link' && <span className="fm-tag">链接</span>}
                </button>
                <span className="fm-size">{formatSize(e.size)}</span>
                <span className="fm-time">{formatTime(e.mtime)}</span>
                <span className="fm-actions">
                  <button
                    className="icon-btn"
                    title={isDir ? '下载整个文件夹' : '下载到电脑'}
                    disabled={rowBusy}
                    onClick={() => void download(e)}
                  >
                    <IconDownload width={15} height={15} />
                  </button>
                  <button
                    className="icon-btn fm-danger"
                    title="删除"
                    disabled={rowBusy}
                    onClick={() => setPending(e)}
                  >
                    <IconTrash width={15} height={15} />
                  </button>
                </span>
              </div>

              {pending?.path === e.path && (
                <div className="fm-confirm">
                  <span>
                    {isDir ? '将递归删除整个文件夹：' : '确定删除：'}
                    <b>{e.name}</b>？此操作不可撤销。
                  </span>
                  <button className="btn btn-danger btn-sm" disabled={rowBusy} onClick={() => void doDelete()}>
                    {rowBusy ? '删除中…' : '确认删除'}
                  </button>
                  <button className="btn btn-ghost btn-sm" disabled={rowBusy} onClick={() => setPending(null)}>
                    取消
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="fm-foot">
        <span className="hint">
          {entries.length} 项{loading ? ' · 读取中…' : ''}
        </span>
        {status && <span className="fm-status" title={status}>{status}</span>}
      </div>
    </div>
  )
}
