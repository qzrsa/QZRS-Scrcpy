# OCR 模型（PaddleOCR ONNX，RapidOCR 预转换）

供脚本引擎 OCR 能力使用（计划运行时：Electron 主进程 + onnxruntime-node，CPU EP）。  
来源：ModelScope `RapidAI/RapidOCR` v3.9.2（官方 default_models.yaml 的 onnxruntime 段），2026-10-03 下载。

| 文件                                             | 用途             | SHA256（官方值，已核验一致）                                                  |
| ---------------------------------------------- | -------------- | ------------------------------------------------------------------ |
| `ch_PP-OCRv4_det_mobile.onnx` (4.5MB)          | 文本检测 DBNet     | `d2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9` |
| `ch_PP-OCRv4_rec_mobile.onnx` (10.4MB)         | 文本识别 CRNN/SVTR | `48fc40f24f6d2a207a2b1091d3437eb3cc3eb6b676dc3ef9c37384005483683b` |
| `ch_ppocr_mobile_v2.0_cls_mobile.onnx` (0.6MB) | 方向分类（可选）       | `e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c` |
| `ppocr_keys_v1.txt` (6623 字符项)                 | rec 的 CTC 字典   | 官方 onnxruntime 段未提供哈希；内容已验证（6623 项 UTF-8，与 rec 输出维度匹配）             |

已验证：受管 python + onnxruntime 1.30.0 CPU EP 端到端推理（合成图"进入游戏 123"）→ det 检出文本区、rec 识别 `进入游戏123`，PASS。测试脚本：`.tmp/ocr-model-test/test_ocr.py`。

集成要点（rec 解码）：字符表 = `["<blank>"] + 字典逐行 + [" "]`；argmax 索引 0=blank，1..N=字典第 i-1 行，>N=空格；连续重复折叠。

