import { invoke } from "@tauri-apps/api/core";
import { appCacheDir, join } from "@tauri-apps/api/path";
import { mkdir, remove, writeFile } from "@tauri-apps/plugin-fs";

export type VideoExportFormat = "webm" | "mov";
export type VideoExportMode = "all" | "subtitle-only" | "live2d-only";

type AudioTrack = {
  id: string;
  start: number;
  duration: number;
  sourceDuration?: number;
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

type AudioManifestItem = {
  id: string;
  path: string;
  startSec: number;
  endSec: number;
  gain: number;
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

function buildAudioManifest(audioTracks: AudioTrack[], fps: number): AudioManifestItem[] {
  const safeFps = Math.max(1, Math.round(fps));
  const manifest: AudioManifestItem[] = [];

  for (const track of audioTracks) {
    const start = Math.max(0, Number(track.start) || 0);
    const duration = Math.min(
      Math.max(0, Number(track.duration) || 0),
      Math.max(0, Number(track.sourceDuration ?? track.duration) || 0),
    );
    if (duration <= 0) continue;

    const source = (track.audioPath && track.audioPath.trim().length > 0)
      ? track.audioPath
      : (track.audioUrl && !isBlobUrl(track.audioUrl) ? track.audioUrl : "");
    if (!source) continue;

    // Frame-boundary alignment for stable timeline behavior.
    const alignedStart = Math.round(start * safeFps) / safeFps;
    const alignedEnd = Math.round((start + duration) * safeFps) / safeFps;
    if (alignedEnd <= alignedStart) continue;

    manifest.push({
      id: track.id,
      path: source,
      startSec: alignedStart,
      endSec: alignedEnd,
      gain: 0.8,
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
  const cache = await appCacheDir();
  const stamp = Date.now();
  const frameDir = await join(cache, `offline-frames-${stamp}`);
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

    const manifest = params.includeAudio ? buildAudioManifest(params.audioTracks, safeFps) : [];
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
