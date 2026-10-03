import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Python 桥客户端文件：应用启动时写入 `<userData>/data/bridge/`，
 * 设置面板提供「打开目录」入口。每次启动都重写（跟随 app 版本更新，
 * 用户别在放这里改这两个文件——要写脚本就在同目录新建自己的 .py）。
 *
 * qzrs.py 只用标准库（urllib），Python 3.8+ 直接 import，零 pip 依赖。
 * 模板用 String.raw：Python 代码里的 \n、%d 等必须原样落盘。
 */

const QZRS_PY = String.raw`# -*- coding: utf-8 -*-
"""QZRS Scrcpy - Python 外挂桥客户端（仅标准库，零 pip 依赖）。

用法：
    from qzrs import QzrsClient
    qz = QzrsClient(token="<设置面板里的 Token>", port=17399)
    print(qz.info())
    qz.tap(540, 960)                                   # 点按（视频像素坐标）
    qz.swipe(540, 1500, 540, 500, duration_ms=400)     # 滑动
    qz.key("BACK")                                     # 按键（名字或数字 keycode）
    qz.text("hello")                                   # 输入文本（<=300 字节）
    open("shot.png", "wb").write(qz.screenshot())      # 截屏 PNG 字节

坐标 = 投屏视频像素坐标（与 app 内调试浮层、内置 JS 脚本引擎一致）。
session 参数可省略：当前恰好只有一个投屏会话时自动用它；有多个会话必须传
session=<sessionId>（sessionId 从 info() 里拿）。
"""

import json
import urllib.error
import urllib.parse
import urllib.request


class QzrsError(RuntimeError):
    """桥返回的错误（HTTP 非 2xx 或网络失败）。message 里带状态码与原因。"""


class QzrsClient:
    def __init__(self, token, port=17399, host="127.0.0.1", timeout=60):
        self.base = "http://%s:%d" % (host, port)
        self.timeout = timeout
        self._headers = {
            "Authorization": "Bearer " + str(token),
            "Content-Type": "application/json",
        }

    # ---- 内部 ----

    def _request(self, method, path, body=None):
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(self.base + path, data=data, headers=self._headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")
            try:
                msg = json.loads(raw).get("error", raw)
            except ValueError:
                msg = raw
            raise QzrsError("HTTP %d: %s" % (e.code, msg))
        except urllib.error.URLError as e:
            raise QzrsError("连接失败（桥没开？端口对吗？）: %s" % e.reason)

    def _json(self, method, path, body=None):
        return json.loads(self._request(method, path, body).decode("utf-8"))

    def _sid(self, session):
        return None if session is None else str(session)

    # ---- API ----

    def info(self):
        """应用版本 + 当前会话列表 [{sessionId, serial, width, height}]。"""
        return self._json("GET", "/api/v1/info")

    def tap(self, x, y, duration_ms=60, session=None):
        """点按。duration_ms>0 为长按（按下到抬起的间隔）。完成后才返回。"""
        return self._json("POST", "/api/v1/tap", {
            "x": x, "y": y, "durationMs": duration_ms, "sessionId": self._sid(session),
        })

    def swipe(self, x1, y1, x2, y2, duration_ms=300, session=None):
        """滑动：(x1,y1) -> (x2,y2)，总时长 duration_ms，内部按约 16ms 步长插值。完成后才返回。"""
        return self._json("POST", "/api/v1/swipe", {
            "x1": x1, "y1": y1, "x2": x2, "y2": y2,
            "durationMs": duration_ms, "sessionId": self._sid(session),
        })

    def key(self, key, duration_ms=30, metastate=0, session=None):
        """按键。key 用名字（"BACK"/"HOME"/"VOLUME_UP"/"A"/"5"...）或数字 keycode。"""
        return self._json("POST", "/api/v1/key", {
            "key": key, "durationMs": duration_ms,
            "metastate": metastate, "sessionId": self._sid(session),
        })

    def text(self, s, session=None):
        """输入文本（scrcpy INJECT_TEXT，<=300 字节，中文每字 3 字节）。"""
        return self._json("POST", "/api/v1/text", {
            "text": s, "sessionId": self._sid(session),
        })

    def screenshot(self, session=None):
        """截屏，返回 PNG 字节。是 adb screencap 的设备原始分辨率（比视频流分辨率高，
        做找图模板时注意按 info() 里的 width/height 换算）。"""
        path = "/api/v1/screenshot"
        if session is not None:
            path += "?sessionId=" + urllib.parse.quote(str(session))
        return self._request("GET", path)
`

const EXAMPLE_PY = String.raw`# -*- coding: utf-8 -*-
"""示例：连接桥 -> 打印会话 -> 点屏幕中心 -> 截屏保存。

运行前：
  1. QZRS Scrcpy 设置里打开「Python 脚本桥」并保存
  2. 把设置面板里显示的 Token 填到环境变量 QZRS_TOKEN（或改下面 TOKEN）
  3. python example.py
"""
import os
import sys

from qzrs import QzrsClient, QzrsError

TOKEN = os.environ.get("QZRS_TOKEN", "把设置面板里的Token粘贴到这里")
PORT = 17399


def main():
    qz = QzrsClient(token=TOKEN, port=PORT)
    try:
        info = qz.info()
    except QzrsError as e:
        print("连接失败：", e)
        print("请确认：设置里已打开 Python 脚本桥并保存；Token 正确。")
        sys.exit(1)

    sessions = info["sessions"]
    print("QZRS Scrcpy", info["version"], "| 会话数:", len(sessions))
    if not sessions:
        print("当前没有投屏会话，请先在 app 里连接一台设备。")
        sys.exit(1)
    s = sessions[0]
    print("目标会话:", s["sessionId"], s["serial"], "%dx%d" % (s["width"], s["height"]))

    cx, cy = s["width"] // 2, s["height"] // 2
    qz.tap(cx, cy)
    print("已点击屏幕中心 (%d, %d)" % (cx, cy))

    png = qz.screenshot(s["sessionId"])
    with open("qzrs_screenshot.png", "wb") as f:
        f.write(png)
    print("截屏已保存 qzrs_screenshot.png（%d 字节）" % len(png))


if __name__ == "__main__":
    main()
`

/** 写出（必要时建目录）客户端文件，返回目录路径 */
export function writeBridgeClients(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'qzrs.py'), QZRS_PY, 'utf8')
  writeFileSync(join(dir, 'example.py'), EXAMPLE_PY, 'utf8')
  return dir
}
