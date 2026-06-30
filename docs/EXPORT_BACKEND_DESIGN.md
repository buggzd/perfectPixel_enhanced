# 导出功能后端设计文档

面向：Python/FastAPI 后端工程师  
目标：在现有视频处理任务基础上新增“导出任务”，支持写入用户选择的本地路径，生成 PNG 序列帧、GIF、4x4 PNG 图集和单帧 PNG，并统一处理命名、帧率、尺寸、进度与错误。

## 1. 背景与现状

现有后端能力：

- `POST /api/jobs`：上传视频，生成 job。
- `process_video(video_path, output_dir, ...)`：把视频处理为临时 PNG 序列帧。
- 帧文件写入 `jobs/{job_id}/frames/frame_000000.png`。
- `GET /api/jobs/{job_id}/frames/{name}`：下载单帧。

现有限制：

- 输出目录固定为后端 job 临时目录。
- 文件名固定。
- 没有批量导出任务模型。
- 没有 GIF 和 sprite sheet 生成。
- 导出帧率、导出尺寸没有独立于处理阶段的配置。

## 2. 总体方案

新增导出任务层：

```text
视频处理任务 job
  └─ 临时处理帧 jobs/{job_id}/frames/*.png
      └─ 导出任务 export
          ├─ png_sequence      -> 用户选择目录
          ├─ gif               -> 用户选择 .gif 文件
          ├─ sprite_sheet_4x4  -> 用户选择 .png 文件
          └─ single_png        -> 用户选择 .png 文件
```

导出任务只读取已处理完成或已存在的临时 PNG 帧，不重新跑视频处理算法。这样可以保持现有预览链路稳定，同时让导出拥有独立进度、错误和参数校验。

## 3. 依赖建议

当前 requirements 包含 `opencv-python` 和 `numpy`，可以满足 PNG 读写、resize、拼图。

GIF 推荐新增：

```text
imageio>=2.34
pillow>=10.0
```

实现选择：

- PNG 序列帧、单帧、4x4 图集：用 OpenCV 读写即可。
- GIF：优先用 `imageio.v3.imwrite(..., plugin="pillow")` 或 `imageio.mimsave`。
- 所有缩放使用 `cv2.INTER_NEAREST`。

## 4. 数据模型

### 4.1 Job 增补字段

建议在 `Job` dataclass 中增加：

```py
source_video_name: str
source_fps: float
source_frame_count: int
processed_fps: float
frame_width: int | None
frame_height: int | None
exports: dict[str, ExportJob]
```

`processed_fps` 计算规则：

```py
processed_fps = source_fps / every_n_frames
```

如果 source fps 无法读取，则置为 `0` 或 `None`。

### 4.2 ExportJob

```py
@dataclass
class ExportJob:
    export_id: str
    job_id: str
    format: str
    output_path: str
    status: str = "queued"  # queued | running | done | error
    progress: float = 0.0
    total_items: int = 0
    current_item: int = 0
    written_files: list[str] = field(default_factory=list)
    error: str | None = None
    created_at: float = field(default_factory=time.time)
```

导出任务可以先只保存在内存中，与现有 `_jobs` 一致。后续如要跨重启恢复再落盘。

## 5. API 设计

### 5.1 获取视频/处理帧元信息

`GET /api/jobs/{job_id}/metadata`

响应：

```json
{
  "id": "9f3c1a2b7e8d4c60",
  "source_video_name": "walk_cycle.mp4",
  "source_fps": 30.0,
  "source_frame_count": 240,
  "processed_fps": 15.0,
  "processed_frame_count": 120,
  "frame_width": 128,
  "frame_height": 128,
  "grid_size": { "w": 64, "h": 64 }
}
```

用途：前端展示“原视频帧率”“处理后帧数”“默认导出尺寸”和 GIF 时长。

### 5.2 创建导出任务

`POST /api/jobs/{job_id}/exports`

请求 JSON：

```json
{
  "format": "png_sequence",
  "output_path": "/Users/user/Desktop/walk",
  "filename_template": "{project}_{index:04}",
  "index_start": 0,
  "overwrite": false,
  "fps": 12,
  "loop": true,
  "frame_selection": {
    "mode": "all",
    "every_n_frames": 1
  },
  "size": {
    "mode": "source"
  }
}
```

字段说明：

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `format` | string | 是 | `png_sequence` / `gif` / `sprite_sheet_4x4` / `single_png` |
| `output_path` | string | 是 | 序列帧为目录；GIF/图集/单帧为文件路径 |
| `filename_template` | string | 否 | 仅 PNG 序列帧需要 |
| `index_start` | int | 否 | 导出序号起始，默认 0 |
| `overwrite` | bool | 否 | 是否覆盖已存在文件，默认 false |
| `fps` | float | 否 | GIF 必填或默认 12；PNG 序列帧可写入 manifest |
| `loop` | bool | 否 | GIF 是否循环，默认 true |
| `frame_selection` | object | 是 | 导出哪些帧 |
| `size` | object | 是 | 导出尺寸规则 |

响应：

```json
{
  "export_id": "e7b1c92a",
  "status": "queued"
}
```

### 5.3 查询导出任务

`GET /api/jobs/{job_id}/exports/{export_id}`

响应：

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
  "written_files": [
    "/Users/user/Desktop/walk/walk_0000.png"
  ],
  "error": null
}
```

### 5.4 打开导出位置

打开文件夹更适合由 Tauri 前端完成。后端只返回 `output_path` 和 `written_files`。

## 6. 参数规范

### 6.1 format

```py
VALID_EXPORT_FORMATS = {
    "png_sequence",
    "gif",
    "sprite_sheet_4x4",
    "single_png",
}
```

### 6.2 frame_selection

支持：

```json
{
  "mode": "all",
  "every_n_frames": 1,
  "target_fps": 12,
  "max_frames": 60
}
```

```json
{
  "mode": "range",
  "start": 10,
  "end": 40,
  "every_n_frames": 2
}
```

```json
{
  "mode": "indices",
  "indices": [0, 3, 8, 15]
}
```

```json
{
  "mode": "current",
  "start": 12
}
```

筛选顺序建议：

1. 根据 `mode` 得到基础帧列表。
2. 应用 `every_n_frames`。
3. 如果有 `target_fps`，根据 `processed_fps / target_fps` 计算步长或使用时间轴重采样。
4. 应用 `max_frames`。
5. 对 sprite sheet 再应用 16 帧规则。

`target_fps` 说明：

- 如果 `processed_fps` 已知且大于 `target_fps`，按时间轴近似抽帧。
- 如果 `target_fps >= processed_fps`，不插帧，只保留原帧，并用请求的 `fps` 控制 GIF 播放速度。
- 本版本不做运动插帧。

### 6.3 size

支持：

```json
{ "mode": "source" }
```

```json
{ "mode": "scale", "scale": 4 }
```

```json
{
  "mode": "custom",
  "width": 256,
  "height": 256,
  "keep_aspect": true,
  "fit": "fit",
  "background": "#00000000"
}
```

规则：

- `source`：不改变临时处理帧尺寸。
- `scale`：整数倍缩放，范围建议 `[1, 32]`。
- `custom`：输出指定尺寸，宽高范围建议 `[1, 8192]`。
- `keep_aspect=true` 且 `fit=fit`：等比缩放后居中填充背景。
- `fit=exact`：直接 resize 到目标尺寸。
- 所有 resize 使用 `cv2.INTER_NEAREST`。

背景色：

- PNG 图集可以支持透明背景。
- OpenCV BGR 不含 alpha 时需要显式处理 BGRA。
- GIF 不支持完整 alpha，透明或半透明区域建议合成到纯色背景，默认 `#000000` 或由前端指定。

### 6.4 命名模板

支持变量：

- `{project}`
- `{index}`
- `{index:04}`
- `{source}`
- `{source_index}`
- `{fps}`
- `{width}`
- `{height}`

校验：

- 模板不能为空。
- 必须包含唯一性变量：`index` 或 `source_index`。
- 禁止路径分隔符和控制字符。
- 最终文件名强制 `.png` 后缀。
- `overwrite=false` 时任何目标文件已存在都应整体失败，不要导出一半。

建议先预生成所有目标路径并检查冲突，再开始写文件。

## 7. 导出实现规则

### 7.1 PNG 序列帧

输出：

```text
output_path/
  walk_0000.png
  walk_0001.png
  walk_0002.png
  manifest.json
```

`manifest.json` 建议写入：

```json
{
  "format": "png_sequence",
  "fps": 12,
  "width": 128,
  "height": 128,
  "frames": [
    { "file": "walk_0000.png", "source": "frame_000000.png", "source_index": 0 }
  ]
}
```

### 7.2 GIF

规则：

- `fps` 默认 12，范围建议 `[1, 60]`。
- 每帧 duration = `1 / fps`。
- `loop=true` 对应无限循环。
- GIF 调色板可能导致颜色损失；MVP 接受，后续可加 dithering 选项。

### 7.3 4x4 单图图集

规则：

- 固定 4 列 4 行。
- 输出尺寸 = 单帧输出宽高 × 4。
- 排列：左到右，上到下。
- 默认取 16 帧。
- 不足 16 帧策略：
  - `repeat_last`：重复最后一帧。
  - `transparent`：空格透明。
  - `error`：返回错误。

可选 manifest：

```json
{
  "format": "sprite_sheet_4x4",
  "file": "walk_sheet.png",
  "fps": 12,
  "frame_width": 128,
  "frame_height": 128,
  "columns": 4,
  "rows": 4,
  "frames": [
    { "source": "frame_000000.png", "x": 0, "y": 0, "w": 128, "h": 128 }
  ]
}
```

### 7.4 单帧 PNG

规则：

- 根据 `frame_selection` 得到 1 帧。
- 如果选择结果多于 1 帧，取第一帧并返回 warning，或直接 400；建议 400，保持语义明确。

## 8. 路径安全

这是桌面应用，用户选择路径后由本机后端写入，允许绝对路径。但仍需：

- 禁止空路径。
- 序列帧导出时 `output_path` 必须是目录；不存在则创建。
- GIF/图集/单帧导出时父目录必须存在或可创建。
- 不允许把文件写入已有目录路径。
- `overwrite=false` 时禁止覆盖。
- 捕获权限错误并返回可读错误，例如“没有写入权限，请选择其他位置”。

注意：后端不要把 `output_path` 暴露为可下载 URL；只作为本地路径返回给 Tauri 前端。

## 9. 进度与并发

导出任务用后台线程执行，与处理任务一致。

进度：

- PNG 序列帧：每写 1 张更新一次。
- GIF：读帧/缩放阶段更新到 0.9，写 GIF 完成后到 1.0。
- 4x4 图集：每放置 1 格更新一次。
- 单帧：写完即 1.0。

并发：

- 同一个 job 可以同时存在多个 export，但建议 MVP 限制同一 job 同时只运行一个导出任务，避免大量读写磁盘。
- 创建导出时 job 必须已有可用帧；最好要求 `job.status == "done"`，MVP 不支持边处理边导出。

## 10. 错误码建议

- `400`：参数非法、帧范围为空、尺寸非法、命名模板非法、目标文件冲突。
- `404`：job 或 export 不存在。
- `409`：job 未完成、已有导出任务运行中、目标路径冲突。
- `500`：图像读写失败、GIF 编码失败、系统 IO 异常。

错误响应沿用 FastAPI：

```json
{ "detail": "output_path already exists and overwrite=false" }
```

## 11. 实现建议文件结构

```text
api/server.py
  - 新增 export API 路由和 ExportJob 状态管理

src/perfect_pixel/exporting.py
  - select_frames(...)
  - resize_frame(...)
  - render_filename(...)
  - export_png_sequence(...)
  - export_gif(...)
  - export_sprite_sheet_4x4(...)
  - export_single_png(...)
```

建议把导出逻辑放到 `src/perfect_pixel/exporting.py`，不要继续扩大 `api/server.py`。

## 12. 必做验收标准

- PNG 序列帧可写入用户指定目录。
- 文件名模板生效，且不会静默覆盖。
- GIF 可设置 fps、loop、尺寸。
- 4x4 图集输出尺寸正确，排列顺序正确。
- 导出尺寸 resize 使用 nearest-neighbor。
- 帧范围、每 N 帧、目标 fps 至少一种抽帧方式可用；MVP 必须支持每 N 帧和范围。
- 导出进度可轮询，成功和失败状态稳定。
- 对不存在 job、未完成 job、空帧列表、权限错误都有明确错误。
