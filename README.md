# QZRS Scrcpy

一个现代、独立的 PC 端 Android 投屏与控制客户端。基于 Electron + React + TypeScript，**按 scrcpy 4.1 的开源协议规范独立实现了 PC 端**（未复用 scrcpy 客户端源码，设备端复用官方 scrcpy-server），UI 经过重新设计，支持多设备群控、键鼠操作、截屏录屏、剪贴板同步、按键映射、脚本自动化、文件传输与 ADB 终端。

> 工作链路：`adb push → adb forward → app_process 启动官方 scrcpy-server → 三路 socket（video/control）→ WebCodecs 解码 H.264`。

## 功能特性

| 分类 | 能力 |
|------|------|
| 投屏 | H.264/H.265 视频流，WebCodecs 硬件解码，低延迟镜像 |
| 控制 | 鼠标点击/拖拽 = 触摸，右键 = 返回，中键 = 主页，滚轮 = 滑动，键盘 = 按键 |
| 群控 | 多设备同时连接，一键广播控制指令 |
| 屏幕 | 截屏、录屏（screenrecord）、旋转 |
| 剪贴板 | 双向同步 / 手动发送粘贴 |
| 按键映射 | 自定义键盘 → tap/swipe/keycode 映射，可视化录制 |
| 脚本自动化 | 用 JS 编写 tap/swipe/text/key/wait 动作序列自动执行（[脚本编写指南](docs/script-guide.md)） |
| 工具 | ADB Shell 终端、文件推送/拉取 |
| 设置 | 分辨率/码率/帧率、编码器、主题、常亮/触摸显示等 |

## 技术栈

- **Electron 44** + **electron-vite 5** + **Vite 7**
- **React 19** + **TypeScript 7**
- **WebCodecs `VideoDecoder`**（H.264 Annex-B → AVCC，avcC description）
- 协议层为独立实现（`src/main/session.ts`、`src/main/protocol.ts`、`src/renderer/src/decoder/h264.ts`），协议规范来自开源项目 [Genymobile/scrcpy](https://github.com/Genymobile/scrcpy)

## 环境要求

- Windows 10/11（macOS / Linux 亦可运行，路径逻辑已跨平台）
- Node.js ≥ 20
- 本机 `adb`（已加入 PATH，或在设置中指定路径，或在 `C:\platform-tools\adb.exe`）
- Android 设备已开启「开发者选项 → USB 调试」

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 开发模式启动
npm run dev

# 3. 生产构建
npm run build
# 产物在 out/ 目录，可用 electron out/main/index.js 或打包工具运行

# 4. 打包三种产物（输出到 ../release/，含 adb / scrcpy / scrcpy-server）
npm run dist
#   安装版   QZRS Scrcpy Setup <version>.exe
#   便携版   QZRS Scrcpy <version>.exe
#   绿色版   win-unpacked/（免安装目录）
```

## 在 GitHub 上编译（免本地环境）

仓库内置了 GitHub Actions 工作流 [`.github/workflows/build.yml`](.github/workflows/build.yml)，
不用配本地 Node / 依赖，直接在网页上就能出包：

| 触发方式 | 行为 |
|----------|------|
| push 到 `main` | 自动类型检查 → 编译 → 打包三种产物 → 上传为可下载产物 |
| **Actions → Build → Run workflow**（手动） | 随时重编；可填「产物名后缀」（如本地序号 `011`） |
| 打 `v*` 标签（如 `git tag v1.0.0`） | 额外自动创建 GitHub Release 并附上全部产物 |

每次构建产出三种，按需取用：

| 产物 | 文件名 | 说明 |
|------|--------|------|
| **安装版** | `QZRS-Scrcpy-Setup-<编号>.exe` | 标准安装向导，可自选安装目录、自动建桌面/开始菜单快捷方式 |
| **便携版** | `QZRS-Scrcpy-Portable-<编号>.exe` | 单文件，双击即用，可放 U 盘 |
| **绿色版** | `QZRS-Scrcpy-Green-<编号>.zip` | 免安装目录，解压即用 |

编号沿用本地约定 `QZRS Scrcpy <8位日期><3位序号>`：手动触发时可自己填序号与本地对齐，
否则用 GitHub 的 run number 自动补零。

**拿到产物**：进入 `Actions` → 点开对应那次 run → 页面底部 `Artifacts` 里下载
`QZRS-Scrcpy-<编号>`，解压后即可使用（adb / scrcpy / scrcpy-server 均已随包附带，无需另装）。

打 `v*` 标签时，三个产物也会出现在仓库的 **Releases** 页面，可直接下载。

> 注①：绿色版 zip 解压后 `QZRS Scrcpy.exe` 直接在当前目录（压缩包是扁平结构），
> 建议先新建一个文件夹再解压。
>
> 注②：绿色版 zip 用连字符命名（`QZRS-Scrcpy-Green-...`）而不是空格，是因为 GitHub
> 会把 Release 资产名里的空格自动替换成点（`QZRS Scrcpy X.zip` → `QZRS.Scrcpy.X.zip`），
> 且该行为无法通过 action 覆盖。

## 连接设备

1. **USB 连接**：数据线连接手机，启动应用后侧栏会出现设备，点击「连接」。
2. **无线连接**：
   - 手机与电脑同一局域网，先在设置里获取设备 IP（`设置 → 关于 → 状态 → IP 地址`），或
   - 应用内「无线连接」面板：输入 `IP:端口` 一键切换设备到 TCP/IP 模式（`adb tcpip 5555`）。
3. 默认测试设备：`192.168.11.111:5555`（Galaxy Z Fold5）。

## 协议验证（真机冒烟测试）

根目录 `smoke-test.mjs` 可脱离 GUI 直接对真机验证协议链路：

```bash
node smoke-test.mjs
```

通过时输出 `=== PROTOCOL OK ===`，包含设备名、编码器、分辨率与首帧信息。

### 协议关键约束（踩坑记录）

| 约束 | 说明 |
|------|------|
| **scid 必须 31 位** | 服务端 `Options.java` 用 `Integer.parseInt(hex, 16)`（有符号 32 位）解析，高位为 1 会溢出抛 `NumberFormatException`。客户端必须 `& 0x7FFFFFFF`。 |
| **需连 video + control 两路** | `DesktopConnection.open()` 按 video→audio→control 顺序阻塞 `accept()`，全部接受后才写设备名。只连一路会死锁。 |
| **连接顺序** | 先连 video（读 1 字节 dummy 确认存活）→ 再连 control → 之后才从 video 读 64 字节设备名。 |
| **cleanup 默认 true** | 服务端退出时会自删 `scrcpy-server.jar`，客户端每次会话都需重新 push。 |
| **分辨率 1088 对齐** | 编码器输出高度会向上对齐到 16（如 1920×1088），渲染时裁掉底部多出的行。 |

## 项目结构

```
src/
├── main/            # 主进程：adb 封装、会话、IPC、协议编码、配置存储
│   ├── adb.ts       # adb 命令封装（push/forward/shell/screencap/record…）
│   ├── session.ts   # scrcpy 会话：推流、三路 socket、H.264 帧解析
│   ├── protocol.ts  # 控制消息编码（touch/scroll/keycode，BE 字节布局）
│   ├── ipc.ts       # IPC 通道与 AppManager
│   └── util.ts      # scid 生成、端口、adb/server 路径查找
├── preload/         # 安全桥接（contextBridge）
├── renderer/src/    # React 前端
│   ├── App.tsx      # 主布局
│   ├── components/  # 侧栏/工具栏/镜像/抽屉/各弹窗
│   ├── decoder/h264.ts  # WebCodecs H.264 解码器
│   └── store.tsx    # 状态管理
└── shared/types.ts  # 主/渲染进程共享类型
```

## 致谢

- [Genymobile/scrcpy](https://github.com/Genymobile/scrcpy)（Apache-2.0）：本项目的设备端直接使用官方 `scrcpy-server`，PC 端协议实现也基于其公开的协议规范——没有这个优秀的开源项目就没有本项目。
- [adb（Android platform-tools）](https://developer.android.com/tools/adb)：设备连接与文件传输基础。

## License

MIT
