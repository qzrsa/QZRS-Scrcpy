import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { IconClose } from './icons'

interface Props {
  title: string
  wide?: boolean
  onClose: () => void
  children: ReactNode
  /**
   * 传入一个存储 key（如 'script'）后，抽屉左边缘出现拖拽调宽手柄，
   * 宽度存 localStorage（`drawer-w-${key}`），下次打开保持。
   */
  resizableKey?: string
}

const MIN_W = 380
const MAX_W = 1100

function loadWidth(key: string | undefined): number | null {
  if (!key) return null
  try {
    const v = Number(localStorage.getItem(`drawer-w-${key}`))
    if (Number.isFinite(v) && v >= MIN_W && v <= MAX_W) return Math.round(v)
  } catch {
    /* ignore */
  }
  return null
}

export function Drawer({ title, wide, onClose, children, resizableKey }: Props): JSX.Element {
  const [width, setWidth] = useState<number | null>(() => loadWidth(resizableKey))
  const draggingRef = useRef(false)

  // 拖拽期间挂全局监听（移出抽屉/松开在窗口任意位置都能收尾）
  useEffect(() => {
    if (!resizableKey) return
    const onMove = (e: MouseEvent): void => {
      if (!draggingRef.current) return
      // 抽屉贴右侧：宽度 = 窗口宽 - 鼠标 x
      const w = window.innerWidth - e.clientX
      setWidth(Math.max(MIN_W, Math.min(MAX_W, Math.min(window.innerWidth * 0.92, w))))
    }
    const onUp = (): void => {
      if (!draggingRef.current) return
      draggingRef.current = false
      document.body.classList.remove('drawer-resizing')
      setWidth((w) => {
        if (w !== null) {
          try {
            localStorage.setItem(`drawer-w-${resizableKey}`, String(w))
          } catch {
            /* ignore */
          }
        }
        return w
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [resizableKey])

  const style = width !== null ? { width: `${width}px` } : undefined

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className={`drawer ${wide ? 'wide' : ''} ${resizableKey ? 'resizable' : ''}`} style={style}>
        {resizableKey ? (
          <div
            className="drawer-resize-handle"
            title="拖拽调整宽度"
            onMouseDown={(e) => {
              e.preventDefault()
              draggingRef.current = true
              document.body.classList.add('drawer-resizing')
            }}
            onDoubleClick={() => {
              // 双击恢复默认宽度
              setWidth(null)
              try {
                localStorage.removeItem(`drawer-w-${resizableKey}`)
              } catch {
                /* ignore */
              }
            }}
          />
        ) : null}
        <div className="drawer-header">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <IconClose width={18} height={18} />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </div>
    </>
  )
}
