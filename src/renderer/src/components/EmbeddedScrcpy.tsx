import { useEffect, useRef } from 'react'

interface Props {
  serial: string
  onError: (message: string) => void
}

/**
 * 把官方 scrcpy.exe 的窗口嵌入到当前区域（Win32 SetParent）。
 *
 * 这里只是一个透明的占位 div：真正的画面是 scrcpy 的原生子窗口，由主进程
 * 通过 SetParent 挂到 Electron 主窗口上，并 SetWindowPos 定位到本 div 的位置。
 * 本组件负责：启动嵌入、用 ResizeObserver 把 div 的屏幕物理坐标同步给主进程、
 * 卸载时停止 scrcpy。
 */
export function EmbeddedScrcpy({ serial, onError }: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  // 定位占位区到屏幕物理坐标，并同步给主进程
  const report = (): void => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    window.api.moveEmbeddedScrcpy(serial, {
      x: r.left * dpr,
      y: r.top * dpr,
      w: r.width * dpr,
      h: r.height * dpr
    })
  }

  // 启动 / 停止嵌入
  useEffect(() => {
    let alive = true
    void (async () => {
      const r = await window.api.launchEmbeddedScrcpy(serial)
      if (!alive) return
      if (!r.ok) {
        onError(r.message || '嵌入 scrcpy 失败')
        return
      }
      // 启动完成后立即按当前占位位置定位一次
      report()
    })()
    return () => {
      alive = false
      // 使用 send 而非 invoke，避免等待响应阻塞卸载
      void window.api.stopEmbeddedScrcpy(serial).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serial])

  // 占位区位置/尺寸同步（物理像素）
  useEffect(() => {
    const el = ref.current
    if (!el) return
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    window.addEventListener('resize', report)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', report)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serial])

  return <div ref={ref} className="embed-host" />
}
