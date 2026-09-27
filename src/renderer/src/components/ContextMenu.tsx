import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface MenuItem {
  key: string
  label: string
  /** 危险操作（删除类），红色高亮 */
  danger?: boolean
  disabled?: boolean
  /** 禁用原因 / 补充说明，作为原生 title 提示 */
  hint?: string
  onClick: () => void
}

export interface MenuState {
  /** 鼠标视口坐标（clientX / clientY） */
  x: number
  y: number
  /** 顶部标题（一般是设备名） */
  title?: string
  items: MenuItem[]
}

interface Props {
  state: MenuState | null
  onClose: () => void
}

/**
 * 通用右键菜单：固定定位，portal 到 body（否则会被 `.device-list` 的 overflow 裁切）。
 * 渲染后按实际尺寸把坐标夹回视口内（贴右/下边缘时自动左移/上移）。
 *
 * 关闭方式**不用全屏遮罩**，而是 document 的**捕获阶段**监听 mousedown / contextmenu：
 * 全屏遮罩会吞掉「右键另一台设备」这次事件，用户得点两次；捕获阶段则保证
 * 旧菜单先关、卡片自己的 onContextMenu（React 挂在容器上、走冒泡）随后打开新菜单。
 */
export function ContextMenu({ state, onClose }: Props): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const open = state !== null

  useLayoutEffect(() => {
    if (!state) return
    const el = ref.current
    const w = el?.offsetWidth ?? 180
    const h = el?.offsetHeight ?? 140
    setPos({
      x: Math.max(6, Math.min(state.x, window.innerWidth - w - 6)),
      y: Math.max(6, Math.min(state.y, window.innerHeight - h - 6))
    })
  }, [state])

  useEffect(() => {
    if (!open) return
    const onOutside = (e: Event): void => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onOutside, true)
    document.addEventListener('contextmenu', onOutside, true)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onOutside, true)
      document.removeEventListener('contextmenu', onOutside, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  if (!state) return null

  return createPortal(
    <div className="ctx-menu" ref={ref} style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {state.title && (
        <div className="ctx-title" title={state.title}>
          {state.title}
        </div>
      )}
      {state.items.map((it) => (
        <button
          key={it.key}
          className={`ctx-item ${it.danger ? 'danger' : ''}`}
          disabled={it.disabled}
          title={it.hint || it.label}
          onClick={() => {
            onClose()
            it.onClick()
          }}
        >
          {it.label}
        </button>
      ))}
    </div>,
    document.body
  )
}
