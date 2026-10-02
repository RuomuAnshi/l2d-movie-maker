import {
  resolveExportPipeline,
  type VideoExportFormat,
  type VideoExportMethod,
  type VideoExportMode,
  type VideoExportPhase,
} from "../utils/videoExporter";
import { getWebmRecordingSupport } from "../utils/canvasRecorder";

export interface RecordingControlsProps {
  exportRangeAvailable?:boolean;
  useMarkedExportRange?:boolean;
  setUseMarkedExportRange?:(value:boolean)=>void;
  estimatedStorageBytes?:number;
  recordingQuality: "low" | "medium" | "high";
  setRecordingQuality: (quality: "low" | "medium" | "high") => void;
  transparentBg: boolean;
  setTransparentBg: (transparent: boolean) => void;
  includeAudio: boolean;
  setIncludeAudio: (include: boolean) => void;
  exportFormat: VideoExportFormat;
  setExportFormat: (format: VideoExportFormat) => void;
  exportMethod: VideoExportMethod;
  setExportMethod: (method: VideoExportMethod) => void;
  exportMode: VideoExportMode;
  setExportMode: (mode: VideoExportMode) => void;
  exportState: "idle" | "done" | "exporting";
  exportPhase: VideoExportPhase;
  exportTime: number;
  exportProgress: number;
  onCancelExport: () => void;
  onExportVideo: (format: VideoExportFormat, mode: VideoExportMode, includeAudio: boolean, method: VideoExportMethod) => void;
  onExportSubtitlesSrt: () => void;
  onTakeScreenshot: () => void;
  onTakePartsScreenshots: () => void;
  exportSequenceLabel?: string;
  projectFps?: number;
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
  exportMethod,
  setExportMethod,
  exportMode,
  setExportMode,
  exportState,
  exportPhase,
  exportTime,
  exportProgress,
  onCancelExport,
  onExportVideo,
  onExportSubtitlesSrt,
  onTakeScreenshot,
  onTakePartsScreenshots,
  exportSequenceLabel,
  projectFps,exportRangeAvailable,useMarkedExportRange,setUseMarkedExportRange,estimatedStorageBytes,
}: RecordingControlsProps) {
  const isBusy = exportState === "exporting";
  const recordingSupport = getWebmRecordingSupport();
  // 实际管线由格式、方式、透明背景和环境共同决定；与「方式」里的选择不一致时给出降级说明。
  const pipeline = resolveExportPipeline({
    format: exportFormat,
    method: exportMethod,
    transparentBg,
    recordingSupported: recordingSupport.supported,
  });

  return (
    <div className="recording-controls">
      {exportSequenceLabel && <div className="pane-note">{exportSequenceLabel}</div>}
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
          <span className="field-label">方式</span>
          <select
            className="input"
            value={pipeline.kind}
            disabled={isBusy || exportFormat === "mov"}
            title={exportFormat === "mov" ? "MOV 只能逐帧渲染" : undefined}
            onChange={(event) => setExportMethod(event.target.value as VideoExportMethod)}
          >
            <option value="record" disabled={!recordingSupport.supported}>
              {recordingSupport.supported ? "实时录制" : "实时录制（不支持）"}
            </option>
            <option value="frames">逐帧渲染</option>
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
            <option value="live2d-only">仅画面</option>
            <option value="subtitle-only">仅文字</option>
          </select>
        </label>

        <label className="field-stack">
          <span className="field-label">帧率</span>
          {projectFps ? <input className="input" aria-label="序列帧率" value={`${projectFps} fps`} readOnly /> : <select
            className="input"
            value={recordingQuality}
            disabled={isBusy}
            onChange={(event) => setRecordingQuality(event.target.value as "low" | "medium" | "high")}
          >
            <option value="low">24 fps</option>
            <option value="medium">30 fps</option>
            <option value="high">60 fps</option>
          </select>}
        </label>
      </div>

      {pipeline.note && <div className="pane-note">{pipeline.note}</div>}

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
          音频
        </label>
      </div>

      <label className="field-stack"><span>范围</span><select className="input" aria-label="导出范围" value={useMarkedExportRange&&exportRangeAvailable?"range":"all"} disabled={isBusy} onChange={event=>setUseMarkedExportRange?.(event.target.value==="range")}><option value="all">整个序列</option><option value="range" disabled={!exportRangeAvailable}>I/O 选区</option></select></label>{pipeline.kind==="frames"&&estimatedStorageBytes!=null&&<p className="pane-note">临时帧上限约 {(estimatedStorageBytes/1024**3).toFixed(2)} GiB · PNG 压缩后通常更小</p>}
      <button
        onClick={() => onExportVideo(exportFormat, exportMode, includeAudio, pipeline.kind)}
        disabled={isBusy}
        className="export-video-button"
      >
        {isBusy ? (exportPhase === "record" ? "正在录制…" : "正在导出…") : "导出视频"}
      </button>

      {isBusy ? (
        <div className="recording-progress" aria-live="polite">
          <div>
            {exportPhase === "record" ? "实时录制" : exportProgress >= 85 ? "编码视频" : "渲染画面"} · {exportTime.toFixed(1)} 秒
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
          {(
            <button onClick={onCancelExport} className="download-button" style={{ marginTop: 6 }}>
              {exportPhase==="record"?"取消录制":"取消导出"}
            </button>
          )}
        </div>
      ) : null}

      <div className="button-grid">
        <button onClick={onExportSubtitlesSrt} disabled={isBusy} className="download-button">
          导出 SRT
        </button>
        <button onClick={onTakeScreenshot} disabled={isBusy} className="screenshot-button">
          截图
        </button>
        {!projectFps && <button onClick={onTakePartsScreenshots} disabled={isBusy} className="parts-screenshot-button">
          部件截图
        </button>}
      </div>
    </div>
  );
}
