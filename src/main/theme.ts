import { nativeTheme } from 'electron'
import type { AppSettings } from '@shared/types'

/**
 * 解析出实际生效的主题：'system' 时跟随操作系统（nativeTheme.shouldUseDarkColors）。
 */
export function effectiveTheme(theme: AppSettings['theme']): 'dark' | 'light' {
  if (theme === 'dark' || theme === 'light') return theme
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

/**
 * BrowserWindow 的 backgroundColor（窗口创建/加载瞬间的底色）。
 * 必须跟随主题：写死深色 '#0f1115' 时，浅色模式下启动会先闪一下深色。
 * 值与 styles.css 的 --bg 对应（深 #0f1115 / 浅 #f4f6fa）。
 */
export function themeBackground(theme: AppSettings['theme']): string {
  return effectiveTheme(theme) === 'dark' ? '#0f1115' : '#f4f6fa'
}
