import type { DeviceHistoryEntry, DeviceInfo } from '@shared/types'

/**
 * 把 adb 当前在线的设备与历史记录合并成渲染层看到的设备列表。
 *
 * - 在线设备优先（按 serial 去重，adb 的原始顺序保留）；
 * - 历史里有、当前 `adb devices` 没有的，补成 `state='offline'` + `known=true`，
 *   UI 据此置灰并打「历史」标记，右键可重新连接（tcpip）或删除。
 *
 * 纯函数，不碰 I/O，方便单测；历史记录的新增/更新由 Store.rememberDevices() 负责。
 */
export function mergeDeviceHistory(live: DeviceInfo[], history: DeviceHistoryEntry[]): DeviceInfo[] {
  const liveSerials = new Set(live.map((d) => d.serial))
  const known: DeviceInfo[] = history
    .filter((h) => !liveSerials.has(h.serial))
    .map((h) => ({
      serial: h.serial,
      state: 'offline' as const,
      model: h.model,
      device: null,
      product: null,
      transport: h.transport,
      known: true
    }))
  return [...live, ...known]
}
