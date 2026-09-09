import { useEffect, useRef, useState } from 'react'
import type { KeymapBinding, KeymapConfig, KeymapOverlay } from '@shared/types'
import { useApp } from '../store'
import { Drawer } from './Drawer'
import { IconPlus, IconClose, IconUpload, IconDownload, IconFolder } from './icons'

interface Props {
  onClose: () => void
  onOpenVisualEditor?: () => void
  onToast?: (msg: string, type: 'info' | 'error' | 'success') => void
}

const emptyBinding = (key: string): KeymapBinding => ({
  id: `b${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
  key,
  action: 'tap',
  x: 0.5,
  y: 0.5,
  x2: 0.5,
  y2: 0.5,
  duration: 0,
  viewDx: 0,
  viewDy: 0,
  repeatMs: 100,
  keycode: 0,
  label: '',
  groupId: null
})

const emptyOverlay = (): KeymapOverlay => ({
  id: `ov${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
  x: 0.5,
  y: 0.5,
  radius: 0.04,
  label: '○',
  color: 'rgba(255, 255, 255, 0.25)'
})

const actionLabels: Record<KeymapBinding['action'], string> = {
  tap: '点击（按下即松开）',
  hold: '按住（按下持续触摸）',
  repeat: '连击（周期重复）',
  view: '键盘视角（持续滑动）',
  swipe: '滑动（一次）',
  keycode: 'Android 按键'
}

/**
 * Quick-add presets shown in the dropdown menu (one-click add common bindings).
 */
const PRESETS: { label: string; key: string; action: KeymapBinding['action']; x: number; y: number; label2?: string; repeatMs?: number; viewDx?: number; viewDy?: number }[] = [
  // WASD walking pad (lower-left)
  { label: 'W 上走', key: 'KeyW', action: 'hold', x: 0.18, y: 0.78 },
  { label: 'A 左走', key: 'KeyA', action: 'hold', x: 0.08, y: 0.88 },
  { label: 'S 下走', key: 'KeyS', action: 'hold', x: 0.18, y: 0.96 },
  { label: 'D 右走', key: 'KeyD', action: 'hold', x: 0.28, y: 0.88 },
  // Arrow-key view rotation (upper-right area)
  { label: '↑ 视角上', key: 'ArrowUp', action: 'view', x: 0.82, y: 0.2, viewDx: 0, viewDy: -0.01, repeatMs: 50 },
  { label: '↓ 视角下', key: 'ArrowDown', action: 'view', x: 0.82, y: 0.5, viewDx: 0, viewDy: 0.01, repeatMs: 50 },
  { label: '← 视角左', key: 'ArrowLeft', action: 'view', x: 0.7, y: 0.35, viewDx: -0.01, viewDy: 0, repeatMs: 50 },
  { label: '→ 视角右', key: 'ArrowRight', action: 'view', x: 0.94, y: 0.35, viewDx: 0.01, viewDy: 0, repeatMs: 50 },
  // Skill keys (top row)
  { label: 'Q 技能1', key: 'KeyQ', action: 'tap', x: 0.35, y: 0.4 },
  { label: 'E 技能2', key: 'KeyE', action: 'tap', x: 0.5, y: 0.4 },
  { label: 'R 技能3', key: 'KeyR', action: 'tap', x: 0.65, y: 0.4 },
  { label: 'Space 跳跃/开火', key: 'Space', action: 'tap', x: 0.85, y: 0.88 },
  { label: 'F 连击（200ms）', key: 'KeyF', action: 'repeat', x: 0.5, y: 0.6, repeatMs: 200 },
  { label: 'Shift 扳机', key: 'ShiftLeft', action: 'tap', x: 0.6, y: 0.88 }
]

export function KeymapPanel({ onClose, onOpenVisualEditor, onToast }: Props): JSX.Element {
  const { keymaps, updateKeymaps, settings, setActiveKeymapId } = useApp()
  const [configs, setConfigs] = useState<KeymapConfig[]>(keymaps)
  const [activeId, setActiveId] = useState<string | null>(settings.activeKeymapId)
  const [capturingFor, setCapturingFor] = useState<string | null>(null) // "<configId>:<index>" being captured
  const capturingRef = useRef<string | null>(null)
  capturingRef.current = capturingFor

  // capture next keypress for the binding being added
  useEffect(() => {
    if (!capturingFor) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      const ref = capturingRef.current
      if (!ref) return
      const [cid] = ref.split(':')
      const code = e.code
      setConfigs((prev) =>
        prev.map((c) => (c.id === cid ? { ...c, bindings: [...c.bindings, emptyBinding(code)] } : c))
      )
      setCapturingFor(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [capturingFor])

  const save = (): void => {
    void updateKeymaps(configs)
    void setActiveKeymapId(activeId)
    onClose()
  }

  // 导出：先落盘再导出，保证导出的就是面板里看到的这份（含未保存改动）
  const handleExport = async (cid: string): Promise<void> => {
    await updateKeymaps(configs)
    const r = await window.api.exportKeymap(cid)
    if (r.ok) onToast?.(`已导出：${r.path ?? ''}`, 'success')
    else if (r.message !== '已取消') onToast?.(r.message ?? '导出失败', 'error')
  }

  // 导入：先保存当前编辑避免丢失，再从文件合并（id/名称冲突由主进程自动改名）
  const handleImport = async (): Promise<void> => {
    await updateKeymaps(configs)
    const r = await window.api.importKeymap()
    if (!r.ok) {
      if (r.message !== '已取消') onToast?.(r.message ?? '导入失败', 'error')
      return
    }
    const next = r.keymaps ?? []
    setConfigs(next)
    await updateKeymaps(next)
    onToast?.(`已导入 ${r.added ?? 0} 个方案`, 'success')
  }

  const handleOpenKeymapsDir = async (): Promise<void> => {
    const r = await window.api.openKeymapsDir()
    if (!r.ok) onToast?.('打开方案文件夹失败', 'error')
  }

  const addConfig = (): void => {
    const id = `km${Date.now().toString(36)}`
    setConfigs((prev) => [...prev, { id, name: `按键方案 ${prev.length + 1}`, bindings: [], overlays: [] }])
  }

  const updateBinding = (cid: string, idx: number, patch: Partial<KeymapBinding>): void => {
    setConfigs((prev) =>
      prev.map((c) => (c.id === cid ? { ...c, bindings: c.bindings.map((b, i) => (i === idx ? { ...b, ...patch } : b)) } : c))
    )
  }

  const removeBinding = (cid: string, idx: number): void => {
    setConfigs((prev) => prev.map((c) => (c.id === cid ? { ...c, bindings: c.bindings.filter((_, i) => i !== idx) } : c)))
  }

  const removeConfig = (cid: string): void => {
    setConfigs((prev) => prev.filter((c) => c.id !== cid))
    if (activeId === cid) setActiveId(null)
  }

  const WASD_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD']

  const addBindingFromPreset = (cid: string, preset: (typeof PRESETS)[number]): void => {
    setConfigs((prev) => {
      const cfg = prev.find((c) => c.id === cid)
      if (!cfg) return prev

      let groupId: string | null = null
      if (WASD_KEYS.includes(preset.key)) {
        // WASD 四方向必须共享 groupId，否则会被当成四个独立触摸点
        const existing = cfg.bindings.find((b) => WASD_KEYS.includes(b.key) && b.groupId)
        groupId = existing?.groupId ?? `wasd-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`
      }

      const b: KeymapBinding = {
        ...emptyBinding(preset.key),
        action: preset.action,
        x: preset.x,
        y: preset.y,
        viewDx: preset.viewDx ?? 0,
        viewDy: preset.viewDy ?? 0,
        repeatMs: preset.repeatMs ?? 100,
        label: preset.label2 ?? '',
        groupId
      }
      return prev.map((c) => (c.id === cid ? { ...c, bindings: [...c.bindings, b] } : c))
    })
  }

  const addOverlay = (cid: string): void => {
    setConfigs((prev) => prev.map((c) => (c.id === cid ? { ...c, overlays: [...c.overlays, emptyOverlay()] } : c)))
  }
  const updateOverlay = (cid: string, oid: string, patch: Partial<KeymapOverlay>): void => {
    setConfigs((prev) =>
      prev.map((c) =>
        c.id === cid ? { ...c, overlays: c.overlays.map((o) => (o.id === oid ? { ...o, ...patch } : o)) } : c
      )
    )
  }
  const removeOverlay = (cid: string, oid: string): void => {
    setConfigs((prev) => prev.map((c) => (c.id === cid ? { ...c, overlays: c.overlays.filter((o) => o.id !== oid) } : c)))
  }

  return (
    <Drawer title="按键映射" wide onClose={onClose}>
      <div className="keymap-list">
        {configs.map((cfg) => (
          <div className={`keymap-card ${activeId === cfg.id ? 'active' : ''}`} key={cfg.id}>
            <div className="head">
              <input
                className="text-input"
                style={{ maxWidth: 180 }}
                value={cfg.name}
                onChange={(e) => setConfigs((prev) => prev.map((c) => (c.id === cfg.id ? { ...c, name: e.target.value } : c)))}
              />
              <div className="row" style={{ gap: 6 }}>
                <label className="row" style={{ gap: 4, fontSize: 12, color: 'var(--text-faint)' }}>
                  <input
                    type="radio"
                    name="active-keymap"
                    checked={activeId === cfg.id}
                    onChange={() => setActiveId(cfg.id)}
                  />
                  激活
                </label>
                <button
                  className={`btn btn-sm ${capturingFor?.startsWith(`${cfg.id}:`) ? 'btn-danger' : 'btn-primary'}`}
                  onClick={() => {
                    const sig = `${cfg.id}:-1`
                    setCapturingFor(capturingFor === sig ? null : sig)
                  }}
                  title="录制下一个键盘按键为新绑定"
                >
                  {capturingFor?.startsWith(`${cfg.id}:`) ? '按下按键…' : '+ 添加按键'}
                </button>
                <button
                  className="icon-btn"
                  title="导出此方案为 json 文件"
                  onClick={() => void handleExport(cfg.id)}
                >
                  <IconUpload width={16} height={16} />
                </button>
                <button className="icon-btn" title="删除方案" onClick={() => removeConfig(cfg.id)}>
                  <IconClose width={16} height={16} />
                </button>
              </div>
            </div>

            {/* quick-add presets */}
            <div className="row" style={{ gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  className="btn btn-sm btn-ghost"
                  onClick={() => addBindingFromPreset(cfg.id, p)}
                  title={`绑定 ${p.key} 为 ${p.label}`}
                >
                  {p.label}
                </button>
              ))}
            </div>

            {cfg.bindings.length === 0 && cfg.overlays.length === 0 && (
              <div className="hint">暂无按键绑定，点击「添加按键」录制键盘按键，或点击上方快捷预设</div>
            )}

            {cfg.bindings.map((b, i) => (
              <div className="binding-row" key={i}>
                <span className="key-chip">{b.key}</span>
                <select
                  className="select"
                  style={{ width: 110 }}
                  value={b.action}
                  onChange={(e) => updateBinding(cfg.id, i, { action: e.target.value as KeymapBinding['action'] })}
                >
                  {Object.entries(actionLabels).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>

                {b.action === 'keycode' ? (
                  <input
                    className="text-input"
                    style={{ width: 90 }}
                    type="number"
                    value={b.keycode}
                    placeholder="keycode"
                    onChange={(e) => updateBinding(cfg.id, i, { keycode: Number(e.target.value) || 0 })}
                  />
                ) : (
                  <>
                    <span style={{ color: 'var(--text-faint)' }}>位置</span>
                    <input
                      className="text-input"
                      style={{ width: 56 }}
                      type="number"
                      step={0.05}
                      value={b.x}
                      onChange={(e) => updateBinding(cfg.id, i, { x: Number(e.target.value) || 0 })}
                      title="x [0..1]"
                    />
                    <input
                      className="text-input"
                      style={{ width: 56 }}
                      type="number"
                      step={0.05}
                      value={b.y}
                      onChange={(e) => updateBinding(cfg.id, i, { y: Number(e.target.value) || 0 })}
                      title="y [0..1]"
                    />
                    {b.action === 'swipe' && (
                      <>
                        <span style={{ color: 'var(--text-faint)' }}>→</span>
                        <input
                          className="text-input"
                          style={{ width: 56 }}
                          type="number"
                          step={0.05}
                          value={b.x2}
                          onChange={(e) => updateBinding(cfg.id, i, { x2: Number(e.target.value) || 0 })}
                          title="end x [0..1]"
                        />
                        <input
                          className="text-input"
                          style={{ width: 56 }}
                          type="number"
                          step={0.05}
                          value={b.y2}
                          onChange={(e) => updateBinding(cfg.id, i, { y2: Number(e.target.value) || 0 })}
                          title="end y [0..1]"
                        />
                      </>
                    )}
                    {b.action === 'tap' && (
                      <>
                        <span style={{ color: 'var(--text-faint)' }}>长按ms</span>
                        <input
                          className="text-input"
                          style={{ width: 64 }}
                          type="number"
                          step={50}
                          min={0}
                          value={b.duration}
                          onChange={(e) => updateBinding(cfg.id, i, { duration: Number(e.target.value) || 0 })}
                          title="0=瞬时；>0=按住N毫秒"
                        />
                      </>
                    )}
                    {b.action === 'swipe' && (
                      <>
                        <span style={{ color: 'var(--text-faint)' }}>耗时ms</span>
                        <input
                          className="text-input"
                          style={{ width: 64 }}
                          type="number"
                          step={50}
                          min={20}
                          value={b.duration}
                          onChange={(e) => updateBinding(cfg.id, i, { duration: Number(e.target.value) || 200 })}
                        />
                      </>
                    )}
                    {(b.action === 'repeat' || b.action === 'view') && (
                      <>
                        <span style={{ color: 'var(--text-faint)' }}>间隔ms</span>
                        <input
                          className="text-input"
                          style={{ width: 64 }}
                          type="number"
                          step={10}
                          min={16}
                          value={b.repeatMs}
                          onChange={(e) => updateBinding(cfg.id, i, { repeatMs: Number(e.target.value) || 100 })}
                        />
                      </>
                    )}
                    {b.action === 'view' && (
                      <>
                        <span style={{ color: 'var(--text-faint)' }}>方向 dx/dy</span>
                        <input
                          className="text-input"
                          style={{ width: 56 }}
                          type="number"
                          step={0.005}
                          value={b.viewDx}
                          onChange={(e) => updateBinding(cfg.id, i, { viewDx: Number(e.target.value) || 0 })}
                          title="每 tick 水平偏移 [-1..1]"
                        />
                        <input
                          className="text-input"
                          style={{ width: 56 }}
                          type="number"
                          step={0.005}
                          value={b.viewDy}
                          onChange={(e) => updateBinding(cfg.id, i, { viewDy: Number(e.target.value) || 0 })}
                          title="每 tick 垂直偏移 [-1..1]"
                        />
                      </>
                    )}
                  </>
                )}

                <input
                  className="text-input"
                  style={{ width: 80 }}
                  type="text"
                  value={b.label}
                  placeholder="标签"
                  onChange={(e) => updateBinding(cfg.id, i, { label: e.target.value })}
                />

                <button className="icon-btn" title="删除绑定" onClick={() => removeBinding(cfg.id, i)}>
                  <IconClose width={14} height={14} />
                </button>
              </div>
            ))}

            {/* overlays section */}
            {cfg.overlays.length > 0 && (
              <div className="overlay-section">
                <div className="hint" style={{ marginTop: 6 }}>画布 overlay（准星 / 自定义标记）</div>
                {cfg.overlays.map((o) => (
                  <div className="binding-row" key={o.id}>
                    <input
                      className="text-input"
                      style={{ width: 56 }}
                      type="text"
                      value={o.label}
                      onChange={(e) => updateOverlay(cfg.id, o.id, { label: e.target.value })}
                    />
                    <span style={{ color: 'var(--text-faint)' }}>x/y</span>
                    <input
                      className="text-input"
                      style={{ width: 56 }}
                      type="number"
                      step={0.05}
                      value={o.x}
                      onChange={(e) => updateOverlay(cfg.id, o.id, { x: Number(e.target.value) || 0 })}
                    />
                    <input
                      className="text-input"
                      style={{ width: 56 }}
                      type="number"
                      step={0.05}
                      value={o.y}
                      onChange={(e) => updateOverlay(cfg.id, o.id, { y: Number(e.target.value) || 0 })}
                    />
                    <span style={{ color: 'var(--text-faint)' }}>半径</span>
                    <input
                      className="text-input"
                      style={{ width: 64 }}
                      type="number"
                      step={0.01}
                      min={0.01}
                      value={o.radius}
                      onChange={(e) => updateOverlay(cfg.id, o.id, { radius: Number(e.target.value) || 0.04 })}
                    />
                    <input
                      className="text-input"
                      style={{ width: 80 }}
                      type="text"
                      value={o.color}
                      onChange={(e) => updateOverlay(cfg.id, o.id, { color: e.target.value })}
                      title="CSS 颜色，如 rgba(255,255,255,0.25)"
                    />
                    <button className="icon-btn" title="删除 overlay" onClick={() => removeOverlay(cfg.id, o.id)}>
                      <IconClose width={14} height={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <button className="btn btn-sm btn-ghost" style={{ marginTop: 6 }} onClick={() => addOverlay(cfg.id)}>
              + 加 overlay（准星等）
            </button>
          </div>
        ))}
      </div>

      <div className="row" style={{ marginTop: 16, gap: 8, flexWrap: 'wrap' }}>
        <button className="btn btn-ghost" onClick={addConfig}>
          <IconPlus width={16} height={16} /> 新建方案
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => void handleImport()}
          title="从 json 文件导入按键方案"
        >
          <IconDownload width={16} height={16} /> 导入方案
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => void handleOpenKeymapsDir()}
          title="打开方案文件夹，可直接备份或分享里面的 json"
        >
          <IconFolder width={16} height={16} /> 方案文件夹
        </button>
        {onOpenVisualEditor && (
          <button
            className="btn btn-primary"
            onClick={() => {
              save()
              onOpenVisualEditor()
            }}
          >
            可视化编辑
          </button>
        )}
        <button className="btn btn-primary" onClick={save}>
          保存映射
        </button>
      </div>
    </Drawer>
  )
}