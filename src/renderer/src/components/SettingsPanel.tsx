import { useEffect, useMemo, useState } from 'react'
import type { AppSettings, VideoCodec, DecoderAcceleration } from '@shared/types'
import {
  MAX_EXTRA_ADDRESSES,
  countRanges,
  estimateScanMs,
  formatDuration,
  parseSubnets
} from '@shared/subnet'
import { useApp } from '../store'
import { Drawer } from './Drawer'

export function SettingsPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const { settings, updateSettings } = useApp()
  const [draft, setDraft] = useState<AppSettings>(settings)
  const [resolved, setResolved] = useState<{ adbPath: string; serverPath: string; scrcpyPath: string } | null>(null)
  const [hevc, setHevc] = useState<'checking' | 'yes' | 'no'>('checking')
  const [logDir, setLogDir] = useState<string>('')
  // 额外扫描网段用 textarea 编辑，所以单独存一份原始文本（draft 里那份是字符串数组）
  const [extraText, setExtraText] = useState<string>(() => (settings.extraScanSubnets ?? []).join('\n'))
  // Python 桥运行时状态（Token 只在桥运行中才有值）
  const [bridgeStatus, setBridgeStatus] = useState<{ enabled: boolean; running: boolean; port: number; token: string; clientDir: string } | null>(null)
  // OCR 模型状态 + 下载进度
  const [ocr, setOcr] = useState<Awaited<ReturnType<typeof window.api.getOcrStatus>> | null>(null)
  const [ocrProgress, setOcrProgress] = useState<{ phase: 'downloading' | 'verifying' | 'done' | 'error'; percent: number; file?: string; filePercent?: number; message?: string } | null>(null)

  const extra = useMemo(() => parseSubnets(extraText), [extraText])
  const extraInvalid = extra.errors.length > 0 || extra.overLimit

  useEffect(() => {
    void window.api.resolvePaths().then(setResolved)
    void window.api.getDebugLogDir().then(setLogDir).catch(() => undefined)
    void window.api.getBridgeStatus().then(setBridgeStatus).catch(() => undefined)
    void window.api.getOcrStatus().then(setOcr).catch(() => undefined)
    const off = window.api.onOcrProgress((p) => {
      setOcrProgress(p)
      if (p.phase === 'done' || p.phase === 'error') {
        void window.api.getOcrStatus().then(setOcr).catch(() => undefined)
      }
    })
    return off
  }, [])

  // 检测内核是否支持 HEVC(H.265) 硬解（依赖主进程开启的 PlatformHEVCDecoderSupport）。
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const r = await VideoDecoder.isConfigSupported({
          codec: 'hvc1.1.6.L120.B0',
          codedWidth: 1920,
          codedHeight: 1080,
          hardwareAcceleration: 'prefer-hardware'
        })
        if (alive) setHevc(r.supported ? 'yes' : 'no')
      } catch {
        if (alive) setHevc('no')
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const patch = (p: Partial<AppSettings>): void => setDraft((d) => ({ ...d, ...p }))
  const patchSession = (p: Partial<AppSettings['session']>): void =>
    setDraft((d) => ({ ...d, session: { ...d.session, ...p } }))

  const save = (): void => {
    // 额外网段存归一化后的形态（192.168.50 → 192.168.50.0/24），下次打开能直接看出它到底扫哪儿；
    // 非法/超限时保存按钮是禁用的，这里再兜一层，避免走到"存进去但解析不了"的状态。
    if (extraInvalid) return
    void updateSettings({ ...draft, extraScanSubnets: extra.display })
    onClose()
  }

  return (
    <Drawer title="设置" wide onClose={onClose}>
      <div className="field">
        <label>ADB 路径</label>
        <input
          className="text-input"
          value={draft.adbPath}
          placeholder="留空自动检测（Android SDK / platform-tools）"
          onChange={(e) => patch({ adbPath: e.target.value })}
        />
        <div className="hint">已检测：{resolved?.adbPath || '未找到'}</div>
      </div>

      <div className="field">
        <label>scrcpy-server 路径</label>
        <input
          className="text-input"
          value={draft.serverPath}
          placeholder="留空使用内置 resources/scrcpy-server"
          onChange={(e) => patch({ serverPath: e.target.value })}
        />
        <div className="hint">已检测：{resolved?.serverPath || '未找到'}</div>
      </div>

      <div className="field">
        <label>scrcpy.exe 路径（备用渲染）</label>
        <input
          className="text-input"
          value={draft.scrcpyPath}
          placeholder="留空自动在 PATH / Program Files / platform-tools 中查找"
          onChange={(e) => patch({ scrcpyPath: e.target.value })}
        />
        <div className="hint">已检测：{resolved?.scrcpyPath || '未找到'}（仅在 WebCodecs 渲染异常时使用）</div>
      </div>

      {/*
        额外扫描网段：给"设备挂在别的 VLAN / 另一台路由器下"的场景兜底。
        那种情况本机网卡上根本没有目标网段，os.networkInterfaces() 永远枚举不到，只能手填。
        只在深度扫描时生效——快扫保持"秒回"是它的核心价值，不该被手填内容拖慢。
      */}
      <div className="field">
        <label>额外扫描网段（仅「深度扫描」时生效）</label>
        <textarea
          className="textarea"
          rows={3}
          spellCheck={false}
          value={extraText}
          placeholder={'一行一个，例如：\n192.168.50\n10.0.0.0/22\n192.168.9.7'}
          onChange={(e) => setExtraText(e.target.value)}
        />
        <div className="hint">
          支持 <code>192.168.50</code>（整个 /24）、<code>192.168.50.0/24</code>、
          <code>10.0.0.0/22</code>，或 <code>192.168.9.7</code> 单台设备；
          也可以写 <code>192.168.50.0/255.255.255.0</code> 这种点分掩码。多行、逗号、空格分隔都认。
          <br />
          用途：设备挂在其它 VLAN / 另一台路由器下时，本机网卡上没有这个网段，
          自动扫描永远看不到它。留空即关闭。
        </div>

        {extra.errors.length > 0 && (
          <div className="hint" style={{ color: 'var(--red, #e74c3c)', marginTop: -4 }}>
            {extra.errors.map((e) => (
              <div key={e.raw}>✗ {e.message}</div>
            ))}
          </div>
        )}

        {extra.overLimit && (
          <div className="hint" style={{ color: 'var(--red, #e74c3c)', marginTop: -4 }}>
            ✗ 合计 {extra.totalAddresses} 个地址，超过上限 {MAX_EXTRA_ADDRESSES} 个（约 /20）。
            端口扫描没有更快的办法，再大就要跑很久了，请拆小一点。
          </div>
        )}

        {/*
          只要解析出了合法条目就显示预览——**即使同时存在错误**。
          混排（既有能用的段又有打错的段）时，用户需要看到"剩下这些我认对了"，
          全隐掉反而让人怀疑是不是整段都没被识别。保存按钮此时是禁用的。
        */}
        {extra.entries.length > 0 && (
          <div className="hint" style={{ marginTop: -4 }}>
            将额外扫描：{extra.display.join('、')}
            <br />
            共 {countRanges(extra.ranges)} 个地址
            {extra.ranges.length < extra.entries.length && '（有重叠，已合并）'}
            ，预计最坏多花约 {formatDuration(estimateScanMs(countRanges(extra.ranges)))}。
          </div>
        )}
      </div>

      <div className="field">
        <label>主题</label>
        <select className="select" value={draft.theme} onChange={(e) => patch({ theme: e.target.value as AppSettings['theme'] })}>
          <option value="dark">深色</option>
          <option value="light">浅色</option>
          <option value="system">跟随系统</option>
        </select>
      </div>

      <div className="field">
        <label>视频编码</label>
        <select className="select" value={draft.session.codec} onChange={(e) => patchSession({ codec: e.target.value as VideoCodec })}>
          <option value="h264">H.264（内置渲染，推荐）</option>
          <option value="h265">H.265 / HEVC（需官方 scrcpy 窗口）</option>
          <option value="av1">AV1（暂不支持）</option>
        </select>
        <div className="hint">
          {draft.session.codec === 'h264'
            ? '内置 WebCodecs 渲染仅支持 H.264'
            : '内置渲染不支持该编码（Electron 内核无 HEVC 解码器）。请改用设备卡片的 ⚙️ 独立窗口'}
        </div>
        <div className="hint" style={{ fontWeight: 600 }}>
          HEVC 硬解内核检测：{' '}
          <span style={{ color: hevc === 'yes' ? '#2ecc71' : hevc === 'no' ? '#e74c3c' : 'inherit' }}>
            {hevc === 'checking' ? '检测中…' : hevc === 'yes' ? '✅ 支持（内核已启用）' : '❌ 不支持（驱动/硬件受限）'}
          </span>
        </div>
      </div>

      <div className="field">
        <label>编码器名称（可选）</label>
        <input
          className="text-input"
          value={draft.session.videoEncoder}
          placeholder="留空自动选择（如 c2.android.avc.encoder）"
          onChange={(e) => patchSession({ videoEncoder: e.target.value })}
        />
        <div className="hint">指定设备端 MediaCodec 编码器，留空由 scrcpy 自动选择。常用：c2.android.avc.encoder（软件）、c2.qti.avc.encoder（高通硬编）</div>
      </div>

      <div className="field">
        <label>解码器（硬件加速）</label>
        <select
          className="select"
          value={draft.decoderAcceleration}
          onChange={(e) => patch({ decoderAcceleration: e.target.value as DecoderAcceleration })}
        >
          <option value="auto">自动（推荐）</option>
          <option value="hardware">优先硬件</option>
          <option value="software">强制软件（绿屏时选这个）</option>
        </select>
        <div className="hint">PC 端解码策略。遇到绿屏/花屏（AMD 等驱动不稳）时选"强制软件"</div>
      </div>

      <div className="field">
        <label>码率（Mbps）</label>
        <input
          className="text-input"
          type="number"
          min={0}
          step={1}
          value={Math.round(draft.session.bitRate / 1000000)}
          onChange={(e) => patchSession({ bitRate: Math.max(0, Number(e.target.value) || 0) * 1000000 })}
        />
        <div className="hint">0 表示使用默认（约 8 Mbps）</div>
      </div>

      <div className="field">
        <label>最大分辨率（长边）</label>
        <input
          className="text-input"
          type="number"
          min={0}
          step={1}
          value={draft.session.maxSize}
          onChange={(e) => patchSession({ maxSize: Math.max(0, Number(e.target.value) || 0) })}
        />
        <div className="hint">0 表示设备原生分辨率，如 1920 / 2560</div>
      </div>

      <div className="field">
        <label>最大帧率（FPS）</label>
        <input
          className="text-input"
          type="number"
          min={0}
          step={1}
          value={draft.session.maxFps}
          onChange={(e) => patchSession({ maxFps: Math.max(0, Number(e.target.value) || 0) })}
        />
        <div className="hint">0 表示不限制</div>
      </div>

      <div className="field row between">
        <label style={{ margin: 0 }}>保持设备屏幕常亮</label>
        <Toggle checked={draft.session.stayAwake} onChange={(v) => patchSession({ stayAwake: v })} />
      </div>

      <div className="field row between">
        <label style={{ margin: 0 }}>显示触摸点</label>
        <Toggle checked={draft.session.showTouches} onChange={(v) => patchSession({ showTouches: v })} />
      </div>

      <div className="field row between">
        <label style={{ margin: 0 }}>关闭时熄灭设备屏幕</label>
        <Toggle checked={draft.session.powerOffOnClose} onChange={(v) => patchSession({ powerOffOnClose: v })} />
      </div>

      <div className="field row between">
        <label style={{ margin: 0 }}>剪贴板自动同步</label>
        <Toggle checked={draft.session.clipboardAutosync} onChange={(v) => patchSession({ clipboardAutosync: v })} />
      </div>

      <div className="field row between">
        <label style={{ margin: 0 }}>允许控制（关闭为只读镜像）</label>
        <Toggle checked={draft.session.control} onChange={(v) => patchSession({ control: v })} />
      </div>

      <div className="field row between">
        <label style={{ margin: 0 }}>转发设备音频到电脑</label>
        <Toggle checked={draft.session.audio} onChange={(v) => patchSession({ audio: v })} />
      </div>
      {draft.session.audio && (
        <>
          <div className="field">
            <label>音频来源</label>
            <select
              className="select"
              value={draft.session.audioSource}
              onChange={(e) => patchSession({ audioSource: e.target.value as AppSettings['session']['audioSource'] })}
            >
              <option value="output">系统输出（同时静音设备外放，推荐）</option>
              <option value="mic">麦克风（不影响设备外放）</option>
            </select>
          </div>
          <div className="hint" style={{ marginTop: -6, marginBottom: 14 }}>
            选「系统输出」时<b>设备自身会静音</b>（scrcpy 语义，避免双方同时出声），声音改从电脑扬声器播出；
            不想让手机静音就改选「麦克风」或关掉本开关。
            <br />
            需要 <b>Android 11 及以上</b>，低版本会自动退回无声，投屏不受影响。
            <br />
            本项<b>默认开启</b>（与官方 scrcpy 一致）。
          </div>
        </>
      )}

      <div className="field row between">
        <label style={{ margin: 0 }}>画面随窗口自适应缩放</label>
        <Toggle checked={draft.mirrorAutoFit !== false} onChange={(v) => patch({ mirrorAutoFit: v })} />
      </div>
      <div className="hint" style={{ marginTop: -6, marginBottom: 14 }}>
        按「等比缩放 + 完整可见」让画面随窗口大小变化，窗口模式和全屏都生效，画面<b>不会被拉长或拉宽</b>
        （竖屏设备全屏时两侧留黑边，不再横向拉伸变形）。
        <br />
        关闭后回到原来的行为：窗口模式按解码分辨率显示（窗口拖大画面不动），全屏铺满整个窗口。
      </div>

      <div className="field">
        <label>全屏模式</label>
        <select
          className="select"
          value={draft.fullscreenMode}
          onChange={(e) => patch({ fullscreenMode: e.target.value as AppSettings['fullscreenMode'] })}
        >
          <option value="overlay">覆盖层（仅隐藏侧边栏和工具栏）</option>
          <option value="window">系统级全屏（F12 进入独占全屏）</option>
        </select>
        <div className="hint">覆盖层：适合投屏小窗；系统级全屏：按 F12 让窗口独占整个显示器（含任务栏消失）</div>
      </div>

      {/*
        Python 外挂桥：给会写 Python 的用户的外挂能力。
        只监听 127.0.0.1 + Bearer Token，操作复用与手动控制/JS 脚本同一条 scrcpy 链路，
        不装任何东西到手机（对比 uiautomator2：无需 init 两 APK + atx-agent，游戏 SurfaceView 也能控制）。
      */}
      <div className="field row between">
        <label style={{ margin: 0 }}>Python 脚本桥（外部 Python 控制手机）</label>
        <Toggle checked={draft.bridgeEnabled === true} onChange={(v) => patch({ bridgeEnabled: v })} />
      </div>
      {draft.bridgeEnabled === true && (
        <>
          <div className="field">
            <label>桥端口</label>
            <input
              className="text-input"
              type="number"
              min={1024}
              max={65535}
              value={draft.bridgePort}
              onChange={(e) => patch({ bridgePort: Math.min(65535, Math.max(1024, Math.trunc(Number(e.target.value)) || 17399)) })}
            />
          </div>
          <div className="hint" style={{ marginTop: -6, marginBottom: 14 }}>
            允许<b>本机</b> Python 脚本通过 HTTP 接口控制当前投屏会话：点按 / 滑动 / 按键 / 文本 / 截屏，
            与内置 JS 脚本引擎共用同一条 scrcpy 控制链路，不往手机装任何东西。
            仅监听 127.0.0.1，需 Bearer Token 鉴权；保存设置后生效。
            <br />
            Token（桥运行时显示，Python 客户端初始化用）：
            <br />
            <code style={{ userSelect: 'all' }}>{bridgeStatus?.running ? bridgeStatus.token : '（保存设置并启用后显示）'}</code>
            <br />
            客户端库与示例写在
            {' '}
            <code style={{ userSelect: 'all' }}>{bridgeStatus?.clientDir || '%APPDATA%\\qzrs-scrcpy\\data\\bridge'}</code>
            （<code>qzrs.py</code> 客户端 + <code>example.py</code> 示例，Python 仅需标准库）。
            <button className="btn" style={{ marginTop: 6 }} onClick={() => void window.api.openBridgeDir()}>
              打开示例目录
            </button>
          </div>
        </>
      )}

      {/*
        OCR 识别模型：脚本 findText/ocr 的底层能力。
        模型不进安装包（省 16MB + 支持后续独立升级），首次使用时在此按需下载。
      */}
      <div className="field row between">
        <label style={{ margin: 0 }}>OCR 识别模型（脚本找文字）</label>
        <span
          style={{
            fontSize: 12,
            color: ocr?.ready ? '#2ecc71' : ocrProgress?.phase === 'downloading' || ocrProgress?.phase === 'verifying' ? 'var(--accent, #4a9eff)' : 'var(--text-dim, #888)'
          }}
        >
          {ocrProgress?.phase === 'downloading' || ocrProgress?.phase === 'verifying'
            ? `下载中 ${Math.round(ocrProgress.percent)}%`
            : ocr?.ready
              ? '✓ 已就绪'
              : ocr
                ? `未下载（缺 ${ocr.files.filter((f) => !f.ok).length} 个文件）`
                : '…'}
        </span>
      </div>
      <div className="hint" style={{ marginTop: -6, marginBottom: 14 }}>
        供脚本使用「在屏幕上找文字 / 读取文字」（约 16MB，仅首次需要下载，下载到
        {' '}
        <code style={{ userSelect: 'all' }}>{ocr?.dir || '<安装目录>\\ocr-models'}</code>
        ）。
        {ocrProgress?.phase === 'downloading' && ocrProgress.file && (
          <>
            <br />
            正在下载 <code>{ocrProgress.file}</code>（{Math.round(ocrProgress.filePercent ?? 0)}%）
            {ocrProgress.message && <span style={{ color: 'var(--text-dim, #888)' }}> · {ocrProgress.message}</span>}
          </>
        )}
        {ocrProgress?.phase === 'verifying' && (
          <>
            <br />
            正在校验 SHA256…
          </>
        )}
        {ocrProgress?.phase === 'error' && (
          <>
            <br />
            <span style={{ color: 'var(--red, #e74c3c)' }}>下载失败：{ocrProgress.message}（已自动重试 3 次）</span>
          </>
        )}
        <div className="row" style={{ marginTop: 6, gap: 8 }}>
          <button
            className="btn"
            disabled={ocr?.ready === true || ocrProgress?.phase === 'downloading' || ocrProgress?.phase === 'verifying'}
            onClick={() => void window.api.downloadOcrModels()}
          >
            {ocr?.ready ? '已下载' : ocrProgress?.phase === 'downloading' || ocrProgress?.phase === 'verifying' ? '下载中…' : '下载模型'}
          </button>
          <button className="btn" onClick={() => void window.api.openOcrModelsDir()}>
            打开模型目录
          </button>
          {ocr?.manualUrl && (
            <button className="btn" onClick={() => void window.api.openOcrManual()}>
              手动下载（网盘）
            </button>
          )}
        </div>
      </div>

      <div className="field row between">
        <label style={{ margin: 0 }}>调试时写入日志文件</label>
        <Toggle checked={draft.debugLogToFile} onChange={(v) => patch({ debugLogToFile: v })} />
      </div>
      {draft.debugLogToFile && (
        <div className="hint" style={{ marginTop: -6, marginBottom: 14 }}>
          打开调试模式（工具栏「D」开关）后，触控坐标/按键映射日志会追加写入：
          <br />
          <code style={{ userSelect: 'all' }}>{logDir || '…'}\&lt;日期&gt;.log</code>
        </div>
      )}

      {extraInvalid && (
        <div className="hint" style={{ color: 'var(--red, #e74c3c)', marginTop: 16 }}>
          「额外扫描网段」有无法解析或超出上限的条目，修正后才能保存。
        </div>
      )}

      <div className="row" style={{ marginTop: 20 }}>
        <button
          className="btn btn-primary btn-block"
          disabled={extraInvalid}
          title={extraInvalid ? '额外扫描网段有无法解析或超出上限的条目，请先修正' : undefined}
          onClick={save}
        >
          保存设置
        </button>
      </div>
    </Drawer>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="slider" />
    </label>
  )
}
