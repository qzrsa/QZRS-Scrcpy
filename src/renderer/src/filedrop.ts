import { useEffect, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'

/**
 * 拖文件到投屏画面 → 推到设备。
 *
 * 官方 scrcpy 的默认落点是 `/sdcard/`；这里选 `/sdcard/Download`：
 * 手机上「文件」App 的下载页直接能看到，也不会往手机根目录丢一堆东西。
 * 想改成别的目录只改这一个常量（未来有需要再做成设置项）。
 */
export const DROP_TARGET = '/sdcard/Download'

export type DropToastType = 'info' | 'error' | 'success'

export interface StageDrop {
  /** 是否有文件正悬停在投屏区（用来显示"松手传到手机"浮层） */
  dragging: boolean
  /** 正在推送（这期间不接受新的拖放，免得两批交错） */
  busy: boolean
  handlers: {
    onDragEnter: (e: ReactDragEvent) => void
    onDragOver: (e: ReactDragEvent) => void
    onDragLeave: (e: ReactDragEvent) => void
    onDrop: (e: ReactDragEvent) => void
  }
}

/** 只认真正的"拖文件"：设备卡片内部拖动排序走的是自定义 data，不能抢 */
function hasFiles(e: ReactDragEvent | DragEvent): boolean {
  const dt = e.dataTransfer
  return !!dt && Array.from(dt.types).includes('Files')
}

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p
}

/**
 * @param serial 当前投屏设备的 serial（null = 没有活动会话）
 * @param onToast 状态/结果提示，直接接到 App 的 toast
 */
export function useStageFileDrop(o: {
  serial: string | null
  onToast: (msg: string, type?: DropToastType) => void
}): StageDrop {
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  // dragenter/dragleave 会随着鼠标穿过子元素反复触发（成对出现），用计数消抖，
  // 否则浮层会疯狂闪烁。归零才算真的离开。
  const depth = useRef(0)
  const busyRef = useRef(false)
  // 回调存 ref：挂载期只注册一次 DOM 监听，不必因为 onToast 换了引用而重绑
  const cbRef = useRef(o)
  cbRef.current = o

  /**
   * 全局兜底：文件拖到投屏区以外的任何地方（侧栏、工具栏、空白）都必须 preventDefault，
   * 否则 Electron 会把窗口导航到那个文件 —— 界面直接变成一张图/一段文本，只能重启。
   * 只拦带 Files 的拖拽，设备卡片的内部排序拖动不受影响。
   */
  useEffect(() => {
    const stop = (e: DragEvent): void => {
      if (hasFiles(e)) e.preventDefault()
    }
    window.addEventListener('dragover', stop)
    window.addEventListener('drop', stop)
    return () => {
      window.removeEventListener('dragover', stop)
      window.removeEventListener('drop', stop)
    }
  }, [])

  const clear = (): void => {
    depth.current = 0
    setDragging(false)
  }

  const onDragEnter = (e: ReactDragEvent): void => {
    if (!hasFiles(e)) return
    e.preventDefault()
    depth.current += 1
    setDragging(true)
  }

  const onDragOver = (e: ReactDragEvent): void => {
    if (!hasFiles(e)) return
    // 不 preventDefault 就不会触发 drop（HTML5 拖放的硬性要求）
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  const onDragLeave = (e: ReactDragEvent): void => {
    if (!hasFiles(e)) return
    depth.current = Math.max(0, depth.current - 1)
    if (depth.current === 0) setDragging(false)
  }

  const onDrop = (e: ReactDragEvent): void => {
    if (!hasFiles(e)) return
    e.preventDefault()
    clear()

    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return

    const serial = cbRef.current.serial
    if (!serial) {
      cbRef.current.onToast('先连接一台设备并开始投屏，再把文件拖进来', 'error')
      return
    }
    if (busyRef.current) {
      cbRef.current.onToast('上一批还在传，等它传完再拖一次', 'info')
      return
    }

    // File → 本地绝对路径：Electron 32+ 没有了 file.path，只能靠 preload 的 webUtils
    const paths = files
      .map((f) => {
        try {
          return window.api.getPathForFile(f)
        } catch {
          return ''
        }
      })
      .filter((p) => !!p)

    if (paths.length === 0) {
      cbRef.current.onToast('没拿到本地文件路径（从压缩包/网页里直接拖出来的虚拟文件不支持）', 'error')
      return
    }

    busyRef.current = true
    setBusy(true)
    void (async () => {
      let ok = 0
      const failed: string[] = []
      try {
        for (let i = 0; i < paths.length; i++) {
          const name = baseName(paths[i])
          if (paths.length > 1) cbRef.current.onToast(`正在传 ${i + 1}/${paths.length}：${name}`, 'info')
          else cbRef.current.onToast(`正在传 ${name}…`, 'info')
          // eslint-disable-next-line no-await-in-loop
          const r = await window.api.pushFile(serial, paths[i], DROP_TARGET)
          if (r.ok) ok++
          else failed.push(`${name}（${r.message || '失败'}）`)
        }
      } catch (err) {
        failed.push(err instanceof Error ? err.message : String(err))
      } finally {
        busyRef.current = false
        setBusy(false)
      }

      if (failed.length === 0) {
        // APK 只是推到下载目录，不自动装：装应用会弹系统确认框，替用户点不合适
        const apk = paths.some((p) => /\.apk$/i.test(p))
        cbRef.current.onToast(
          `已传到 ${DROP_TARGET}：${ok} 个文件${apk ? '（APK 在手机上点开即可安装）' : ''}`,
          'success'
        )
      } else if (ok === 0) {
        cbRef.current.onToast(`传失败了：${failed.join('、')}`, 'error')
      } else {
        cbRef.current.onToast(`传了 ${ok}/${paths.length}，失败：${failed.join('、')}`, 'error')
      }
    })()
  }

  return {
    dragging,
    busy,
    handlers: { onDragEnter, onDragOver, onDragLeave, onDrop }
  }
}
