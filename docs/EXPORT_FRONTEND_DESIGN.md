# 导出功能前端设计文档

面向：Tauri/React 前端工程师  
目标：把当前“只能下载当前单帧”的流程升级为可批量导出 PNG 序列帧、GIF、4x4 单图图集，并允许用户选择导出路径、命名规范、导出帧率、导出尺寸和导出帧范围。

## 1. 背景与现状

当前应用已有：

- 视频处理任务：`POST /api/jobs` 上传视频并生成后端临时 PNG 序列帧。
- 任务进度：`GET /api/jobs/{job_id}` 轮询状态。
- 帧列表：`GET /api/jobs/{job_id}/frames`。
- 单帧下载：前端用 `<a href="/frames/{name}" download>` 下载当前帧。

主要问题：

- 批量导出需要用户逐帧下载。
- 不能选择本地导出目录。
- 文件名固定为 `frame_000000.png`，不能按项目/时间/原始帧号命名。
- GIF、4x4 sprite sheet 没有统一入口。
- 播放帧率和导出帧率混在一起，导出尺寸也只有处理阶段的 `output_scale`，无法在导出时独立设置。

## 2. 设计原则

- 处理与导出分离：处理任务负责生成可预览的标准中间帧；导出任务负责把这些帧按用户设置写到最终路径。
- 前端只负责采集导出意图、选择路径、显示进度，不在浏览器侧拼 GIF 或批量写文件。
- 导出尺寸、导出帧率、命名规范都属于导出任务参数，不应回写到已有处理任务参数。
- 所有图像缩放默认使用 nearest-neighbor，避免像素画被模糊。
- 导出路径必须是用户显式选择的目录或文件路径。

## 3. 用户流程

### 3.1 入口

在处理完成后的播放页新增导出区域，建议放在当前“下载当前帧”按钮旁：

- `导出...` 主按钮：打开导出弹窗。
- `下载当前帧` 保留为快速单帧下载。

导出弹窗包含 4 个导出类型：

- PNG 序列帧
- GIF 动图
- 4x4 单图图集
- 当前帧

### 3.2 导出路径

交互建议：

- PNG 序列帧：选择目录。
- GIF：选择保存文件，扩展名 `.gif`。
- 4x4 图集：选择保存文件，扩展名 `.png`。
- 当前帧：选择保存文件，扩展名 `.png`。

Tauri 侧建议接入 `@tauri-apps/plugin-dialog`：

- `open({ directory: true })` 用于选择序列帧目录。
- `save({ filters })` 用于选择 GIF/PNG 文件。

需要更新：

- `frontend/package.json`：增加 `@tauri-apps/plugin-dialog`。
- `frontend/src-tauri/src/lib.rs`：注册 dialog 插件。
- `frontend/src-tauri/capabilities/default.json`：增加 dialog 权限。

如果暂时不接 dialog 插件，MVP 可退化为后端默认导出到 job 下的 `exports/` 并提供“打开导出目录”，但这不满足“自选导出路径”的目标，只能作为临时方案。

### 3.3 命名规范

PNG 序列帧需要提供命名模板输入框，默认：

```text
{project}_{index:04}
```

模板变量：

| 变量 | 含义 | 示例 |
| :--- | :--- | :--- |
| `{project}` | 项目名，默认取视频文件名去扩展名 | `walk_cycle` |
| `{index}` | 导出序号，从 0 或 1 开始 | `0` |
| `{index:04}` | 补零导出序号 | `0001` |
| `{source}` | 原始处理帧文件名去扩展名 | `frame_000012` |
| `{source_index}` | 原始处理帧 index | `12` |
| `{fps}` | 导出帧率 | `12` |
| `{width}` | 导出宽度 | `256` |
| `{height}` | 导出高度 | `256` |

前端需要做轻量校验：

- 必须包含 `{index}`、`{index:NN}` 或 `{source_index}` 之一，避免覆盖。
- 不允许路径分隔符 `/`、`\`、`:` 等平台风险字符。
- 后缀由后端补 `.png`，用户模板里不建议输入扩展名；如果输入 `.png`，后端也要兼容。

### 3.4 帧范围与抽帧

新增“导出帧”区域：

- 范围：全部 / 当前帧 / 自定义范围。
- 自定义范围字段：起始帧、结束帧，基于当前处理后的帧序号。
- 抽帧方式：
  - 每 N 帧导出 1 帧。
  - 目标导出 FPS。
  - 最多导出 N 帧。

推荐前端文案：

- “当前处理帧数：120”
- “原视频帧率：30 FPS；处理抽帧后等效帧率：15 FPS”
- “导出 GIF 帧率：12 FPS”

注意：播放控件里的 `playbackFps` 只是预览速度，导出弹窗需要有独立的 `exportFps`。

### 3.5 导出尺寸

新增“尺寸”区域：

- 原始处理尺寸。
- 整数倍缩放：1x、2x、3x、4x、8x、16x。
- 自定义尺寸：宽、高。
- 保持比例开关。
- 尺寸适配方式：
  - `exact`：强制输出指定宽高。
  - `fit`：等比适配到框内，透明或背景色填充。
  - `scale`：按整数倍缩放。

默认建议：

- PNG 序列帧：沿用当前处理输出尺寸。
- GIF：沿用当前处理输出尺寸，默认 12 FPS。
- 4x4 图集：单帧尺寸沿用当前处理输出尺寸，输出总尺寸为 `单帧宽 * 4` × `单帧高 * 4`。

前端需要展示导出预估：

- 单帧尺寸：`128 × 128`
- 导出帧数：`16`
- 总图集尺寸：`512 × 512`
- GIF 时长：`16 / 12 = 1.33s`

### 3.6 4x4 图集规则

用户选择“4x4 单图图集”时：

- 固定 16 个格子。
- 默认从当前帧开始取 16 帧；也可选择“从范围内均匀采样 16 帧”。
- 不足 16 帧时提供策略：
  - 重复最后一帧，默认。
  - 留空透明。
  - 报错并提示用户调整范围。
- 排列顺序：从左到右、从上到下。

前端需要显示 4x4 预览网格，可复用已有帧缩略图。

### 3.7 导出任务状态

导出时调用后端新接口创建导出任务，之后轮询：

```ts
POST /api/jobs/{job_id}/exports
GET  /api/jobs/{job_id}/exports/{export_id}
```

前端状态建议：

- `idle`：未导出。
- `validating`：本地校验参数。
- `exporting`：后端导出中。
- `done`：导出完成，显示文件/目录路径和“打开位置”按钮。
- `error`：显示错误，允许重试。

导出中禁止重复点击同一导出按钮，但不需要锁死播放器。

### 3.8 前端 API 类型建议

```ts
export type ExportFormat = "png_sequence" | "gif" | "sprite_sheet_4x4" | "single_png";

export interface ExportFrameSelection {
  mode: "all" | "current" | "range" | "indices";
  start?: number;
  end?: number;
  indices?: number[];
  every_n_frames?: number;
  target_fps?: number;
  max_frames?: number;
  sprite_sampling?: "first_16" | "from_current" | "even_16";
  insufficient_frames?: "repeat_last" | "transparent" | "error";
}

export interface ExportSizeOptions {
  mode: "source" | "scale" | "custom";
  scale?: number;
  width?: number;
  height?: number;
  keep_aspect?: boolean;
  fit?: "exact" | "fit";
  background?: string;
}

export interface CreateExportRequest {
  format: ExportFormat;
  output_path: string;
  filename_template?: string;
  index_start?: number;
  overwrite?: boolean;
  fps?: number;
  loop?: boolean;
  frame_selection: ExportFrameSelection;
  size: ExportSizeOptions;
}
```

### 3.9 推荐组件拆分

- `ExportDialog`
- `ExportFormatTabs`
- `ExportPathPicker`
- `ExportNamingPanel`
- `ExportFrameSelectionPanel`
- `ExportSizePanel`
- `ExportProgressToast`

当前 `App.tsx` 已经较大，建议导出 UI 单独拆到 `frontend/src/components/export/`，避免继续堆在主文件里。

## 4. 参数默认值

| 参数 | 默认值 |
| :--- | :--- |
| 导出类型 | PNG 序列帧 |
| PNG 命名模板 | `{project}_{index:04}` |
| index 起始 | `0` |
| 覆盖同名文件 | `false` |
| 导出帧范围 | 全部 |
| 抽帧 | 每 1 帧导出 1 帧 |
| GIF FPS | `12` |
| GIF loop | `true` |
| 尺寸 | 原始处理尺寸 |
| 4x4 不足 16 帧 | 重复最后一帧 |

## 5. 必做验收标准

- 用户可以选择本地目录导出 PNG 序列帧。
- 用户可以设置 PNG 文件命名模板和起始 index。
- 用户可以导出 GIF，并能设置 FPS 与尺寸。
- 用户可以导出 4x4 PNG 图集，并能设置单帧尺寸。
- 用户可以选择导出全部帧、当前帧、范围帧、每 N 帧。
- 导出过程中有进度，失败有明确错误。
- 导出完成后能打开导出目录或定位导出文件。
- 导出尺寸使用 nearest-neighbor，不产生模糊像素边缘。

## 6. 后续增强

- 保存导出预设：例如 Aseprite、Unity、Godot、Web GIF。
- 支持 8x8、N列 x N行图集。
- 支持 APNG/WebP。
- 支持导出 `metadata.json`，记录 fps、尺寸、帧列表、图集格子坐标。
- 支持导出前预估磁盘占用。
