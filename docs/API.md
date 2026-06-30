# Perfect Pixel Video API — 接口文档

> 面向前端（Tauri）工程师。本服务由 Tauri 主程序作为 sidecar 自动拉起，监听 `http://127.0.0.1:<动态端口>`。
> **端口不再固定**：Tauri 在启动时选一个空闲端口，通过环境变量 `PERFECT_PIXEL_PORT` 传给后端，并经 Tauri 命令 `backend_url` / `backend_status` 暴露给前端。前端永远不要硬编码端口。
> 处理流程：上传视频 → 后端抽帧并逐帧做完美像素对齐（**多帧投票锁定网格尺寸 + 每帧自适应网格 + 输出颜色时序滤波**，保证帧间稳定不闪烁）→ 输出对齐后的 PNG 序列帧。

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
| GET | `/api/jobs/{job_id}/metadata` | 获取源/处理帧元信息（帧率、帧数、尺寸） |
| POST | `/api/jobs/{job_id}/exports` | 创建导出任务（PNG 序列/GIF/4×4 图集/单帧） |
| GET | `/api/jobs/{job_id}/exports/{export_id}` | 查询导出任务状态/进度 |

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
| `adaptive_grid` | bool | 否 | `true` | 每帧重新精细化网格并与前一帧 EMA 混合（方案2）。关闭则退回「锁定首帧坐标」旧行为 |
| `grid_blend` | float | 否 | `0.7` | 网格线时序混合的前一帧权重，范围 `[0, 1]`。越大越稳定，越小越跟随内容 |
| `temporal_smoothing` | bool | 否 | `true` | 输出颜色逐像素 EMA 时序滤波（方案3）。突变超阈值的像素直通，避免拖影 |
| `temporal_alpha` | float | 否 | `0.4` | 输出 EMA 的当前帧权重，范围 `(0, 1]`。越小越平滑、响应越慢 |
| `scene_change_threshold` | float | 否 | `30.0` | 像素最大通道差超过此值视为突变，跳过平滑（0~255，越大越不易触发直通） |
| `vote_frames` | int | 否 | `5` | 锁定网格尺寸时用于中位数投票的起始帧数（方案1），`grid_size` 显式指定时忽略。`0` = 仅用首帧 |
| `denoise` | bool | 否 | `false` | 是否在分析前对每帧做保边双边滤波去压缩伪影（方案4）。默认关闭以避免模糊干净源 |
| `denoise_strength` | float | 否 | `5.0` | 去噪强度，`>=0`，越大越强 |

> **网格尺寸说明**：不传 `grid_size_w/h` 时，默认用前 `vote_frames` 帧的检测结果做中位数投票锁定网格尺寸（`vote_frames=0` 退回首帧检测）；锁定后所有帧共用该尺寸，避免逐帧闪烁。若手动传入 `grid_size_w/h`，则所有帧统一使用该尺寸并跳过投票。
>
> **时序稳定性**：默认 `adaptive_grid=true` + `temporal_smoothing=true`，逐帧自适应网格线位置（与前一帧 EMA 混合）并对输出颜色做带变化检测的 EMA 平滑，输出帧尺寸逐帧恒定。如需复现旧行为（锁第一帧坐标、无颜色平滑），可同时设 `adaptive_grid=false`、`temporal_smoothing=false`。

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

## 7. 获取元信息

`GET /api/jobs/{job_id}/metadata`

返回源视频与处理帧的元信息，供前端展示“原视频帧率”“处理后帧数”“默认导出尺寸”和 GIF 时长。

**响应** `200`
```json
{
  "id": "9f3c1a2b7e8d4c60",
  "source_video_name": "walk_cycle",
  "source_fps": 30.0,
  "source_frame_count": 240,
  "processed_fps": 15.0,
  "processed_frame_count": 120,
  "frame_width": 128,
  "frame_height": 128,
  "grid_size": { "w": 64, "h": 64 },
  "status": "done"
}
```

> `processed_fps = source_fps / every_n_frames`。源 fps 无法读取时为 `0`，`grid_size` 在网格检测失败时为 `null`。

---

## 8. 创建导出任务

`POST /api/jobs/{job_id}/exports`（`application/json`）

任务必须处于 `done` 状态，且同一 job 同时只允许一个导出任务运行（`409`）。导出在后台线程执行，立即返回 `export_id`；参数非法返回 `400`。

**请求体**
```json
{
  "format": "png_sequence",
  "output_path": "/Users/user/Desktop/walk",
  "filename_template": "{project}_{index:04}",
  "index_start": 0,
  "overwrite": false,
  "fps": 12,
  "loop": true,
  "frame_selection": { "mode": "all", "every_n_frames": 1 },
  "size": { "mode": "source" },
  "sprite_pad": "repeat_last"
}
```

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `format` | string | 是 | `png_sequence` / `gif` / `sprite_sheet_4x4` / `single_png` |
| `output_path` | string | 是 | 序列帧为目录；GIF/图集/单帧为文件路径（绝对路径） |
| `filename_template` | string | png_sequence 必填 | 命名模板，必须含 `{index}` 或 `{source_index}` |
| `index_start` | int | 否 | 序号起始，默认 0 |
| `overwrite` | bool | 否 | 覆盖已存在文件，默认 false |
| `fps` | float | 否 | GIF 帧率（默认 12，范围 [1,60]）；序列帧写入 manifest |
| `loop` | bool | 否 | GIF 是否循环，默认 true |
| `frame_selection` | object | 是 | 帧选择（见下） |
| `size` | object | 是 | 尺寸规则（见下） |
| `sprite_pad` | string | 否 | 图集不足 16 帧：`repeat_last`(默认)/`transparent`/`error` |

`frame_selection` 支持 `mode`：`all` / `range`(start,end 含端) / `indices` / `current`(start)。可选 `every_n_frames`、`target_fps`、`max_frames`。筛选顺序：mode → every_n → target_fps 时间轴重采样 → max_frames →（图集）16 帧规则。

`size` 支持 `mode`：`source` / `scale`(整数倍 [1,32]) / `custom`(width,height,keep_aspect,fit=fit|exact,background)。所有缩放使用最近邻；`custom`+`fit`+透明背景输出 BGRA。

**响应** `200`
```json
{ "export_id": "e7b1c92a", "status": "queued" }
```

**错误**：`400` 参数非法/帧范围为空/模板非法；`404` job 不存在；`409` job 未完成或已有导出运行中。

---

## 9. 查询导出任务

`GET /api/jobs/{job_id}/exports/{export_id}`

**响应** `200`
```json
{
  "export_id": "e7b1c92a",
  "job_id": "9f3c1a2b7e8d4c60",
  "format": "png_sequence",
  "status": "running",
  "progress": 0.42,
  "total_items": 120,
  "current_item": 50,
  "output_path": "/Users/user/Desktop/walk",
  "written_files": ["/Users/user/Desktop/walk/walk_0000.png"],
  "error": null
}
```

状态机：`queued → running → done | error`。`404` 表示 job 或 export 不存在。打开导出位置由 Tauri 前端用 `output_path` 完成，后端不提供下载 URL。

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
