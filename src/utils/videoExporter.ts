import { invoke } from "@tauri-apps/api/core";
import { appCacheDir, join } from "@tauri-apps/api/path";
import { mkdir, remove, stat, writeFile } from "@tauri-apps/plugin-fs";
import type { AudioGainEnvelope } from "../sequence/audio";

export type VideoExportFormat = "webm" | "mov";
export type VideoExportMode = "all" | "subtitle-only" | "live2d-only";

export type AudioTrack = {
  id: string;
  start: number;
  duration: number;
  sourceDuration?: number;
  sourceIn?: number;
  playbackRate?: number;
  gain?: number;
  fadeIn?: number;
  fadeOut?: number;
  muted?: boolean;
  preservePitch?: boolean;
  gainEnvelopes?: AudioGainEnvelope[];
  audioUrl?: string;
  audioPath?: string;
};

type ProgressPayload = {
  frameIndex: number;
  totalFrames: number;
  timeSec: number;
};

type VideoExportParams = {
  canvas: HTMLCanvasElement;
  outputPath: string;
  format: VideoExportFormat;
  fps: number;
  targetFrameCount: number;
  applyTimelineAtTime: (timeSec: number, offline: boolean) => void | Promise<void>;
  renderFrame: () => void;
  audioTracks: AudioTrack[];
  includeAudio: boolean;
  startTime?: number;
  signal?: AbortSignal;
  onPhase?: (phase:VideoExportPhase)=>void;
  onProgress?: (payload: ProgressPayload) => void;
};

export type AudioManifestItem = {
  id: string;
  path: string;
  startSec: number;
  durationSec: number;
  sourceInSec: number;
  playbackRate: number;
  gain: number;
  fadeInSec: number;
  fadeOutSec: number;
  gainEnvelopes?: AudioGainEnvelope[];
  preservePitch?: boolean;
};

const blobFromCanvas = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("canvas.toBlob failed"));
        return;
      }
      resolve(blob);
    }, "image/png");
  });

const isBlobUrl = (url: string) => /^blob:/i.test(url);

export function buildAudioManifest(audioTracks: AudioTrack[], _fps: number): AudioManifestItem[] {
  void _fps; // Preserve callers that pass FPS; nested audio keeps subframe timing.
  const manifest: AudioManifestItem[] = [];

  for (const track of audioTracks) {
    if (track.muted) continue;
    if (![track.start, track.duration, track.sourceIn ?? 0, track.gain ?? 1, track.fadeIn ?? 0, track.fadeOut ?? 0].every(Number.isFinite)) {
      throw new Error(`音频片段“${track.id}”的时间或音量无效。`);
    }
    const start = Math.max(0, Number(track.start) || 0);
    const rate = track.playbackRate ?? 1;
    if (!Number.isFinite(rate) || rate <= 0) throw new Error(`音频片段“${track.id}”的播放速率无效。`);
    if (track.sourceDuration != null && (!Number.isFinite(track.sourceDuration) || track.sourceDuration < 0)) throw new Error(`音频片段“${track.id}”的素材时长无效。`);
    for (const envelope of track.gainEnvelopes ?? []) {
      if (![envelope.gain, envelope.fadeInStart, envelope.fadeInDuration, envelope.fadeOutStart, envelope.fadeOutDuration].every(Number.isFinite)
        || envelope.fadeInDuration < 0 || envelope.fadeOutDuration < 0 || envelope.keys.some(key => !Number.isFinite(key.time) || !Number.isFinite(key.value))) {
        throw new Error(`音频片段“${track.id}”的音量曲线无效。`);
      }
    }
    const sourceIn = Math.max(0, Number(track.sourceIn) || 0);
    const available = track.sourceDuration == null ? Infinity : Math.max(0, (track.sourceDuration - sourceIn) / rate);
    const duration = Math.min(Math.max(0, Number(track.duration) || 0), available);
    if (duration <= 0) continue;

    const source = (track.audioPath && track.audioPath.trim().length > 0)
      ? track.audioPath
      : (track.audioUrl && !isBlobUrl(track.audioUrl) ? track.audioUrl : "");
    if (!source) throw new Error(`音频片段“${track.id}”缺少可读取的素材文件，请重新链接素材。`);

    manifest.push({
      id: track.id,
      path: source,
      // Nested rates can map frame-aligned cuts to subframe positions. Preserve
      // the shared audio schedule exactly rather than snapping it a second time.
      startSec: start,
      durationSec: duration,
      sourceInSec: sourceIn,
      playbackRate: rate,
      gain: Math.max(0, Math.min(4, Number(track.gain ?? 1))),
      fadeInSec: Math.max(0, Math.min(duration, Number(track.fadeIn) || 0)),
      fadeOutSec: Math.max(0, Math.min(duration, Number(track.fadeOut) || 0)),
      gainEnvelopes: track.gainEnvelopes,
      preservePitch: track.preservePitch,
    });
  }

  return manifest;
}

/**
 * 导出方式：
 * - `record` 实时录制画布流（仅 WebM），几乎不占磁盘、速度快，但拿不到透明通道；
 * - `frames` 逐帧 PNG 落盘交给 ffmpeg 编码，慢且吃磁盘，但 WebM/MOV 都能保留 alpha。
 */
export type VideoExportMethod = "record" | "frames";

/** 导出进行中的阶段：render 逐帧渲染、encode ffmpeg 编码、record 实时录制。 */
export type VideoExportPhase = "render" | "encode" | "record";

export type ExportPipeline = {
  kind: VideoExportMethod;
  format: VideoExportFormat;
  /** 与用户选择不一致时的降级说明，直接展示在导出面板；无降级时为 null。 */
  note: string | null;
};

/**
 * 决定实际走哪条导出管线。用户的「方式」选择优先，但以下情况强制逐帧：
 * MOV（ProRes 4444 + alpha 只能由 ffmpeg 产出）、勾选透明背景、当前环境不支持 WebM 录制。
 */
export function resolveExportPipeline(input: {
  format: VideoExportFormat;
  method: VideoExportMethod;
  transparentBg: boolean;
  recordingSupported: boolean;
}): ExportPipeline {
  const { format, method, transparentBg, recordingSupported } = input;
  if (method === "frames") return { kind: "frames", format, note: null };
  if (format === "mov") {
    return { kind: "frames", format, note: "MOV 需要逐帧渲染才能保留 ProRes 4444 与透明通道，已改用逐帧渲染。" };
  }
  if (transparentBg) {
    return { kind: "frames", format, note: "透明背景需要逐帧渲染（PNG → WebM），已改用逐帧渲染。" };
  }
  if (!recordingSupported) {
    return { kind: "frames", format, note: "当前环境不支持 WebM 实时录制，已改用逐帧渲染（PNG → WebM）。" };
  }
  return { kind: "record", format, note: null };
}

export async function runVideoExport(params: VideoExportParams): Promise<{
  duration: number;
  frameCount: number;
}> {
  const safeFps = Math.max(1, params.fps);
  const totalFrames = Math.max(1, Math.round(params.targetFrameCount));
  const manifest = params.includeAudio ? buildAudioManifest(params.audioTracks, safeFps) : [];
  for (const item of manifest) {
    if (/^https?:\/\//i.test(item.path)) continue;
    try {
      if (!(await stat(item.path)).isFile) throw new Error("not a file");
    } catch { throw new Error(`找不到导出音频素材，请重新链接：${item.path}`); }
  }
  const cache = await appCacheDir();
  const stamp = Date.now();
  const frameDir = await join(cache, `offline-frames-${stamp}-${crypto.randomUUID()}`);
  const pattern = "frame-%06d.png";

  await mkdir(frameDir, { recursive: true });
  const jobId=crypto.randomUUID();
  const cancelled=()=>{if(params.signal?.aborted)throw new DOMException("导出已取消","AbortError");};
  const cancelEncode=()=>{void invoke("cancel_video_export",{jobId}).catch(()=>{});};

  try {
    for (let i = 0; i < totalFrames; i += 1) {
      cancelled();
      const t = (params.startTime??0) + i / safeFps;
      await params.applyTimelineAtTime(t, true);
      cancelled();
      params.renderFrame();

      const png = await blobFromCanvas(params.canvas);
      const frameName = `frame-${String(i + 1).padStart(6, "0")}.png`;
      const framePath = await join(frameDir, frameName);
      await writeFile(framePath, new Uint8Array(await png.arrayBuffer()));

      params.onProgress?.({
        frameIndex: i + 1,
        totalFrames,
        timeSec: t,
      });
    }

    params.onProgress?.({ frameIndex: totalFrames, totalFrames, timeSec: totalFrames / safeFps });
    cancelled();params.onPhase?.("encode");
    params.signal?.addEventListener("abort",cancelEncode,{once:true});
    await invoke("encode_png_sequence_to_video", {
      jobId,
      frameDir,
      pattern,
      outputPath: params.outputPath,
      format: params.format,
      fps: safeFps,
      targetDurationSec: totalFrames / safeFps,
      audioManifestJson: manifest.length > 0 ? JSON.stringify(manifest) : null,
    });
    cancelled();

    return {
      duration: totalFrames / safeFps,
      frameCount: totalFrames,
    };
  } finally {
    params.signal?.removeEventListener("abort",cancelEncode);
    try { await remove(frameDir, { recursive: true }); } catch { /* 帧目录清理失败不阻断 */ }
  }
}
