import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { AppSettings, VideoCodec, DecoderAcceleration, UpdateSnapshot } from '@shared/types'
import {
  MAX_EXTRA_ADDRESSES,
  countRanges,
  estimateScanMs,
  formatDuration,
  parseSubnets
} from '@shared/subnet'
import { useApp } from '../store'
import { Drawer } from './Drawer'
import { IconChevron } from './icons'

export function SettingsPanel({
  onClose,
  focusSection
}: {
  onClose: () => void
  /**
   * 打开时自动滚到某个分区（现在是侧栏「发现新版本」提示 → 软件更新）。
   * 软更新排在最后一组，不滚一下用户会以为设置页里没有更新入口。
   */
  focusSection?: string | null
}): JSX.Element {
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
  // 自更新状态（主进程快照，渲染层只读）
  const [upd, setUpd] = useState<UpdateSnapshot | null>(null)
  const [updErr, setUpdErr] = useState('')
  // 更新状态行的文案（版本号并进状态行，重复的 reason 已剔掉），规则见 updateHeadText()
  const updHead = updateHeadText(upd)

  useEffect(() => {
    void window.api.getUpdateState().then(setUpd).catch(() => undefined)
    return window.api.onUpdateState(setUpd)
  }, [])

  /** 更新动作的统一入口：失败原因直接显示在按钮下方，不弹窗打断 */
  const runUpdate = async (fn: () => Promise<{ ok: boolean; reason?: string }>): Promise<void> => {
    setUpdErr('')
    try {
      const r = await fn()
      if (!r.ok && r.reason) setUpdErr(r.reason)
    } catch (e) {
      setUpdErr(e instanceof Error ? e.message : String(e))
    }
  }

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

  // 从侧栏「发现新版本」点进来 → 直接滚到软件更新那一组（它在最后，默认在视口外）
  useEffect(() => {
    if (!focusSection) return
    // 等一帧：分组可能因为 openWhen 刚从折叠变成展开，高度还没稳定
    const t = setTimeout(() => {
      document.getElementById(`sec-${focusSection}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 160)
    return () => clearTimeout(t)
  }, [focusSection])

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

  // 有没有未保存的改动：保存按钮旁边给一句提示，别让人改了半天以为已经生效
  const dirty =
    extraText !== (settings.extraScanSubnets ?? []).join('\n') ||
    JSON.stringify(draft) !== JSON.stringify(settings)

  // "有事要办"的更新状态：折叠着也要自动展开，否则用户点开设置看不到那个下载按钮
  const updActionable =
    !!upd && (upd.canDownload || upd.canApply || upd.status === 'failed' || !upd.supported)

  return (
    <Drawer title="设置" wide onClose={onClose}>
      {/*
        分区顺序按"多久动一次"排，不按代码里的字段顺序：
          常用（外观 / 画质 / 会话）在前且默认展开；
          改一次基本不再管（连接 / 扩展 / 调试）折叠收在后面；
          「软件更新」永远排最后 —— 它是"平时没事可做、有事才来一次"的操作，
          放在前面反而挡住常用设置。侧栏「发现新版本」提示点进来时会自动滚到这一组。
        每个分区的展开状态存 localStorage，下次打开保持。
      */}
      <Section id="display" title="外观与画面">
        <div className="field">
          <label>主题</label>
          <select className="select" value={draft.theme} onChange={(e) => patch({ theme: e.target.value as AppSettings['theme'] })}>
            <option value="dark">深色</option>
            <option value="light">浅色</option>
            <option value="system">跟随系统</option>
          </select>
        </div>

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
      </Section>

      <Section id="video" title="投屏画质">
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

        {/* 三个数字并排：它们互相无关但经常一起调，各占一行太浪费纵向空间 */}
        <div className="field-grid">
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
          </div>
          <div className="field">
            <label>分辨率（长边）</label>
            <input
              className="text-input"
              type="number"
              min={0}
              step={1}
              value={draft.session.maxSize}
              onChange={(e) => patchSession({ maxSize: Math.max(0, Number(e.target.value) || 0) })}
            />
          </div>
          <div className="field">
            <label>帧率（FPS）</label>
            <input
              className="text-input"
              type="number"
              min={0}
              step={1}
              value={draft.session.maxFps}
              onChange={(e) => patchSession({ maxFps: Math.max(0, Number(e.target.value) || 0) })}
            />
          </div>
        </div>
        <div className="hint" style={{ marginTop: -6, marginBottom: 14 }}>
          码率 <b>0</b> = 默认约 8 Mbps；分辨率 <b>0</b> = 设备原生（如 1920 / 2560）；帧率 <b>0</b> = 不限制。
        </div>
      </Section>

      <Section id="session" title="会话与操控">
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
      </Section>

      <Section id="conn" title="连接与扫描" defaultOpen={false}>
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
      </Section>

      <Section
        id="ext"
        title="扩展功能"
        defaultOpen={false}
        badge={draft.bridgeEnabled === true ? <span className="sec-badge on">Python 桥已启用</span> : null}
      >
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
      </Section>

      <Section
        id="debug"
        title="调试"
        defaultOpen={false}
        badge={draft.debugLog === true ? <span className="sec-badge on">已开启</span> : null}
      >
        <div className="field row between">
          <label style={{ margin: 0 }}>显示按键调试日志</label>
          <Toggle checked={draft.debugLog === true} onChange={(v) => patch({ debugLog: v })} />
        </div>
        <div className="hint" style={{ marginTop: -6, marginBottom: 14 }}>
          在画面左下角叠加最近 6 条按键 / 触控记录（命中了哪条映射、发到哪个坐标），
          <b>排查按键映射对不上时</b>打开看一眼即可，平时关着不占画面。
          <br />
          以前这是工具栏上的「D」按钮，现在挪到这里；<b>保存设置后生效</b>。
        </div>

        <div className="field row between">
          <label style={{ margin: 0 }}>调试时写入日志文件</label>
          <Toggle checked={draft.debugLogToFile} onChange={(v) => patch({ debugLogToFile: v })} />
        </div>
        {draft.debugLogToFile && (
          <div className="hint" style={{ marginTop: -6, marginBottom: 14 }}>
            打开上面「显示按键调试日志」后，触控坐标/按键映射日志会<b>再</b>追加写入：
            <br />
            <code style={{ userSelect: 'all' }}>{logDir || '…'}\&lt;日期&gt;.log</code>
          </div>
        )}
      </Section>

      {/*
        软件更新：与「快速启动」同一套模型 ——
          ① 启动时静默查一次（可关）；
          ② 发现新版本只提示，**下载与安装永远等用户点**；
          ③ 下载只摊进暂存区，重启后由"退出后助手"统一替换（Windows 上运行中的 exe 不可覆盖）。
        这里的状态全部来自主进程快照，渲染层不自己推断，避免出现两份真相。
        默认折叠（平时没事可做），但"有事要办"时 updActionable 会把它展开。
      */}
      <Section
        id="update"
        title="软件更新"
        defaultOpen={false}
        openWhen={updActionable}
        badge={
          <span className={`sec-badge upd-status ${upd?.status || ''}`} title="展开查看">
            {updHead.status}
          </span>
        }
      >
        <div className="upd-head">
          <span className="upd-ver">v{upd?.myVersion || '…'}</span>
          <span className={`upd-status ${upd?.status || 'idle'}`}>{updHead.status}</span>
          {upd?.checkedAtText && <span className="upd-when">上次检查 {upd.checkedAtText}</span>}
        </div>

        {/* 状态原因要显式给出来：用户看到"更新不可用"时最需要的是原因
            （形态不支持？清单没发？超时？），而不是一个静默的灰按钮 */}
        {upd && !upd.supported && (
          <div className="hint" style={{ marginTop: -2 }}>
            {upd.unsupportedReason}
          </div>
        )}
        {/* 形态支持但目录不可写：还能查、不能装。原因单独显示，别和"形态不支持"混成一句 */}
        {upd?.supported && !upd.dirWritable && (
          <div className="hint" style={{ marginTop: -2, color: 'var(--red, #e74c3c)' }}>
            {upd.dirWritableReason}
          </div>
        )}
        {upd?.supported && updHead.extra && (
          <div className="hint upd-reason" style={{ marginTop: -2 }}>
            {updHead.extra}
          </div>
        )}

        {upd?.progress && (
          <div className="upd-bar" role="progressbar" aria-valuenow={upd.progress.pct ?? 0} aria-valuemin={0} aria-valuemax={100}>
            <div className="upd-bar-fill" style={{ width: `${upd.progress.pct ?? 0}%` }} />
            <span className="upd-bar-text">{upd.progress.text}</span>
          </div>
        )}

        <div className="upd-actions">
          <button
            className="btn"
            disabled={!upd?.canCheck}
            onClick={() => void runUpdate(() => window.api.checkUpdate())}
          >
            {upd?.busy ? '请稍候…' : '检查更新'}
          </button>
          {upd?.canDownload && upd.plan?.mode === 'delta' && (
            <span
              className="upd-when"
              title={`差量基准 v${upd.plan.from}；换机 / 改过程序文件时会自动退回全量`}
            >
              差量 · 省 {(upd.plan.fullSize / Math.max(upd.plan.size, 1)).toFixed(1)}×
            </span>
          )}
          {upd?.canDownload && (
            <button className="btn btn-primary" onClick={() => void runUpdate(() => window.api.downloadUpdate())}>
              下载更新{upd.plan ? `（${upd.plan.sizeText}）` : ''}
            </button>
          )}
          {upd?.canApply && (
            <button className="btn btn-primary" onClick={() => void runUpdate(() => window.api.applyUpdate())}>
              重启并更新
            </button>
          )}
          <button className="btn btn-ghost" onClick={() => void window.api.openUpdateDir()}>
            更新目录
          </button>
        </div>

        {updErr && (
          <div className="hint" style={{ color: 'var(--red, #e74c3c)' }}>
            {updErr}
          </div>
        )}

        <div className="upd-row">
          <span>启动时自动检查更新</span>
          <Toggle checked={draft.autoUpdate !== false} onChange={(v) => patch({ autoUpdate: v })} />
        </div>

        <div className="field" style={{ marginTop: 10, marginBottom: 0 }}>
          <label>更新源（可留空）</label>
          <input
            className="text-input"
            value={draft.updateBase}
            placeholder="留空 = GitHub releases/latest/download"
            onChange={(e) => patch({ updateBase: e.target.value })}
          />
        </div>

        <div className="hint">
          <b>安装版与绿色版都支持</b>自动更新（两者目录结构相同）；单文件便携版已停止发布
          —— 它在运行中无法替换自己，本来就没法自更新。
          <br />
          启动时只<b>检查</b>一次（不轮询、不后台常驻），发现新版本会在左侧栏提示；
          <b>下载与安装永远等你点</b>，不会偷偷替换文件。
          <br />
          下载优先走<b>差量</b>（只下和当前版本不同的数据块，常见能省 80% 以上流量）；
          差量基准对不上（换过机器、手动改过程序文件）时自动退回全量整包，<b>不会因此更新失败</b>。
          <br />
          更新只替换程序文件，<b>按键方案 / 脚本 / 日志 / OCR 模型</b>（安装目录下的
          <code>keymaps</code>、<code>scripts</code>、<code>logs</code>、<code>ocr-models</code>）一律不碰。
          <br />
          装到 <code>Program Files</code> 这类需要管理员权限的目录时无法自更新（写不进去），
          安装时选「用户目录」或非系统盘即可。
          <br />
          更新源填镜像或代理时应指向"一次 Release 的资产目录"，例如
          <code style={{ userSelect: 'all' }}>https://ghproxy.example/https://github.com/qzrsa/QZRS-Scrcpy/releases/latest/download</code>
          。改了更新源需先<b>保存设置</b>，下一次检查才生效。
        </div>
      </Section>

      {/* 保存栏固定在抽屉底部：分区多了以后，滚到哪儿都能看到"还没保存" */}
      <div className="settings-foot">
        <span className={`settings-foot-note ${extraInvalid ? 'err' : dirty ? 'warn' : ''}`}>
          {extraInvalid
            ? '「额外扫描网段」有无法解析或超出上限的条目'
            : dirty
              ? '有未保存的修改'
              : ''}
        </span>
        <button
          className="btn btn-primary"
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

/**
 * 设置页的可折叠分区。
 *
 * 三态优先级：用户手动点过 → 用用户的；否则 `openWhen`（有事要办的紧急态，如"发现新版本"）
 * → 否则 localStorage 里存的上次状态 → 否则 `defaultOpen`。
 * 手动态一旦存在就一直优先，避免"正在调某组设置时被自动展开/收起打断"。
 */
function Section(props: {
  id: string
  title: string
  /** 折叠时显示在标题右侧的短状态（展开后不显示，避免和正文重复） */
  badge?: ReactNode
  defaultOpen?: boolean
  /** 变为 true 时自动展开（用户手动操作过则以用户为准） */
  openWhen?: boolean
  children: ReactNode
}): JSX.Element {
  const storeKey = `settings-sec-${props.id}`
  const [manual, setManual] = useState<boolean | null>(null)
  const stored = useMemo<boolean | null>(() => {
    try {
      const v = localStorage.getItem(storeKey)
      if (v === '1') return true
      if (v === '0') return false
    } catch {
      /* ignore */
    }
    return null
  }, [storeKey])
  const open = manual ?? (props.openWhen ? true : (stored ?? props.defaultOpen !== false))

  const toggle = (): void => {
    const next = !open
    setManual(next)
    try {
      localStorage.setItem(storeKey, next ? '1' : '0')
    } catch {
      /* ignore */
    }
  }

  return (
    <section id={`sec-${props.id}`} className={`sec ${open ? 'open' : ''}`}>
      <button className="sec-head" aria-expanded={open} onClick={toggle}>
        <IconChevron className="sec-arrow" width={16} height={16} />
        <span className="sec-title">{props.title}</span>
        {!open && props.badge ? props.badge : null}
      </button>
      {open && <div className="sec-body">{props.children}</div>}
    </section>
  )
}

/**
 * 更新卡片的两行文案：状态行 + 补充原因（没有可补充的就是空串）。
 *
 * 主进程给了 statusText 与 reason 两份信息，用途不同：前者是"阶段"，后者是"为什么"。
 * 但有两处会撞车，直接并排渲染就成了用户看到的：
 *
 *   v1.4.1  已是最新版本                                  ← statusText
 *   已是最新版本                                          ← reason（一字不差）
 *
 * 所以这里的规则是：
 *   1. `available` 时把目标版本号**并进状态行**（"发现新版本 v1.4.2"），和侧栏提示同一口径；
 *   2. reason 与状态行一字不差 → 丢掉（uptodate / downloading 这类阶段名本身就是答案）；
 *   3. 其余 reason 保留 —— 它们才有信息量（更新源没有清单 / 清单属于别的程序 / 具体报错）。
 */
function updateHeadText(u: UpdateSnapshot | null): { status: string; extra: string } {
  if (!u) return { status: '…', extra: '' }
  const status = u.status === 'available' && u.latest ? `发现新版本 v${u.latest}` : u.statusText || '…'
  const reason = u.reason || ''
  if (!u.supported || !reason) return { status, extra: '' }
  if (reason === u.statusText || reason === status) return { status, extra: '' }
  if (u.status === 'available' && reason === `发现 v${u.latest}`) return { status, extra: '' }
  return { status, extra: reason }
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="slider" />
    </label>
  )
}
