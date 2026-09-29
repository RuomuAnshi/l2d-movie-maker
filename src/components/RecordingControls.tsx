import type { VideoExportFormat, VideoExportMode } from "../utils/videoExporter";

export interface RecordingControlsProps {
  recordingQuality: "low" | "medium" | "high";
  setRecordingQuality: (quality: "low" | "medium" | "high") => void;
  transparentBg: boolean;
  setTransparentBg: (transparent: boolean) => void;
  includeAudio: boolean;
  setIncludeAudio: (include: boolean) => void;
  exportFormat: VideoExportFormat;
  setExportFormat: (format: VideoExportFormat) => void;
  exportMode: VideoExportMode;
  setExportMode: (mode: VideoExportMode) => void;
  exportState: "idle" | "done" | "exporting";
  exportTime: number;
  exportProgress: number;
  onExportVideo: (format: VideoExportFormat, mode: VideoExportMode, includeAudio: boolean) => void;
  onExportSubtitlesSrt: () => void;
  onTakeScreenshot: () => void;
  onTakePartsScreenshots: () => void;
}

export default function RecordingControls({
  recordingQuality,
  setRecordingQuality,
  transparentBg,
  setTransparentBg,
  includeAudio,
  setIncludeAudio,
  exportFormat,
  setExportFormat,
  exportMode,
  setExportMode,
  exportState,
  exportTime,
  exportProgress,
  onExportVideo,
  onExportSubtitlesSrt,
  onTakeScreenshot,
  onTakePartsScreenshots,
}: RecordingControlsProps) {
  const isBusy = exportState === "exporting";

  return (
    <div className="recording-controls">
      <div className="export-options-grid">
        <label className="field-stack">
          <span className="field-label">格式</span>
          <select
            className="input"
            value={exportFormat}
            disabled={isBusy}
            onChange={(event) => setExportFormat(event.target.value as VideoExportFormat)}
          >
            <option value="webm">WebM · VP9</option>
            <option value="mov">MOV · ProRes 4444</option>
          </select>
        </label>

        <label className="field-stack">
          <span className="field-label">内容</span>
          <select
            className="input"
            value={exportMode}
            disabled={isBusy}
            onChange={(event) => setExportMode(event.target.value as VideoExportMode)}
          >
            <option value="all">全部</option>
            <option value="live2d-only">仅角色</option>
            <option value="subtitle-only">仅字幕</option>
          </select>
        </label>

        <label className="field-stack">
          <span className="field-label">帧率</span>
          <select
            className="input"
            value={recordingQuality}
            disabled={isBusy}
            onChange={(event) => setRecordingQuality(event.target.value as "low" | "medium" | "high")}
          >
            <option value="low">24 fps</option>
            <option value="medium">30 fps</option>
            <option value="high">60 fps</option>
          </select>
        </label>
      </div>

      <div className="recording-bounds-settings">
        <label className="transparent-bg-label">
          <input
            type="checkbox"
            checked={transparentBg}
            disabled={isBusy}
            onChange={(event) => setTransparentBg(event.target.checked)}
            className="transparent-bg-checkbox"
          />
          透明背景
        </label>
        <label className="transparent-bg-label">
          <input
            type="checkbox"
            checked={includeAudio}
            disabled={isBusy}
            onChange={(event) => setIncludeAudio(event.target.checked)}
            className="transparent-bg-checkbox"
          />
          音频轨
        </label>
      </div>

      <button
        onClick={() => onExportVideo(exportFormat, exportMode, includeAudio)}
        disabled={isBusy}
        className="export-video-button"
      >
        {isBusy ? "正在导出…" : "导出视频"}
      </button>

      {isBusy ? (
        <div className="recording-progress" aria-live="polite">
          <div>
            {exportProgress >= 85 ? "编码视频" : "渲染画面"} · {exportTime.toFixed(1)} 秒
          </div>
          <div
            className="recording-progress-bar"
            role="progressbar"
            aria-label="视频导出进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(exportProgress)}
          >
            <div className="recording-progress-fill" style={{ width: `${exportProgress}%` }} />
          </div>
        </div>
      ) : null}

      <div className="button-grid">
        <button onClick={onExportSubtitlesSrt} disabled={isBusy} className="download-button">
          导出 SRT
        </button>
        <button onClick={onTakeScreenshot} disabled={isBusy} className="screenshot-button">
          截图
        </button>
        <button onClick={onTakePartsScreenshots} disabled={isBusy} className="parts-screenshot-button">
          部件截图
        </button>
      </div>
    </div>
  );
}
