import type { DeviceHistoryEntry, DeviceInfo } from '@shared/types'

/**
 * 把 adb 当前在线的设备与历史记录合并成渲染层看到的设备列表。
 *
 * - **排序**：用户拖动过（有 order）的设备按 order 升序在最前；其余（从未拖过的新设备）
 *   保持原有规则接在后面（在线优先 + adb 顺序 + 历史按 lastSeen 降序）。
 *   这样「自定义顺序」优先于「在线优先」——用户拖好的位置不会被插队。
 * - **别名**：alias 跟随历史记录透传给在线与离线条目，UI 显示优先级 alias > model > serial。
 * - 历史里有、当前 `adb devices` 没有的，补成 `state='offline'` + `known=true`，
 *   UI 据此置灰并打「历史」标记，右键可重新连接（tcpip）或删除。
 *
 * 纯函数，不碰 I/O，方便单测；历史记录的新增/更新由 Store.rememberDevices() 负责。
 */
export function mergeDeviceHistory(live: DeviceInfo[], history: DeviceHistoryEntry[]): DeviceInfo[] {
  const liveSerials = new Set(live.map((d) => d.serial))
  const aliasOf = new Map<string, string>()
  const orderOf = new Map<string, number>()
  for (const h of history) {
    if (h.alias && h.alias.trim()) aliasOf.set(h.serial, h.alias)
    if (typeof h.order === 'number') orderOf.set(h.serial, h.order)
  }
  const liveMerged: DeviceInfo[] = live.map((d) => ({ ...d, alias: aliasOf.get(d.serial) ?? null }))
  const known: DeviceInfo[] = history
    .filter((h) => !liveSerials.has(h.serial))
    .map((h) => ({
      serial: h.serial,
      state: 'offline' as const,
      model: h.model,
      device: null,
      product: null,
      transport: h.transport,
      alias: h.alias ?? null,
      known: true
    }))
  const merged = [...liveMerged, ...known]
  const ordered = merged.filter((d) => orderOf.has(d.serial))
  ordered.sort((a, b) => (orderOf.get(a.serial) as number) - (orderOf.get(b.serial) as number))
  const rest = merged.filter((d) => !orderOf.has(d.serial))
  return [...ordered, ...rest]
}
