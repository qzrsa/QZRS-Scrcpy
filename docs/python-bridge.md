# Python 脚本桥（Python Bridge）

让电脑上的 Python 脚本控制 QZRS Scrcpy 的**当前投屏会话**：点按、滑动、按键、输文字、截屏，以及**多指并行触摸**（按住开火的同时点跳跃这类操作）。

- 设备操作走 scrcpy 控制协议（与应用内手动控制、内置 JS 脚本引擎同一条链路），注入延迟 <10ms。
- 客户端 `qzrs.py` **纯标准库**（urllib），Python 3.8+ 零 pip 依赖。
- 桥只监听 `127.0.0.1`，Bearer Token 鉴权——不暴露到局域网。

```
你的 Python 脚本 ──HTTP(127.0.0.1:17399)──> QZRS Scrcpy 桥 ──scrcpy 控制协议──> 安卓设备
```

## 开启

设置 → Python 脚本桥：打开开关、设端口（默认 17399）并保存。面板会显示 Token，并能看到客户端文件所在目录（`<userData>/data/bridge/`，含 `qzrs.py` 与 `example.py`，每次启动自动重写——要写脚本就在同目录新建自己的 `.py`，别改这两个）。

## 坐标系

所有坐标 = **投屏视频像素坐标**（与 app 内调试浮层、内置 JS 脚本引擎一致）。会话视频宽高从 `info()` 里拿。

注意：`screenshot()` 返回的是 adb screencap 的**设备原始分辨率** PNG，通常比视频流分辨率高，做找图/比色时按 `info()` 的 `width/height` 自行换算。

## 会话选择

所有接口的 `session` 参数可省略：当前恰好只有一个投屏会话时自动用它；零个或多个会话时必须显式传 `session=<sessionId>`（`sessionId` 从 `info()` 拿），避免误控其他设备。

---

## 快速上手

```python
from qzrs import QzrsClient, QzrsError

qz = QzrsClient(token="<设置面板里的 Token>", port=17399)
info = qz.info()                       # 应用版本 + 会话列表
s = info["sessions"][0]                # {sessionId, serial, width, height}

qz.tap(540, 960)                                  # 点按（视频像素坐标）
qz.tap(540, 960, duration_ms=800)                 # 长按 800ms
qz.swipe(540, 1500, 540, 500, duration_ms=400)    # 滑动
qz.key("BACK")                                    # 按键（名字或数字 keycode）
qz.key("A", duration_ms=1000)                     # 按住 A 键 1 秒
qz.text("hello")                                  # 输入文本（<=300 字节）
open("shot.png", "wb").write(qz.screenshot())     # 慢速截屏（设备原始分辨率）
open("cur.png", "wb").write(qz.frame())           # 快速取帧（视频分辨率，高频轮询用）
```

### 多指并行（finger 编号 0~9）

`tap/swipe` 是"一根虚拟手指"的完整手势，**手势完成才返回**，天然串行。要**多根手指同时**操作，用三根原语：

```python
# 场景：0 号手指按住开火键持续压枪，1 号手指点跳跃
qz.touch_down(1060, 520, finger=0)    # 0 号按下开火键（立即返回，保持按住）
qz.touch_down(600, 600, finger=1)     # 1 号按下跳跃键
qz.touch_up(1)                        # 1 号抬起（0 号继续按着）
qz.touch_move(1062, 520, finger=0)    # 0 号边按边微拖（压枪）
qz.touch_up(all_fingers=True)         # 收尾：一次抬起全部手指
```

规则：

| 规则 | 说明 |
|---|---|
| 立即返回 | 原语不等待，时序由 Python 控制（配合线程/协程可任意并行） |
| finger 编号 | 0~9 的整数（Android 触点上限 10）；不同编号互不干扰 |
| 抬起责任在调用方 | 按 down 必须有 up；`touch_up` 幂等（没按下也返回成功），收尾建议 `all_fingers=True` 兜底 |
| touch_up 落点 | 不带坐标时落在该手指最后一次 down/move 的位置 |
| 409 错误 | `touch_move` 未按下的 finger；对已按下的 finger 重复 `touch_down` |
| 会话断开 | 桥自动清理跟踪状态（控制 socket 已随会话关闭，无需补发 UP） |

---

## API 参考（HTTP 端点）

均为 JSON；鉴权头 `Authorization: Bearer <token>`；错误返回 `{"error": "..."}` + 对应状态码（400 参数 / 401 鉴权 / 404 不存在 / 409 状态冲突 / 500 内部）。

### GET /api/v1/info

```json
{ "app": "qzrs-scrcpy", "version": "...", "sessions": [ { "sessionId": "...", "serial": "...", "width": 1080, "height": 2400 } ] }
```

### POST /api/v1/tap

`{ x, y, durationMs?=60, sessionId? }` → 点按（DOWN → 等 durationMs → UP），**完成后返回** `{ ok, action, sessionId, x, y, durationMs }`。

### POST /api/v1/swipe

`{ x1, y1, x2, y2, durationMs?=300, sessionId? }` → 滑动（DOWN → 约 16ms 步长插值 MOVE → UP），**完成后返回** `{ ok, action, sessionId, steps, durationMs }`。

### POST /api/v1/key

`{ key, durationMs?=30, metastate?=0, sessionId? }` → 按键。`key` 用名字（`"BACK"` / `"HOME"` / `"VOLUME_UP"` / `"A"` / `"5"`…）或数字 keycode → `{ ok, action, sessionId, keycode, durationMs }`。

### POST /api/v1/text

`{ text, sessionId? }` → 输入文本（scrcpy INJECT_TEXT，**≤300 字节**，中文每字 3 字节）→ `{ ok, action, sessionId, bytes }`。

### POST /api/v1/touchdown

`{ finger?=0, x, y, sessionId? }` → finger 号手指按下，**立即返回** `{ ok, action, sessionId, finger, x, y, activeFingers }`。

### POST /api/v1/touchmove

`{ finger?=0, x, y, sessionId? }` → 拖动到 (x,y)，须先 touchdown，否则 409 → `{ ok, action, sessionId, finger, x, y, activeFingers }`。

### POST /api/v1/touchup

`{ finger?=0 | "all", sessionId? }`（或 `all: true`）→ 抬起（幂等）→ `{ ok, action, sessionId, released: [finger...], activeFingers }`。

### GET /api/v1/screenshot?sessionId=

返回 PNG 二进制（adb screencap，**设备原始分辨率**，含多屏告警前缀清洗）。慢（~300-500ms/次），适合采集找图模板、低频大截图。

### GET /api/v1/frame?sessionId=

返回 PNG 二进制（**投屏视频分辨率**最近一帧，响应头 `X-Frame-Width` / `X-Frame-Height`）。快（~10ms 级），适合高频比色/找色/OCR 轮询。

> ⚠ **模板/比色与截图来源必须同源**：两条通道分辨率不同，别拿 screenshot 采的模板到 frame 上匹配（反之亦然）。投屏分辨率设为 1280x720（与脚本坐标系一致）时两者内容几何一致，仅清晰度不同。两条通道独立（adb 隧道 vs 内存复制），互不影响投屏与控制延迟。frame 需要该会话的投屏画面已渲染（MirrorView 已挂载），否则返回 503。

---

## 完整示例：多指并行 + 截屏判断

```python
import time
from qzrs import QzrsClient, QzrsError

qz = QzrsClient(token="你的Token", port=17399)
s = qz.info()["sessions"][0]

try:
    qz.touch_down(1060, 520, finger=0, session=s["sessionId"])   # 开火
    for i in range(10):
        qz.touch_move(1060 + i, 520, finger=0, session=s["sessionId"])  # 持续右移压枪
        if i % 3 == 0:
            qz.tap(600, 600, session=s["sessionId"])             # 串行手势也能混用
        time.sleep(0.2)
finally:
    qz.touch_up(all_fingers=True, session=s["sessionId"])        # 异常也要抬手指
```

## 限制与注意

- `text` 单次 ≤300 字节（协议限制），长文本拆多次。
- `tap/swipe` 最长 60s；swipe 最短 30ms。
- 桥每次启动重写 `qzrs.py`/`example.py`；自己代码放同目录新文件。
- Token 在应用运行期内重启桥不变；重启应用后重新生成（面板可查）。
- 桥关闭/应用退出时所有挂起请求断开；已按下的手指随会话结束释放。
