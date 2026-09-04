// 将官方 scrcpy.exe 的 SDL 窗口嵌入到 Electron 主窗口内（Win32 SetParent）。
//
// 原理：scrcpy 是一个独立的 SDL2 顶层窗口，通过 user32.SetParent 把它变成
// Electron 窗口的子窗口，再用 SetWindowLongW 去掉标题栏/边框（WS_CHILD|WS_VISIBLE），
// 最后 SetWindowPos 定位到 MirrorView 占位区。这样 scrcpy 的画面就能"嵌入"在
// ScrcpyControl 的窗口里，跟随主窗口移动/缩放，作为内置 WebCodecs 渲染异常时的回退方案。
//
// 依赖 koffi（N-API FFI，纯 JS 加载 user32.dll，无需 native 编译）。

import { spawn, type ChildProcess } from 'node:child_process'

// ---- Win32 常量 ----
const GWL_STYLE = -16
const WS_CHILD = 0x40000000
const WS_VISIBLE = 0x10000000
const WS_CLIPSIBLINGS = 0x04000000
const SWP_NOZORDER = 0x0004
const SWP_SHOWWINDOW = 0x0040
const SWP_FRAMECHANGED = 0x0020

interface Win32Api {
  FindWindowW: (cls: string | null, title: string | null) => bigint | null
  SetParent: (child: bigint, parent: bigint) => bigint
  SetWindowLongPtrW: (hwnd: bigint, index: number, value: bigint) => bigint
  SetWindowPos: (hwnd: bigint, after: bigint, x: number, y: number, cx: number, cy: number, flags: number) => number
  ShowWindow: (hwnd: bigint, cmd: number) => number
}

let cachedApi: Win32Api | null | undefined

function getWin32(): Win32Api | null {
  if (cachedApi !== undefined) return cachedApi
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi')
    const user32 = koffi.load('user32.dll')
    cachedApi = {
      FindWindowW: user32.func('__stdcall', 'FindWindowW', 'void *', ['str16', 'str16']),
      SetParent: user32.func('__stdcall', 'SetParent', 'void *', ['void *', 'void *']),
      // SetWindowLongPtrW（64 位）：改 GWL_STYLE 用 32 位值即可，这里用 Ptr 兼容 32/64 位
      SetWindowLongPtrW: user32.func('__stdcall', 'SetWindowLongPtrW', 'void *', ['void *', 'int32', 'int64']),
      SetWindowPos: user32.func('__stdcall', 'SetWindowPos', 'int32', ['void *', 'void *', 'int32', 'int32', 'int32', 'int32', 'uint32']),
      ShowWindow: user32.func('__stdcall', 'ShowWindow', 'int32', ['void *', 'int32'])
    }
  } catch {
    cachedApi = null
  }
  return cachedApi
}

export function isEmbedSupported(): boolean {
  return getWin32() !== null
}

interface EmbedHandle {
  proc: ChildProcess
  hwnd: bigint | null
  title: string
}

const embeds = new Map<string, EmbedHandle>()

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 把 Electron 窗口 HWND 从 Buffer 转成 BigInt。 */
export function hwndFromBuffer(buf: Buffer): bigint {
  return buf.readBigUInt64LE(0)
}

export interface EmbedRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * 启动 scrcpy.exe 并嵌入到 parentHwnd 窗口。
 * @returns 进程句柄；通过 moveScrcpy 定位，stopScrcpy 停止。
 */
export async function launchEmbeddedScrcpy(
  serial: string,
  parentHwnd: bigint,
  exePath: string
): Promise<{ ok: boolean; message?: string }> {
  const win32 = getWin32()
  if (!win32) {
    return { ok: false, message: '无法加载 Win32 API（koffi），当前系统不支持嵌入' }
  }

  if (embeds.has(serial)) {
    return { ok: true, message: '已嵌入' }
  }

  const title = `ScrcpyControl - ${serial}`

  try {
    const proc = spawn(
      exePath,
      ['-s', serial, '--window-title', title, '--window-borderless'],
      { windowsHide: false, stdio: 'ignore' }
    )

    const handle: EmbedHandle = { proc, hwnd: null, title }
    embeds.set(serial, handle)

    proc.on('exit', () => {
      embeds.delete(serial)
    })
    proc.on('error', () => {
      embeds.delete(serial)
    })

    // 轮询等 scrcpy 窗口出现（SDL 创建窗口需要时间，连接设备也可能要几百 ms）
    let hwnd: bigint | null = null
    for (let i = 0; i < 100; i++) {
      hwnd = win32.FindWindowW(null, title)
      if (hwnd) break
      await sleep(100)
    }

    if (!hwnd) {
      return { ok: false, message: '启动 scrcpy 超时：未找到其窗口（检查 scrcpy.exe 是否正常启动）' }
    }

    handle.hwnd = hwnd

    // 变成子窗口 + 去掉标题栏边框
    win32.SetParent(hwnd, parentHwnd)
    win32.SetWindowLongPtrW(hwnd, GWL_STYLE, BigInt(WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS))

    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    embeds.delete(serial)
    return { ok: false, message: msg }
  }
}

/** 把已嵌入的 scrcpy 子窗口移动到父窗口客户区的指定位置（物理像素）。 */
export function moveScrcpy(serial: string, rect: EmbedRect): void {
  const handle = embeds.get(serial)
  const win32 = getWin32()
  if (!handle || !handle.hwnd || !win32) return
  win32.SetWindowPos(
    handle.hwnd,
    0n,
    Math.round(rect.x),
    Math.round(rect.y),
    Math.round(rect.w),
    Math.round(rect.h),
    SWP_NOZORDER | SWP_SHOWWINDOW | SWP_FRAMECHANGED
  )
}

/** 停止并关闭已嵌入的 scrcpy。 */
export function stopScrcpy(serial: string): void {
  const handle = embeds.get(serial)
  if (!handle) return
  try {
    handle.proc.kill('SIGKILL')
  } catch {
    /* ignore */
  }
  embeds.delete(serial)
}

/** 关闭所有嵌入的 scrcpy（应用退出时）。 */
export function stopAllScrcpy(): void {
  for (const serial of Array.from(embeds.keys())) {
    stopScrcpy(serial)
  }
}
