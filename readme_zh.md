# Perfect Pixel Enhanced (像素级完美帧增强版)

> **自动检测、精细化并获取单帧图像及视频序列的完美像素艺术。**

[English](readme.md) | [简体中文](readme_zh.md)

[![Python](https://img.shields.io/badge/Python-3.8+-blue.svg)](#)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](#)

---

## 📌 项目起源与 Fork 说明
本项目是原始 [theamusing/perfectPixel](https://github.com/theamusing/perfectPixel) 仓库的增强型 **Fork** 版本。原项目主要用于处理单张静态像素图的网格对齐，而本增强版本在此基础上，扩展了对**视频时序处理**和**时序稳定性调优**的支持，并提供了一个**独立运行的跨平台桌面端应用**。

---

## ✨ 核心新增特性 (本 Fork)

### 1. 视频序列与时序稳定性处理
- **视频像素化转换**：支持提取并精细化 MP4/MOV/AVI 视频帧，最终输出完美对齐网格的像素 PNG 帧序列。
- **自动网格锁定**：在起始帧上自动检测最佳像素网格尺寸，并在后续帧中予以锁定，杜绝因每帧独立估计而导致的空间网格抖动。
- **首帧网格投票数 (`vote_frames`)**：基于多帧投票机制计算起始坐标网格，确保检测到的网格基础极其稳固。
- **自适应网格与时序平滑**：通过指数移动平均 (EMA) 在时序上平滑混合优化后的坐标，确保画面运动如丝般顺滑，无网格突变 popping。
- **去噪预处理**：在进行网格估算前，过滤视频帧中的压缩伪影。

### 2. 独立运行的桌面客户端 (Tauri + React + FastAPI)
- **零依赖打包**：将 Python FastAPI 后端服务编译为 sidecar 可执行程序直接打包进客户端。最终用户无需安装 Python、Node 或 Rust 环境，双击即可运行。
- **Spotify 风格的沉浸式暗黑 UI**：高阶质感的纯黑/炭灰界面，集成各类交互式微调开关、定制版胶囊下拉选择框与 Spotify 质感的轨道滑动条。
- **垂直阻尼时间轴**：右侧内置垂直 snap-scrolling 滚轮式相册时间轴。支持鼠标滚轮拖拽并自动进行中心磁吸贴合（实时流畅更新预览帧），同时在视频播放时自动追踪并将当前帧滚入视口中心。

---

## 📦 安装与配置

本库提供了包含 OpenCV 和无 OpenCV（轻量级）两种实现方案。您可以根据环境选择：

| 后端 | 文件 | 依赖 | 用途说明 |
| :--- | :--- | :--- | :--- |
| **OpenCV 后端** | [`perfect_pixel.py`](./src/perfect_pixel/perfect_pixel.py) | `opencv-python`, `numpy` | 默认的高性能推荐后端 |
| **轻量级后端** | [`perfect_pixel_no_cv2.py`](./src/perfect_pixel/perfect_pixel_noCV2.py) | `numpy` | 纯 NumPy 实现（无需安装 cv2） |

使用 `pip` 安装库：
```bash
# 推荐：支持 OpenCV 的快速版本
pip install perfect-pixel[opencv]

# NumPy 轻量版：无 OpenCV 依赖
pip install perfect-pixel
```

---

## 🖥️ 桌面端应用开发

### 1. 准备工作 (推荐使用 Python 3.11/3.12)
```bash
# 创建虚拟环境并安装后端依赖
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

### 2. 开发环境启动
您可以通过一条命令同时启动前端 UI 和后端 sidecar 服务：
```bash
cd frontend
npm install
npm run tauri dev # 启动 React 前端并自动唤起 FastAPI 后端进程
```
Tauri 外壳会自动管理 Python 后端的生命周期（日志输出至 `backend.log` 并动态绑定空闲端口）。

### 3. 构建发布包
将应用打包为独立双击安装包（macOS 下为 `.dmg`/`.app`，Windows 下为 `.exe`）：
```bash
bash scripts/build_app.sh
```
该脚本会首先通过 PyInstaller 编译后端 sidecar 可执行程序并拷贝至 `frontend/src-tauri/binaries/`，随后执行 Tauri 打包。

---

## 🔌 ComfyUI 自定义节点
我们提供了 ComfyUI 自定义节点，以便直接在 ComfyUI 工作流中使用：
- [`了解如何将 Perfect Pixel 用作 ComfyUI 节点`](integrations/comfyui/README.md)

---

## 🛠️ API 与命令行使用

### 静态图像网格优化
```python
import cv2
from perfect_pixel import get_perfect_pixel

bgr = cv2.imread("images/avatar.png", cv2.IMREAD_COLOR)
rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)

# 估算网格并采样生成完美像素图
w, h, out = get_perfect_pixel(rgb)
```

### 视频处理接口快捷测试
```bash
# 提交视频任务（时序稳定性默认开启）
curl -F video=@test.mp4 -F output_scale=4 http://127.0.0.1:8765/api/jobs
# 查询任务状态
curl http://127.0.0.1:8765/api/jobs/<job_id>
```
完整的接口设计、参数负载以及 sidecar 集成模式请参考接口协议文档 [`docs/API.md`](./docs/API.md)。

#### 时序稳定性参数
视频处理默认开启多套时序稳定性机制（均为可选，作为 `POST /api/jobs` 的表单字段透传）：

| 参数 | 默认 | 用途 |
| :--- | :--- | :--- |
| `adaptive_grid` | `true` | 每帧重新精细化网格并与前一帧 EMA 混合 |
| `grid_blend` | `0.7` | 网格线 EMA 的前一帧权重 `[0, 1]` |
| `temporal_smoothing` | `true` | 输出颜色逐像素 EMA 平滑（带变化检测） |
| `temporal_alpha` | `0.4` | 输出 EMA 的当前帧权重 `(0, 1]` |
| `scene_change_threshold` | `30.0` | 像素变化超此值则直通，不做平滑 |
| `vote_frames` | `5` | 用前 N 帧中位数投票锁定网格尺寸 |
| `denoise` | `false` | 可选的保边去压缩伪影预处理 |
| `denoise_strength` | `5.0` | 去噪强度（`>=0`） |

同时设 `adaptive_grid=false`、`temporal_smoothing=false` 可复现旧行为（锁第一帧坐标、无颜色平滑）。

---

## 🚀 持续交付
推送 `v*` 形式的 tag 会触发 [`.github/workflows/release.yml`](./.github/workflows/release.yml)，自动构建 Python wheel + sdist 并发布 GitHub Release（附带产物、自动生成发版说明）：

```bash
git tag v0.1.4
git push origin v0.1.4
```

发版产物位于 [GitHub Releases](https://github.com/buggzd/perfectPixel_enhanced/releases)，可直接安装：

```bash
pip install perfect_pixel-0.1.4-py3-none-any.whl
```

---

## 🧮 算法原理概述
核心算法包含以下三个主要步骤：
1. **网格大小估算**：通过对图像亮度进行快速傅里叶变换 (FFT)，分析频域幅度来估算最佳网格尺寸并生成基础网格。
2. **网格坐标精细化**：在 Sobel 边缘图像上执行一维搜索，微调网格坐标使其精确对齐边缘边界。
3. **像素重采样**：在微调后的网格中心提取原始像素颜色，重新渲染为规整、锐利的完美像素艺术画。

---

## 📄 开源协议
本项目采用 **MIT License** 授权协议发布，详见 [`LICENSE`](./LICENSE)。
