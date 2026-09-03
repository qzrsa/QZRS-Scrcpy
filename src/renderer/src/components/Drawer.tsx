import type { ReactNode } from 'react'
import { IconClose } from './icons'

interface Props {
  title: string
  wide?: boolean
  onClose: () => void
  children: ReactNode
}

export function Drawer({ title, wide, onClose, children }: Props): JSX.Element {
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className={`drawer ${wide ? 'wide' : ''}`}>
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
