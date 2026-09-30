# Live2D Movie Maker

Live2D 桌面编排与录制工具。使用 React、PIXI.js 和 Tauri，支持模型预览、动作/表情/音频/字幕时间线、WebGAL 项目导入，以及 WebM/MOV 导出。编辑器采用暖色像素风界面，Live2D 画面和导出画质不受界面主题影响。

## 功能

- 导入 `.zip` 模型包、模型文件夹或 `.model.json`、`.model3.json`、`.jsonl` 配置文件。
- 在模型库中选择、预览和移除已导入模型；首次启动会迁移旧版 `model` 目录中的资源。
- 编排动作、表情、音频和字幕片段，调整角色位置、缩放与导出设置。
- 自动恢复最近工程；也可保存/打开 `.l2dproject` 工程包。工程包会包含时间线和音频，Live2D 模型继续引用本机模型库。
- 导入 WebGAL 项目脚本及关联立绘、语音资源。
- 使用 MediaRecorder 实时录制，或逐帧离线导出 WebM；支持转换为带透明通道的 ProRes 4444 MOV。

## 运行

```bash
npm install
npm run tauri:dev
```

Tauri 配置会调用 `pnpm run dev` 和 `pnpm run build`，因此需要安装 pnpm。媒体编码依赖系统 PATH 中的 `ffmpeg`。

`npm run dev` 只启动 Vite 前端，Rust `invoke`、原生文件对话框和模型服务不可用；请用它做纯前端工作，不用于模型导入、WebGAL 或导出流程。

## 模型与工程存储

模型导入后会复制到 Tauri 应用数据目录下的 `models`。使用者无需把立绘手动放到仓库目录或可执行文件旁。旧版 `exe_dir/model` 资源在新模型库为空时迁移一次，旧资源保留不动。

通过“工程 → 保存工程副本”生成的 `.l2dproject` 是 ZIP 容器：包含时间线设置和音频文件。项目使用的 Live2D 模型需要已存在于当前设备的模型库；打开工程时若缺少模型，先导入模型再选择它。最近工程会自动写入 Tauri 应用本地数据目录以便崩溃后恢复。

## 导出

离线导出会逐帧渲染 PNG，再由 Rust 调用 `ffmpeg` 合成为 WebM。导出时长依据时间线画面长度，音频不会因轨道提前结束而截断视频。实时录制依赖当前 WebView 对 `MediaRecorder` 与 VP9 Alpha 的支持；不支持时请使用离线导出。

## 开发检查

```bash
npm run build
npm run lint
```

Rust 命令检查：

```bash
cd src-tauri
cargo check
```

目前仓库没有自动化测试套件。涉及模型加载、原生对话框和编码的改动还需要在 Tauri 桌面运行环境中检查。
