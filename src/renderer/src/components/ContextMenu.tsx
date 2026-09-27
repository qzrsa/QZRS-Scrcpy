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
 * 通用右键菜单：固定定位 + 全屏透明遮罩捕获外部点击，Esc 关闭。
 * 渲染后按实际尺寸把坐标夹回视口内（贴右/下边缘时自动左移/上移）。
 */
export function ContextMenu({ state, onClose }: Props): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })

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
    if (!state) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state, onClose])

  if (!state) return null

  // 挂到 body 上：脱离 sidebar / device-list 的层叠与 overflow 上下文，避免被裁切或压在下层
  return createPortal(
    <>
      <div
        className="ctx-backdrop"
        onMouseDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
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
      </div>
    </>,
    document.body
  )
}
