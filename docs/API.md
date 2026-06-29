# Perfect Pixel Video API — 接口文档

> 面向前端（Tauri）工程师。本服务由 Tauri 主程序作为 sidecar 自动拉起，监听 `http://127.0.0.1:<动态端口>`。
> **端口不再固定**：Tauri 在启动时选一个空闲端口，通过环境变量 `PERFECT_PIXEL_PORT` 传给后端，并经 Tauri 命令 `backend_url` / `backend_status` 暴露给前端。前端永远不要硬编码端口。
> 处理流程：上传视频 → 后端抽帧并逐帧做完美像素对齐（**首帧自动检测网格尺寸并锁定，后续帧复用**，保证帧间稳定不闪烁）→ 输出对齐后的 PNG 序列帧。

## 基础信息

| 项 | 值 |
| :--- | :--- |
| Base URL | 运行时由 Tauri 决定（默认 `http://127.0.0.1:8765`，仅用于脱离 Tauri 手动启动调试） |
| 协议 | HTTP/1.1 |
| 数据格式 | JSON（除文件上传为 multipart/form-data、帧下载为 image/png） |
| CORS | 允许所有源（Tauri 的 `tauri://localhost` / `http://localhost:*` 均可直连） |

## 启动后端

### 常规（一体化，推荐）

```bash
cd frontend
npm run tauri dev     # Tauri 自动起 Python 后端（用仓库 .venv），前端启动后即可用
```

无需手动 `python -m api.run`。Tauri 会选端口、传环境变量、等 `/api/health` 就绪、关闭时回收进程。

### 脱离 Tauri 手动启动（调试用）

```bash
python3.12 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python -m api.run            # 监听 127.0.0.1:8765（默认端口）
# 或自定义：PERFECT_PIXEL_PORT=9000 PERFECT_PIXEL_JOBS_DIR=/tmp/jobs python -m api.run
```

### 环境变量

| 变量 | 默认 | 说明 |
| :--- | :--- | :--- |
| `PERFECT_PIXEL_HOST` | `127.0.0.1` | 监听地址 |
| `PERFECT_PIXEL_PORT` | `8765` | 监听端口（Tauri 启动时设为动态空闲端口） |
| `PERFECT_PIXEL_JOBS_DIR` | `<repo>/jobs` | 任务工作目录（dev）；打包后为 `app_local_data_dir/jobs` |

---

## 端点总览

| Method | Path | 说明 |
| :--- | :--- | :--- |
| GET | `/api/health` | 健康检查 |
| POST | `/api/jobs` | 创建视频处理任务（上传视频 + 选项） |
| GET | `/api/jobs/{job_id}` | 查询任务状态/进度 |
| GET | `/api/jobs/{job_id}/frames` | 列出输出帧 |
| GET | `/api/jobs/{job_id}/frames/{name}` | 下载单帧 PNG |
| DELETE | `/api/jobs/{job_id}` | 取消任务并清理工作目录 |

---

## 1. 健康检查

`GET /api/health`

**响应** `200`
```json
{ "status": "ok" }
```

前端启动 sidecar 后可轮询此接口确认服务就绪。

---

## 2. 创建任务

`POST /api/jobs`

**请求**：`multipart/form-data`

| 字段 | 类型 | 必填 | 默认 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| `video` | file | 是 | — | 输入视频文件（cv2 可解码的任意格式：mp4/mov/avi/webm…） |
| `sample_method` | string | 否 | `majority` | 采样方式：`center` / `median` / `majority` |
| `grid_size_w` | int | 否 | 自动 | 手动指定网格宽度（像素列数）；与 `grid_size_h` 同时给出则跳过自动检测，对所有帧生效 |
| `grid_size_h` | int | 否 | 自动 | 手动指定网格高度（像素行数） |
| `refine_intensity` | float | 否 | `0.25` | 网格线微调强度，范围 `[0, 0.5]` |
| `fix_square` | bool | 否 | `true` | 当检测图像近似正方形时是否强制输出正方形 |
| `min_size` | float | 否 | `4.0` | 单像素最小尺寸（像素），低于此判定无效 |
| `peak_width` | int | 否 | `6` | 峰值检测最小宽度 |
| `output_scale` | int | 否 | `1` | 输出帧最近邻放大倍数，范围 `[1, 16]`（1 = 原始对齐尺寸） |
| `every_n_frames` | int | 否 | `1` | 抽帧步长。1 = 每帧，2 = 每隔一帧取一帧 |

> **grid_size 说明**：不传 `grid_size_w/h` 时，首帧自动检测网格尺寸并锁定，后续所有帧复用该尺寸（避免逐帧闪烁）。若手动传入，则所有帧统一使用该尺寸。

**响应** `200`
```json
{ "job_id": "9f3c1a2b7e8d4c60", "status": "queued" }
```

**错误**
- `400` 参数非法（含错误信息 `detail`）
- `422` multipart 字段缺失/类型错误

---

## 3. 查询任务状态

`GET /api/jobs/{job_id}`

**响应** `200`
```json
{
  "id": "9f3c1a2b7e8d4c60",
  "status": "running",
  "progress": 0.42,
  "total_frames": 120,
  "current_frame": 50,
  "grid_size": { "w": 64, "h": 64 },
  "output_frames": ["frame_000000.png", "frame_000001.png"],
  "error": null
}
```

| 字段 | 说明 |
| :--- | :--- |
| `status` | `queued` \| `running` \| `done` \| `error` |
| `progress` | 0~1 进度（已写帧数 / 预计总帧数；视频无法预知长度时运行中可能为 0，完成时为 1） |
| `total_frames` | 预计/实际输出帧数 |
| `current_frame` | 已写入帧数 |
| `grid_size` | 锁定的网格尺寸；首帧检测完成前为 `null` |
| `output_frames` | 已写出的帧文件名列表（按写入顺序） |
| `error` | 失败原因；正常为 `null` |

**错误** `404` 任务不存在（或已删除）。

> **轮询节奏建议**：每 300~500ms 拉一次；`status` 为 `done` 或 `error` 时停止。未来如需实时流式进度可扩展 SSE 端点，当前 v1 用轮询即可。

---

## 4. 列出输出帧

`GET /api/jobs/{job_id}/frames`

**响应** `200`
```json
{
  "frames": [
    { "name": "frame_000000.png", "index": 0 },
    { "name": "frame_000001.png", "index": 1 }
  ]
}
```

帧按文件名升序排列；`index` 解析自文件名，便于按序播放。

---

## 5. 下载单帧

`GET /api/jobs/{job_id}/frames/{name}`

`{name}` 形如 `frame_000000.png`。

**响应** `200` `Content-Type: image/png`（PNG 二进制）

**错误**
- `400` 帧名非法（含路径分隔符 / 非 png）
- `404` 帧不存在

> 前端展示帧有两种方式：
> 1. **HTTP 直连**：`<img src="http://127.0.0.1:8765/api/jobs/{id}/frames/frame_000000.png">`，最简单，适合预览。
> 2. **本地文件**：通过 Tauri 的文件系统能力读取后端 `jobs/{id}/frames/` 目录（路径见状态接口未暴露，可按需扩展返回 `output_dir`）。需要更高播放性能或离线展示时使用。

---

## 6. 取消并清理任务

`DELETE /api/jobs/{job_id}`

取消运行中的任务（设置取消标志），删除该任务的工作目录（含上传视频与输出帧），从任务表中移除。

**响应** `200`
```json
{ "id": "9f3c1a2b7e8d4c60", "deleted": true }
```

> 注意：取消是协作式的——正在处理当前帧的逻辑会在下一次进度回调时抛出并退出；已写出的帧会随目录一并删除。

---

## 状态机

```
queued ──▶ running ──▶ done
              │
              └────────▶ error
DELETE 可在任意状态下调用（清理）
```

---

## Tauri 集成要点

1. **Sidecar 启动（已实现）**：Tauri Rust 层（`frontend/src-tauri/src/lib.rs`）在 `setup` 阶段选空闲端口、准备 jobs/logs 目录、spawn 后端（dev 用 `.venv` 的 `python -m api.run`，release 用 PyInstaller 打包的 `perfect-pixel-api` 二进制），stdout/stderr 重定向到 `logs/backend.log`。后台线程轮询 `/api/health`，就绪后置 `ready`。
2. **端口与 URL 发现**：端口动态，前端启动时调用 Tauri 命令 `backend_status`（返回 `{ready, url, error}`）轮询直到 `ready`，再用 `url` 调 `setBaseUrl`；之后所有请求走该 URL。命令另有 `backend_url`（直接取 URL）、`open_logs_dir`（打开日志目录）。
3. **生命周期**：App 退出时（`RunEvent::Exit`）Rust 杀掉后端子进程；单实例插件防止重复启动抢端口。
4. **上传**：`POST /api/jobs` 用 multipart 上传视频文件；Tauri 前端用 `FormData` + `fetch` 即可。
5. **进度**：创建后保存 `job_id`，前端 `setInterval` 每 ~400ms 调 `GET /api/jobs/{id}`，更新进度条；`done` 后拉取帧列表渲染。
6. **帧预览/播放**：用 `/frames/{name}` 作为 `<img>` 帧序列源；按 `index` 顺序定时切换。
7. **清理**：用户关闭/取消时调 `DELETE /api/jobs/{id}`，避免 `jobs/` 目录堆积（服务启动时也会清空上次残留）。

---

## curl 速测示例

```bash
# 健康检查
curl http://127.0.0.1:8765/api/health

# 创建任务（majority 采样，输出 4 倍放大）
curl -F video=@test.mp4 \
     -F sample_method=majority \
     -F output_scale=4 \
     http://127.0.0.1:8765/api/jobs
# -> {"job_id":"9f3c1a2b7e8d4c60","status":"queued"}

# 轮询状态
curl http://127.0.0.1:8765/api/jobs/9f3c1a2b7e8d4c60

# 列出帧
curl http://127.0.0.1:8765/api/jobs/9f3c1a2b7e8d4c60/frames

# 下载首帧
curl -o frame0.png http://127.0.0.1:8765/api/jobs/9f3c1a2b7e8d4c60/frames/frame_000000.png

# 取消并清理
curl -X DELETE http://127.0.0.1:8765/api/jobs/9f3c1a2b7e8d4c60
```
