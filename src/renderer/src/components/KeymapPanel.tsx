import { useEffect, useRef, useState } from 'react'
import type { KeymapBinding, KeymapConfig } from '@shared/types'
import { useApp } from '../store'
import { Drawer } from './Drawer'
import { IconPlus, IconClose } from './icons'

export function KeymapPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const { keymaps, updateKeymaps } = useApp()
  const [configs, setConfigs] = useState<KeymapConfig[]>(keymaps)
  const [capturingFor, setCapturingFor] = useState<string | null>(null) // config id being captured
  const capturingRef = useRef<string | null>(null)
  capturingRef.current = capturingFor

  // capture next keypress for the binding being added
  useEffect(() => {
    if (!capturingFor) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      const code = e.code
      setConfigs((prev) =>
        prev.map((c) =>
          c.id === capturingRef.current
            ? { ...c, bindings: [...c.bindings, { key: code, action: 'tap', x: 0.5, y: 0.5, x2: 0.5, y2: 0.5, duration: 0, keycode: 0 }] }
            : c
        )
      )
      setCapturingFor(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [capturingFor])

  const save = (): void => {
    void updateKeymaps(configs)
    onClose()
  }

  const addConfig = (): void => {
    const id = `km${Date.now().toString(36)}`
    setConfigs((prev) => [...prev, { id, name: `按键方案 ${prev.length + 1}`, bindings: [] }])
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
  }

  return (
    <Drawer title="按键映射" wide onClose={onClose}>
      <p className="hint" style={{ margin: '0 0 12px' }}>
        把键盘按键映射为屏幕点击 / 滑动 / Android 按键，坐标使用 0~1 归一化值（相对视频画面）。
      </p>

      <div className="keymap-list">
        {configs.map((cfg) => (
          <div className="keymap-card" key={cfg.id}>
            <div className="head">
              <input
                className="text-input"
                style={{ maxWidth: 180 }}
                value={cfg.name}
                onChange={(e) => setConfigs((prev) => prev.map((c) => (c.id === cfg.id ? { ...c, name: e.target.value } : c)))}
              />
              <div className="row">
                <button
                  className={`btn btn-sm ${capturingFor === cfg.id ? 'btn-danger' : 'btn-primary'}`}
                  onClick={() => setCapturingFor(capturingFor === cfg.id ? null : cfg.id)}
                >
                  {capturingFor === cfg.id ? '按下按键…' : '+ 添加按键'}
                </button>
                <button className="icon-btn" title="删除方案" onClick={() => removeConfig(cfg.id)}>
                  <IconClose width={16} height={16} />
                </button>
              </div>
            </div>

            {cfg.bindings.length === 0 && <div className="hint">暂无按键绑定，点击「添加按键」后按下键盘按键即可录制</div>}

            {cfg.bindings.map((b, i) => (
              <div className="binding-row" key={i}>
                <span className="key-chip">{b.key}</span>
                <select
                  className="select"
                  style={{ width: 90 }}
                  value={b.action}
                  onChange={(e) => updateBinding(cfg.id, i, { action: e.target.value as KeymapBinding['action'] })}
                >
                  <option value="tap">点击</option>
                  <option value="swipe">滑动</option>
                  <option value="keycode">按键</option>
                </select>

                {b.action === 'keycode' ? (
                  <input
                    className="text-input"
                    style={{ width: 80 }}
                    type="number"
                    value={b.keycode}
                    placeholder="keycode"
                    onChange={(e) => updateBinding(cfg.id, i, { keycode: Number(e.target.value) || 0 })}
                  />
                ) : (
                  <>
                    <span style={{ color: 'var(--text-faint)' }}>起</span>
                    <input className="text-input" style={{ width: 56 }} type="number" step={0.05} value={b.x} onChange={(e) => updateBinding(cfg.id, i, { x: Number(e.target.value) || 0 })} />
                    <input className="text-input" style={{ width: 56 }} type="number" step={0.05} value={b.y} onChange={(e) => updateBinding(cfg.id, i, { y: Number(e.target.value) || 0 })} />
                    {b.action === 'swipe' && (
                      <>
                        <span style={{ color: 'var(--text-faint)' }}>终</span>
                        <input className="text-input" style={{ width: 56 }} type="number" step={0.05} value={b.x2} onChange={(e) => updateBinding(cfg.id, i, { x2: Number(e.target.value) || 0 })} />
                        <input className="text-input" style={{ width: 56 }} type="number" step={0.05} value={b.y2} onChange={(e) => updateBinding(cfg.id, i, { y2: Number(e.target.value) || 0 })} />
                      </>
                    )}
                  </>
                )}

                <button className="icon-btn" title="删除绑定" onClick={() => removeBinding(cfg.id, i)}>
                  <IconClose width={14} height={14} />
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="row" style={{ marginTop: 16, gap: 8 }}>
        <button className="btn btn-ghost" onClick={addConfig}>
          <IconPlus width={16} height={16} /> 新建方案
        </button>
        <button className="btn btn-primary" onClick={save}>
          保存映射
        </button>
      </div>
    </Drawer>
  )
}
