// Smoke test: verify the scrcpy 4.1 protocol end-to-end against a real device.
// Mirrors ScrcpySession.start() logic: push -> forward -> app_process -> connect.
//
// tunnel_forward=true: ONE `adb forward` is enough, but the client must open
// MULTIPLE TCP connections to the SAME local port — one per enabled stream
// (video first, then control). Each TCP connection becomes a fresh abstract
// socket connection on the device; the server accepts them in order.
import { spawn } from 'node:child_process'
import net from 'node:net'

const ADB = 'C:/platform-tools/adb.exe'
const SERVER = 'D:/WorkBuddy/QZRS Scrcpy/ScrcpyControl/resources/scrcpy-server'
const SERIAL = '192.168.11.111:5555'
// 31-bit scid (must be < 0x80000000: Java Options.java parses signed 32-bit)
const SCID = (Math.floor(Math.random() * 0xffffffff) >>> 0) & 0x7fffffff
const scidHex = SCID.toString(16).padStart(8, '0')
const SOCKET = 'scrcpy_' + scidHex

function run(args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const child = spawn(ADB, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const t = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (err += d.toString()))
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }) })
  })
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address()
      const port = a && typeof a === 'object' ? a.port : 0
      srv.close(() => resolve(port))
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  console.log('scid =', scidHex, 'socket =', SOCKET)

  // 1. push server
  let r = await run(['-s', SERIAL, 'push', SERVER, '/data/local/tmp/scrcpy-server.jar'], 120000)
  console.log('[push] exit', r.code, (r.out || r.err).trim().split('\n').pop())

  // 2. forward ONE port (tunnel_forward mode)
  const port = await freePort()
  r = await run(['-s', SERIAL, 'forward', `tcp:${port}`, `localabstract:${SOCKET}`])
  console.log('[forward] exit', r.code, 'port', port, (r.out || r.err).trim())

  // 3. launch server (cleanup=false so the jar is NOT self-deleted during the test)
  const args = [
    '-s', SERIAL, 'shell',
    'CLASSPATH=/data/local/tmp/scrcpy-server.jar',
    'app_process', '/', 'com.genymobile.scrcpy.Server',
    '4.1', `scid=${scidHex}`, 'log_level=info', 'video_codec=h264', 'audio=false',
    'send_dummy_byte=true', 'tunnel_forward=true', 'cleanup=false'
  ]
  const proc = spawn(ADB, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  proc.stdout.on('data', (d) => process.stdout.write('[server] ' + d.toString().trim() + '\n'))
  proc.stderr.on('data', (d) => process.stdout.write('[server] ' + d.toString().trim() + '\n'))

  await sleep(1500)

  // 4. connect video socket (server accept #1 -> gets dummy byte + device meta)
  const video = net.connect(port, '127.0.0.1')
  video.on('error', (e) => console.error('video error:', e.message))

  // 5. connect control socket (server accept #2 -> control channel, no dummy byte)
  const control = net.connect(port, '127.0.0.1')
  control.on('error', (e) => console.error('control error:', e.message))

  // 6. parse video stream
  let buf = Buffer.alloc(0)
  let deviceName = null
  let codec = null
  let meta = null
  let firstFrame = null

  const cleanup = async (ok) => {
    try { video.destroy() } catch {}
    try { control.destroy() } catch {}
    try { proc.kill('SIGKILL') } catch {}
    await run(['-s', SERIAL, 'shell', 'pkill -f scrcpy']).catch(() => {})
    await run(['-s', SERIAL, 'forward', '--remove', `tcp:${port}`]).catch(() => {})
    process.exit(ok ? 0 : 1)
  }

  const parse = () => {
    if (deviceName === null && buf.length >= 65) {
      // byte 0 = dummy byte, bytes 1..64 = device name
      deviceName = buf.subarray(1, 65).toString('utf8').replace(/\0+$/, '')
      buf = buf.subarray(65)
    }
    if (codec === null && buf.length >= 4) {
      codec = buf.readUInt32BE(0).toString(16)
      buf = buf.subarray(4)
    }
    if (meta === null && buf.length >= 12) {
      const flags = buf.readUInt32BE(0)
      const width = buf.readUInt32BE(4)
      const height = buf.readUInt32BE(8)
      meta = { sessionHeader: !!(flags & 0x80000000), width, height }
      buf = buf.subarray(12)
    }
    if (firstFrame === null && buf.length >= 12) {
      const flags = buf.readUInt32BE(0)
      if (!(flags & 0x80000000)) {
        const size = buf.readUInt32BE(8)
        if (buf.length >= 12 + size) {
          const isConfig = !!(flags & 0x40000000)
          const isKey = !!(flags & 0x20000000)
          firstFrame = { size, isConfig, isKey }
          buf = buf.subarray(12 + size)
        }
      } else {
        // another session header (e.g. rotation); skip 12 bytes and re-parse
        buf = buf.subarray(12)
        parse()
      }
    }
    if (deviceName && codec && meta && firstFrame) {
      console.log('\n=== SMOKE TEST RESULT ===')
      console.log('deviceName  :', deviceName)
      console.log('codecId     : 0x' + codec)
      console.log('resolution  :', meta.width + 'x' + meta.height)
      console.log('first frame :', firstFrame.size, 'bytes, keyframe=' + firstFrame.isKey + ', config=' + firstFrame.isConfig)
      console.log('=== PROTOCOL OK ===')
      cleanup(true)
    }
  }

  video.on('data', (d) => { buf = Buffer.concat([buf, d]); parse() })

  setTimeout(() => {
    console.error('TIMEOUT: no full header in 10s. Got:', deviceName, codec, meta, firstFrame)
    cleanup(false)
  }, 10000)
}

main().catch((e) => { console.error('fatal:', e); process.exit(1) })
