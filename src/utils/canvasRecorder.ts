/**
 * WebM 实时录制工具。
 *
 * 与「逐帧 PNG → ffmpeg」的离线路径互补：
 * - 实时录制把画布流（canvas.captureStream）直接交给 MediaRecorder，几乎不占磁盘、导出快；
 * - 但录制拿不到透明通道，所以勾选「透明背景」时必须回退到逐帧渲染。
 * macOS 的 WKWebView 对 MediaRecorder + video/webm 的支持并不一致，因此这里做能力探测，调用方据此降级。
 */

/** 依次尝试的 WebM 编码串，带 opus 的组合优先，保证音频也能进同一个容器。 */
export const WEBM_MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
] as const;

export type WebmRecordingSupport = {
  supported: boolean;
  mimeType: string | null;
  /** 不支持时的中文原因，可直接展示给用户；支持时为 null。 */
  reason: string | null;
};

/** 录制环境快照，单测可注入而无需真实的 MediaRecorder / canvas。 */
export type RecordingEnvironment = {
  hasMediaRecorder: boolean;
  hasCaptureStream: boolean;
  isTypeSupported: ((mimeType: string) => boolean) | null;
};

export function pickWebmMimeType(isTypeSupported: (mimeType: string) => boolean): string | null {
  for (const mimeType of WEBM_MIME_CANDIDATES) {
    try {
      if (isTypeSupported(mimeType)) return mimeType;
    } catch {
      // 某些实现对不认识的编码串会抛错，继续尝试下一个
    }
  }
  return null;
}

function inspectEnvironment(): RecordingEnvironment {
  const recorder = typeof MediaRecorder === "undefined" ? null : MediaRecorder;
  const canvasPrototype =
    typeof HTMLCanvasElement === "undefined"
      ? null
      : (HTMLCanvasElement.prototype as HTMLCanvasElement & { captureStream?: unknown });
  return {
    hasMediaRecorder: recorder !== null,
    hasCaptureStream: typeof canvasPrototype?.captureStream === "function",
    isTypeSupported:
      recorder && typeof recorder.isTypeSupported === "function"
        ? (mimeType: string) => recorder.isTypeSupported(mimeType)
        : null,
  };
}

export function detectWebmRecordingSupport(env: RecordingEnvironment = inspectEnvironment()): WebmRecordingSupport {
  if (!env.hasMediaRecorder) {
    return { supported: false, mimeType: null, reason: "当前环境不支持实时录制（MediaRecorder）" };
  }
  if (!env.hasCaptureStream) {
    return { supported: false, mimeType: null, reason: "当前环境不支持画布捕获（canvas.captureStream）" };
  }
  const mimeType = env.isTypeSupported ? pickWebmMimeType(env.isTypeSupported) : "video/webm";
  if (!mimeType) {
    return { supported: false, mimeType: null, reason: "当前环境不支持 WebM 编码" };
  }
  return { supported: true, mimeType, reason: null };
}

let cachedSupport: WebmRecordingSupport | null = null;

/** 进程内缓存的环境探测结果（分辨率/帧率变化不影响结论）。 */
export function getWebmRecordingSupport(): WebmRecordingSupport {
  if (!cachedSupport) cachedSupport = detectWebmRecordingSupport();
  return cachedSupport;
}

/** 粗略码率：约 0.15 bit/像素/帧，限制在 4–50 Mbps。 */
export function estimateRecordingVideoBitrate(width: number, height: number, fps: number): number {
  const pixels = Math.max(1, Math.round(width)) * Math.max(1, Math.round(height));
  const frames = Math.max(1, Math.round(fps));
  const target = pixels * frames * 0.15;
  return Math.round(Math.min(50_000_000, Math.max(4_000_000, target)));
}

/** 只依赖 captureStream，便于单测传入假画布。 */
export type RecordableCanvas = {
  captureStream?: (frameRequestRate?: number) => MediaStream;
};

export type CanvasStreamRecorderOptions = {
  canvas: RecordableCanvas;
  fps: number;
  /** MediaRecorder 使用，由 getWebmRecordingSupport 探测得到。 */
  mimeType: string;
  videoBitsPerSecond?: number;
  audioBitsPerSecond?: number;
  /** 音频轨道来源，通常传 AudioManager 的 recordingDestinationRef.current.stream。 */
  audioStream?: MediaStream | null;
  timesliceMs?: number;
};

export type CanvasStreamRecorder = {
  /** 实际使用的编码串。 */
  readonly mimeType: string;
  start: () => void;
  /** 结束并返回录到的数据。 */
  stop: () => Promise<Blob>;
  /** 放弃本次录制（丢弃数据，不产生文件）。 */
  cancel: () => void;
  getElapsedMs: () => number;
  getBytes: () => number;
};

const DEFAULT_TIMESLICE_MS = 250;
const DEFAULT_AUDIO_BITRATE = 192_000;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function releaseStream(stream: MediaStream, extraTracks: MediaStreamTrack[]): void {
  for (const track of extraTracks) {
    try {
      track.stop();
    } catch {
      // 轨道可能已被浏览器回收
    }
  }
  for (const track of stream.getVideoTracks?.() ?? []) {
    try {
      track.stop();
    } catch {
      // 同上
    }
  }
}

/**
 * 把画布（可选地叠加音频）录进内存，stop() 时一次性返回 WebM Blob。
 * 调用方负责把时间线推进到与真实时间一致，录制器本身不驱动播放。
 */
export function createCanvasStreamRecorder(options: CanvasStreamRecorderOptions): CanvasStreamRecorder {
  const { canvas, mimeType } = options;
  const fps = Math.max(1, Math.round(options.fps) || 30);
  if (typeof canvas.captureStream !== "function") {
    throw new Error("当前环境不支持画布捕获（canvas.captureStream），请改用逐帧渲染。");
  }
  if (typeof MediaRecorder === "undefined") {
    throw new Error("当前环境不支持实时录制（MediaRecorder），请改用逐帧渲染。");
  }

  const stream = canvas.captureStream(fps);
  const clonedTracks: MediaStreamTrack[] = [];
  if (options.audioStream && typeof stream.addTrack === "function") {
    for (const track of options.audioStream.getAudioTracks?.() ?? []) {
      const clone = track.clone();
      stream.addTrack(clone);
      clonedTracks.push(clone);
    }
  }

  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, {
      mimeType,
      ...(options.videoBitsPerSecond ? { videoBitsPerSecond: Math.round(options.videoBitsPerSecond) } : {}),
      ...(options.audioStream ? { audioBitsPerSecond: options.audioBitsPerSecond ?? DEFAULT_AUDIO_BITRATE } : {}),
    });
  } catch (error) {
    releaseStream(stream, clonedTracks);
    throw new Error(`无法启动实时录制：${describeError(error)}`);
  }

  const chunks: Blob[] = [];
  let discarding = false;
  let startedAt = 0;
  let elapsedMs = 0;
  let settled = false;

  recorder.ondataavailable = (event: BlobEvent) => {
    if (discarding) return;
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };

  const finish = (): Blob => {
    elapsedMs = startedAt ? Date.now() - startedAt : 0;
    const blob = new Blob(chunks, { type: mimeType });
    releaseStream(stream, clonedTracks);
    return blob;
  };

  return {
    mimeType,
    start: () => {
      if (settled) throw new Error("录制已结束，无法重新开始。");
      startedAt = Date.now();
      recorder.start(options.timesliceMs ?? DEFAULT_TIMESLICE_MS);
    },
    stop: () =>
      new Promise<Blob>((resolve, reject) => {
        if (settled) {
          resolve(new Blob(chunks, { type: mimeType }));
          return;
        }
        settled = true;
        recorder.onstop = () => {
          if (discarding) {
            releaseStream(stream, clonedTracks);
            resolve(new Blob([], { type: mimeType }));
            return;
          }
          resolve(finish());
        };
        recorder.onerror = (event: Event) => {
          releaseStream(stream, clonedTracks);
          const error = (event as unknown as { error?: DOMException }).error;
          reject(new Error(`实时录制失败：${error ? describeError(error) : "未知错误"}`));
        };
        try {
          if (typeof recorder.requestData === "function") recorder.requestData();
        } catch {
          // requestData 不是所有实现都支持，stop() 自身会补最后一个分片
        }
        try {
          if (recorder.state === "inactive") {
            const handler = recorder.onstop as ((event: Event) => void) | null;
            if (handler) handler(new Event("stop"));
            return;
          }
          recorder.stop();
        } catch (error) {
          reject(new Error(`实时录制失败：${describeError(error)}`));
        }
      }),
    cancel: () => {
      discarding = true;
      chunks.length = 0;
      if (!settled) {
        settled = true;
        recorder.onstop = () => releaseStream(stream, clonedTracks);
      }
      try {
        if (recorder.state !== "inactive") recorder.stop();
        else releaseStream(stream, clonedTracks);
      } catch {
        releaseStream(stream, clonedTracks);
      }
    },
    getElapsedMs: () => (startedAt ? elapsedMs || Date.now() - startedAt : 0),
    getBytes: () => chunks.reduce((total, chunk) => total + chunk.size, 0),
  };
}
