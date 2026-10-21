import { useCallback, useEffect, useState } from 'react'
import type { RemoteEntry } from '@shared/types'
import {
  IconCheck,
  IconChevron,
  IconClose,
  IconCopy,
  IconDownload,
  IconFile,
  IconFolder,
  IconMove,
  IconRefresh,
  IconTrash,
  IconUpload
} from './icons'

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

type TransferMode = 'move' | 'copy'

const MODE_TEXT: Record<TransferMode, string> = { move: '移动', copy: '复制' }

/**
 * 设备端文件管理器：可视化浏览 Android 文件系统。
 *
 * 能力：上传（多选）、下载、删除（**总是二次确认**）、移动 / 复制（选目标目录），
 * 以及「批量」模式下对多个条目一次性做删除 / 移动 / 复制。
 *
 * 所有文件操作都走 `adb shell stat / rm -rf / mv / cp` 与 `adb push / pull`，
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
  const [uploading, setUploading] = useState(false)

  /** 批量模式：行首出现勾选框，工具条换成批量操作 */
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<string[]>([])

  /** 待确认删除的条目（单个删除 = 长度 1，批量删除 = 选中的那些） */
  const [askDelete, setAskDelete] = useState<RemoteEntry[]>([])
  /** 移动/复制的目标目录选择器 */
  const [picker, setPicker] = useState<{ mode: TransferMode; paths: string[] } | null>(null)
  /** 目标已有同名项 → 等用户决定是否覆盖 */
  const [transferAsk, setTransferAsk] = useState<{
    mode: TransferMode
    paths: string[]
    dest: string
    conflicts: string[]
  } | null>(null)
  const [transferring, setTransferring] = useState(false)

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
        setAskDelete([])
        setTransferAsk(null)
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

  /** 切换目录：顺手清掉跨目录没有意义的选中态 */
  const go = (dir: string): void => {
    setSelected([])
    setSelectMode(false)
    void load(dir)
  }

  const enter = (e: RemoteEntry): void => {
    if (e.kind === 'file') return
    go(e.path)
  }

  const toggleOne = (p: string): void =>
    setSelected((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]))

  const allSelected = entries.length > 0 && selected.length === entries.length

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

  /* ------------------------------------------------------------------ 删除 */

  const doDelete = async (): Promise<void> => {
    const list = askDelete
    if (list.length === 0) return
    setAskDelete([])
    let ok = 0
    const failed: string[] = []
    const failedPaths: string[] = []
    for (let i = 0; i < list.length; i++) {
      const e = list[i]
      setBusy(e.path)
      if (list.length > 1) setStatus(`正在删除 ${i + 1}/${list.length}：${e.name}`)
      // eslint-disable-next-line no-await-in-loop
      const r = await window.api.deleteRemote(serial, e.path)
      if (r.ok) ok++
      else {
        failed.push(`${e.name}（${r.message || '失败'}）`)
        failedPaths.push(e.path)
      }
    }
    setBusy(null)
    // 只保留删失败的那些，用户可以直接再点一次删除重试
    setSelected((prev) => prev.filter((p2) => failedPaths.includes(p2)))
    setStatus(
      failed.length === 0
        ? `已删除 ${ok} 项`
        : ok === 0
          ? `删除失败：${failed.join('、')}`
          : `已删除 ${ok}/${list.length}，失败：${failed.join('、')}`
    )
    await load(path)
  }

  /* ------------------------------------------------------ 移动 / 复制（批量） */

  const openPicker = (mode: TransferMode, paths: string[]): void => {
    if (paths.length === 0) return
    setPicker({ mode, paths })
  }

  const runTransfer = async (
    mode: TransferMode,
    paths: string[],
    dest: string,
    overwrite: boolean
  ): Promise<void> => {
    setTransferring(true)
    setTransferAsk(null)
    setStatus(`正在${MODE_TEXT[mode]} ${paths.length} 项到 ${dest}…`)
    try {
      const r = await window.api.transferFiles(serial, mode, paths, dest, overwrite)
      if (!r.ok) {
        setStatus(r.message || `${MODE_TEXT[mode]}失败`)
        return
      }
      // 目标有同名项：停下来问一次，别默默覆盖
      if (r.conflicts.length > 0) {
        setPicker(null)
        setTransferAsk({ mode, paths: r.conflicts, dest, conflicts: r.conflicts })
        setStatus(`${r.conflicts.length} 项在目标里已有同名条目，等待确认`)
        return
      }
      const parts = [`已${MODE_TEXT[mode]} ${r.okNames.length} 项 → ${dest}`]
      if (r.failed.length > 0) parts.push(`失败：${r.failed.map((f) => `${f.name}（${f.message}）`).join('、')}`)
      setStatus(parts.join('，'))
      setPicker(null)
      setSelected([])
      await load(path)
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e))
    } finally {
      setTransferring(false)
    }
  }

  const crumbs = path.split('/').filter(Boolean)
  const selectedEntries = entries.filter((e) => selected.includes(e.path))
  const deleteOne = askDelete.length === 1 ? askDelete[0] : null

  return (
    <div className="fm">
      <div className="fm-toolbar">
        <button
          className="icon-btn"
          title="上级目录"
          disabled={!parent || loading}
          onClick={() => parent && go(parent)}
        >
          <IconChevron width={16} height={16} style={{ transform: 'rotate(180deg)' }} />
        </button>

        <div className="fm-path" title={path}>
          <button className="fm-crumb" onClick={() => go('/')}>
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
                  onClick={() => go(to)}
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
        <button
          className={`btn btn-sm ${selectMode ? 'btn-primary' : 'btn-ghost'}`}
          title={selectMode ? '退出批量' : '批量管理（多选后移动/复制/删除）'}
          onClick={() => {
            setSelectMode((v) => !v)
            setSelected([])
            setAskDelete([])
          }}
        >
          批量
        </button>
      </div>

      {/* 批量操作条：只在批量模式下出现，按钮按"已选数量"禁用 */}
      {selectMode && (
        <div className="fm-batch">
          <span className="fm-batch-count">已选 {selected.length} / {entries.length} 项</span>
          <button
            className="btn btn-ghost btn-sm"
            disabled={entries.length === 0}
            onClick={() => setSelected(allSelected ? [] : entries.map((e) => e.path))}
          >
            {allSelected ? '取消全选' : '全选'}
          </button>
          <span className="fm-batch-sep" />
          <button
            className="btn btn-sm"
            disabled={selected.length === 0 || transferring}
            onClick={() => openPicker('move', selected)}
          >
            <IconMove width={14} height={14} /> 移动
          </button>
          <button
            className="btn btn-sm"
            disabled={selected.length === 0 || transferring}
            onClick={() => openPicker('copy', selected)}
          >
            <IconCopy width={14} height={14} /> 复制
          </button>
          <button
            className="btn btn-danger btn-sm"
            disabled={selected.length === 0 || transferring}
            onClick={() => setAskDelete(selectedEntries)}
          >
            <IconTrash width={14} height={14} /> 删除
          </button>
        </div>
      )}

      {error && <div className="fm-error">{error}</div>}

      {/* 删除确认：单个/批量共用一条，批量时说明"会递归删除文件夹" */}
      {askDelete.length > 0 && (
        <div className="fm-confirm">
          <span>
            确定删除
            {deleteOne ? (
              <>
                {deleteOne.kind === 'dir' ? '整个文件夹 ' : ' '}
                <b>{deleteOne.name}</b>
              </>
            ) : (
              <>
                {' '}
                选中的 <b>{askDelete.length}</b> 项（{askDelete.slice(0, 3).map((e) => e.name).join('、')}
                {askDelete.length > 3 ? '…' : ''}）
              </>
            )}
            ？{askDelete.some((e) => e.kind === 'dir') ? '文件夹会连同里面的内容一起删除，' : ''}此操作不可撤销。
          </span>
          <button className="btn btn-danger btn-sm" disabled={!!busy} onClick={() => void doDelete()}>
            {busy ? '删除中…' : '确认删除'}
          </button>
          <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => setAskDelete([])}>
            取消
          </button>
        </div>
      )}

      {/* 覆盖确认：目标里已有同名项 */}
      {transferAsk && (
        <div className="fm-confirm fm-confirm-warn">
          <span>
            目标 <b>{transferAsk.dest}</b> 已有同名条目：{transferAsk.conflicts.slice(0, 3).join('、')}
            {transferAsk.conflicts.length > 3 ? '…' : ''}。继续会<b>先删除</b>它再{MODE_TEXT[transferAsk.mode]}。
          </span>
          <button
            className="btn btn-primary btn-sm"
            disabled={transferring}
            onClick={() => void runTransfer(transferAsk.mode, transferAsk.paths, transferAsk.dest, true)}
          >
            覆盖
          </button>
          <button className="btn btn-ghost btn-sm" disabled={transferring} onClick={() => setTransferAsk(null)}>
            取消
          </button>
        </div>
      )}

      <div className={`fm-head fm-grid ${selectMode ? 'selecting' : ''}`}>
        {selectMode && (
          <input
            type="checkbox"
            className="fm-check"
            checked={allSelected}
            disabled={entries.length === 0}
            aria-label="全选"
            onChange={() => setSelected(allSelected ? [] : entries.map((e) => e.path))}
          />
        )}
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
          const checked = selected.includes(e.path)
          return (
            <div key={e.path} className={`fm-row fm-grid ${selectMode ? 'selecting' : ''} ${checked ? 'checked' : ''}`}>
              {selectMode && (
                <input
                  type="checkbox"
                  className="fm-check"
                  checked={checked}
                  aria-label={`选择 ${e.name}`}
                  onChange={() => toggleOne(e.path)}
                />
              )}
              <button
                className={`fm-name ${isDir ? 'is-dir' : ''}`}
                title={selectMode ? (checked ? '取消选择' : '选择') : isDir ? `进入 ${e.name}` : e.name}
                onClick={() => (selectMode ? toggleOne(e.path) : enter(e))}
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
                {!selectMode && (
                  <>
                    <button
                      className="icon-btn"
                      title="移动到…"
                      disabled={rowBusy}
                      onClick={() => openPicker('move', [e.path])}
                    >
                      <IconMove width={15} height={15} />
                    </button>
                    <button
                      className="icon-btn"
                      title="复制到…"
                      disabled={rowBusy}
                      onClick={() => openPicker('copy', [e.path])}
                    >
                      <IconCopy width={15} height={15} />
                    </button>
                    <button
                      className="icon-btn fm-danger"
                      title="删除"
                      disabled={rowBusy}
                      onClick={() => setAskDelete([e])}
                    >
                      <IconTrash width={15} height={15} />
                    </button>
                  </>
                )}
              </span>
            </div>
          )
        })}
      </div>

      <div className="fm-foot">
        <span className="hint">
          {entries.length} 项{loading ? ' · 读取中…' : ''}
          {selectMode ? ' · 批量模式' : ''}
        </span>
        {status && <span className="fm-status" title={status}>{status}</span>}
      </div>

      {picker && (
        <DirPicker
          serial={serial}
          mode={picker.mode}
          count={picker.paths.length}
          startAt={path}
          busy={transferring}
          onCancel={() => setPicker(null)}
          onPick={(dest) => void runTransfer(picker.mode, picker.paths, dest, false)}
        />
      )}
    </div>
  )
}

/**
 * 目标目录选择器：只在设备端目录里选，不选文件。
 *
 * 为什么不用输入框：设备路径大小写、前后空格、中文名都很容易打错，
 * 而 adb shell 对不存在的路径只会回一句冷冷的报错。列表点选不会出错。
 */
function DirPicker(p: {
  serial: string
  mode: TransferMode
  /** 待移动/复制的条目数，显示在标题里 */
  count: number
  /** 打开时定位到当前浏览的目录 */
  startAt: string
  busy: boolean
  onCancel: () => void
  onPick: (dest: string) => void
}): JSX.Element {
  const [dir, setDir] = useState(p.startAt)
  const [parent, setParent] = useState<string | null>(null)
  const [dirs, setDirs] = useState<RemoteEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(
    async (d: string): Promise<void> => {
      setLoading(true)
      setErr(null)
      try {
        const r = await window.api.listDir(p.serial, d)
        if (!r.ok) {
          setErr(r.message || '打不开这个目录')
          return
        }
        setDir(r.path)
        setParent(r.parent)
        setDirs(r.entries.filter((e) => e.kind === 'dir'))
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    },
    [p.serial]
  )

  useEffect(() => {
    void load(p.startAt)
  }, [load, p.startAt])

  const crumbs = dir.split('/').filter(Boolean)

  return (
    <>
      <div className="fm-modal-backdrop" onClick={p.onCancel} />
      <div className="fm-modal" role="dialog" aria-label={`选择${MODE_TEXT[p.mode]}目标目录`}>
        <div className="fm-modal-head">
          <span>
            {MODE_TEXT[p.mode]} {p.count} 项到…
          </span>
          <button className="icon-btn" title="关闭" onClick={p.onCancel}>
            <IconClose width={16} height={16} />
          </button>
        </div>

        <div className="fm-modal-path" title={dir}>
          <button className="icon-btn" title="上级目录" disabled={!parent || loading} onClick={() => parent && void load(parent)}>
            <IconChevron width={14} height={14} style={{ transform: 'rotate(180deg)' }} />
          </button>
          <button className="fm-crumb" onClick={() => void load('/')}>
            /
          </button>
          {crumbs.map((c, i) => {
            const to = '/' + crumbs.slice(0, i + 1).join('/')
            const last = i === crumbs.length - 1
            return (
              <span key={to} className="fm-crumb-wrap">
                <span className="fm-crumb-sep">›</span>
                <button className={`fm-crumb ${last ? 'current' : ''}`} disabled={last} onClick={() => void load(to)}>
                  {c}
                </button>
              </span>
            )
          })}
        </div>

        {err && <div className="fm-error">{err}</div>}

        <div className="fm-modal-list">
          {loading && <div className="hint">读取中…</div>}
          {!loading && !err && dirs.length === 0 && <div className="hint">没有子文件夹</div>}
          {dirs.map((d) => (
            <button key={d.path} className="fm-pick-row" title={`进入 ${d.name}`} onClick={() => void load(d.path)}>
              <IconFolder width={15} height={15} />
              <span className="fm-name-text">{d.name}</span>
              <IconChevron width={14} height={14} style={{ transform: 'rotate(-90deg)' }} />
            </button>
          ))}
        </div>

        <div className="fm-modal-foot">
          <span className="hint" title={dir}>
            放到：<b>{dir}</b>
          </span>
          <button className="btn btn-primary btn-sm" disabled={p.busy || !!err} onClick={() => p.onPick(dir)}>
            {p.busy ? '处理中…' : '放到这里'}
          </button>
          <button className="btn btn-ghost btn-sm" disabled={p.busy} onClick={p.onCancel}>
            取消
          </button>
        </div>
      </div>
    </>
  )
}
