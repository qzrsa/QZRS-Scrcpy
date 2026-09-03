import type { ControlCommand, PointerId } from '@shared/types'

/**
 * Control message encoding for the scrcpy 4.x control protocol.
 * Byte layout mirrors sc_control_msg_serialize() in the scrcpy C client.
 * All multi-byte integers are big-endian.
 */

enum MsgType {
  INJECT_KEYCODE = 0,
  INJECT_TEXT = 1,
  INJECT_TOUCH_EVENT = 2,
  INJECT_SCROLL_EVENT = 3,
  BACK_OR_SCREEN_ON = 4,
  EXPAND_NOTIFICATION_PANEL = 5,
  EXPAND_SETTINGS_PANEL = 6,
  COLLAPSE_PANELS = 7,
  GET_CLIPBOARD = 8,
  SET_CLIPBOARD = 9,
  SET_DISPLAY_POWER = 10,
  ROTATE_DEVICE = 11,
  OPEN_HARD_KEYBOARD_SETTINGS = 15,
  START_APP = 16,
  RESET_VIDEO = 17,
  CAMERA_SET_TORCH = 18,
  CAMERA_ZOOM_IN = 19,
  CAMERA_ZOOM_OUT = 20,
  RESIZE_DISPLAY = 21
}

const POINTER_ID_MOUSE = 0xffffffffffffffffn
const POINTER_ID_GENERIC_FINGER = 0xfffffffffffffffcn

function u16(v: number): number[] {
  return [(v >> 8) & 0xff, v & 0xff]
}
function u32(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
}
function u64be(v: bigint): number[] {
  const out: number[] = []
  for (let i = 7; i >= 0; i--) out.push(Number((v >> BigInt(i * 8)) & 0xffn))
  return out
}

function floatToU16fp(f: number): number {
  const u = Math.round(Math.min(1, Math.max(0, f)) * 0x10000)
  return Math.min(0xffff, u)
}

function floatToI16fp(f: number): number {
  const clamped = Math.min(1, Math.max(-1, f))
  const i = Math.round(clamped * 0x8000)
  return Math.max(-0x8000, Math.min(0x7fff, i))
}

function pointerIdToBigInt(id: PointerId): bigint {
  if (id === 'mouse') return POINTER_ID_MOUSE
  if (id === 'finger') return POINTER_ID_GENERIC_FINGER
  return BigInt(Math.trunc(id))
}

function writePosition(bytes: number[], x: number, y: number, w: number, h: number): void {
  bytes.push(...u32(x), ...u32(y), ...u16(w), ...u16(h))
}

function writeString(bytes: number[], text: string, maxLen: number): void {
  const buf = Buffer.from(text, 'utf8').subarray(0, maxLen)
  bytes.push(...u32(buf.length), ...buf)
}

function writeStringTiny(bytes: number[], text: string, maxLen: number): void {
  const buf = Buffer.from(text, 'utf8').subarray(0, maxLen)
  bytes.push(buf.length, ...buf)
}

/** Serialize a control command into a Buffer ready to write to the control socket. */
export function encodeControlCommand(cmd: ControlCommand): Buffer {
  const bytes: number[] = []
  switch (cmd.type) {
    case 'keycode':
      bytes.push(MsgType.INJECT_KEYCODE, cmd.action, ...u32(cmd.keycode), ...u32(cmd.repeat), ...u32(cmd.metastate))
      break
    case 'text':
      bytes.push(MsgType.INJECT_TEXT)
      writeString(bytes, cmd.text, 300)
      break
    case 'touch': {
      bytes.push(MsgType.INJECT_TOUCH_EVENT, cmd.action)
      bytes.push(...u64be(pointerIdToBigInt(cmd.pointerId)))
      writePosition(bytes, cmd.x, cmd.y, cmd.width, cmd.height)
      bytes.push(...u16(floatToU16fp(cmd.pressure)), ...u32(0), ...u32(cmd.buttons))
      break
    }
    case 'scroll':
      bytes.push(MsgType.INJECT_SCROLL_EVENT)
      writePosition(bytes, cmd.x, cmd.y, cmd.width, cmd.height)
      bytes.push(...u16(floatToI16fp(cmd.hScroll / 16) & 0xffff))
      bytes.push(...u16(floatToI16fp(cmd.vScroll / 16) & 0xffff))
      bytes.push(...u32(cmd.buttons))
      break
    case 'backOrScreenOn':
      bytes.push(MsgType.BACK_OR_SCREEN_ON, cmd.action)
      break
    case 'expandNotificationPanel':
      bytes.push(MsgType.EXPAND_NOTIFICATION_PANEL)
      break
    case 'expandSettingsPanel':
      bytes.push(MsgType.EXPAND_SETTINGS_PANEL)
      break
    case 'collapsePanels':
      bytes.push(MsgType.COLLAPSE_PANELS)
      break
    case 'getClipboard':
      bytes.push(MsgType.GET_CLIPBOARD, cmd.copyKey)
      break
    case 'setClipboard':
      bytes.push(MsgType.SET_CLIPBOARD)
      bytes.push(...u64be(0n), cmd.paste ? 1 : 0)
      writeString(bytes, cmd.text, 1 << 18)
      break
    case 'setDisplayPower':
      bytes.push(MsgType.SET_DISPLAY_POWER, cmd.on ? 1 : 0)
      break
    case 'rotateDevice':
      bytes.push(MsgType.ROTATE_DEVICE)
      break
    case 'resetVideo':
      bytes.push(MsgType.RESET_VIDEO)
      break
    case 'startApp':
      bytes.push(MsgType.START_APP)
      writeStringTiny(bytes, cmd.name, 255)
      break
  }
  return Buffer.from(bytes)
}

/** Serialize a clipboard ACK sequence (used only for autosync bookkeeping). */
export function clipboardSequence(): bigint {
  return 0n
}
