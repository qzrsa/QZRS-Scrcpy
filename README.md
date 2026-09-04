# QZRS Scrcpy

一个现代、独立的 PC 端 Android 投屏与控制客户端。基于 Electron + React + TypeScript，**从零独立实现 scrcpy 4.1 协议**UI 经过重新设计，支持多设备群控、键鼠操作、截屏录屏、剪贴板同步、按键映射、文件传输与 ADB 终端。

> 协议完全自研：`adb push → adb forward → app_process 启动 Server → 三路 socket（video/control）→ WebCodecs 解码 H.264`。

## 功能特性

| 分类 | 能力 |
|------|------|
| 投屏 | H.264/H.265 视频流，WebCodecs 硬件解码，低延迟镜像 |
| 控制 | 鼠标点击/拖拽 = 触摸，右键 = 返回，中键 = 主页，滚轮 = 滑动，键盘 = 按键 |
| 群控 | 多设备同时连接，一键广播控制指令 |
| 屏幕 | 截屏、录屏（screenrecord）、旋转 |
| 剪贴板 | 双向同步 / 手动发送粘贴 |
| 按键映射 | 自定义键盘 → tap/swipe/keycode 映射，可视化录制 |
| 工具 | ADB Shell 终端、文件推送/拉取 |
| 设置 | 分辨率/码率/帧率、编码器、主题、常亮/触摸显示等 |

## 技术栈

- **Electron 44** + **electron-vite 5** + **Vite 7**
- **React 19** + **TypeScript 7**
- **WebCodecs `VideoDecoder`**（H.264 Annex-B → AVCC，avcC description）
- 自研协议层（`src/main/session.ts`、`src/main/protocol.ts`、`src/renderer/src/decoder/h264.ts`）

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
```

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

## License

MIT
