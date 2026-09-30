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
    });
  }

  return manifest;
}

export async function runVideoExport(params: VideoExportParams): Promise<{
  duration: number;
  frameCount: number;
}> {
  const safeFps = Math.max(1, Math.round(params.fps));
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

  try {
    for (let i = 0; i < totalFrames; i += 1) {
      const t = i / safeFps;
      await params.applyTimelineAtTime(t, true);
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
    await invoke("encode_png_sequence_to_video", {
      frameDir,
      pattern,
      outputPath: params.outputPath,
      format: params.format,
      fps: safeFps,
      targetDurationSec: totalFrames / safeFps,
      audioManifestJson: manifest.length > 0 ? JSON.stringify(manifest) : null,
    });

    return {
      duration: totalFrames / safeFps,
      frameCount: totalFrames,
    };
  } finally {
    try { await remove(frameDir, { recursive: true }); } catch { /* 帧目录清理失败不阻断 */ }
  }
}
