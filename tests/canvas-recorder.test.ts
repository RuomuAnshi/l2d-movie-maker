import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WEBM_MIME_CANDIDATES,
  createCanvasStreamRecorder,
  detectWebmRecordingSupport,
  estimateRecordingVideoBitrate,
  getWebmRecordingSupport,
  pickWebmMimeType,
} from "../src/utils/canvasRecorder";
import type { RecordableCanvas } from "../src/utils/canvasRecorder";

type FakeTrack = {
  kind: string;
  stopped: boolean;
  stop: () => void;
  clone: () => FakeTrack;
};

type FakeStream = {
  tracks: FakeTrack[];
  added: FakeTrack[];
  getVideoTracks: () => FakeTrack[];
  getAudioTracks: () => FakeTrack[];
  addTrack: (track: FakeTrack) => void;
};

type FakeRecorder = {
  options: { mimeType?: string; videoBitsPerSecond?: number; audioBitsPerSecond?: number };
  state: string;
  startedTimeslice: number | null;
  requestDataCalls: number;
  emit: (data: Blob) => void;
};

const makeTrack = (kind: string): FakeTrack => {
  const track: FakeTrack = {
    kind,
    stopped: false,
    stop() { track.stopped = true; },
    clone() { return makeTrack(kind); },
  };
  return track;
};

const makeStream = (tracks: FakeTrack[]): FakeStream => {
  const stream: FakeStream = {
    tracks: [...tracks],
    added: [],
    getVideoTracks() { return stream.tracks.filter(t => t.kind === "video"); },
    getAudioTracks() { return stream.tracks.filter(t => t.kind === "audio"); },
    addTrack(track) { stream.added.push(track); stream.tracks.push(track); },
  };
  return stream;
};

let recorderInstances: FakeRecorder[] = [];

const installFakeMediaRecorder = (options: { support?: (mime: string) => boolean; fail?: boolean } = {}) => {
  recorderInstances = [];
  const support = options.support ?? ((mime: string) => mime.startsWith("video/webm"));
  class FakeMediaRecorder {
    static isTypeSupported(mime: string) { return support(mime); }
    state = "inactive";
    options: FakeRecorder["options"];
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    startedTimeslice: number | null = null;
    requestDataCalls = 0;
    constructor(_stream: unknown, recorderOptions: FakeRecorder["options"] = {}) {
      if (options.fail) throw new Error("构造失败");
      this.options = recorderOptions;
      recorderInstances.push(this);
    }
    start(timeslice?: number) { this.state = "recording"; this.startedTimeslice = timeslice ?? null; }
    requestData() { this.requestDataCalls += 1; }
    stop() {
      this.state = "inactive";
      if (typeof this.onstop === "function") this.onstop(new Event("stop"));
    }
    emit(data: Blob) {
      if (typeof this.ondataavailable === "function") this.ondataavailable({ data });
    }
  }
  Object.defineProperty(globalThis, "MediaRecorder", { value: FakeMediaRecorder, configurable: true, writable: true });
};

const uninstallFakeMediaRecorder = () => { Reflect.deleteProperty(globalThis, "MediaRecorder"); };

test("node environment reports no MediaRecorder and caches the probe result", () => {
  uninstallFakeMediaRecorder();
  const support = getWebmRecordingSupport();
  assert.equal(support.supported, false);
  assert.match(support.reason ?? "", /MediaRecorder/);
  assert.equal(getWebmRecordingSupport(), support);
});

test("pickWebmMimeType prefers vp9+opus and skips unsupported or throwing codecs", () => {
  assert.equal(pickWebmMimeType(() => true), WEBM_MIME_CANDIDATES[0]);
  assert.equal(pickWebmMimeType(mime => mime === "video/webm;codecs=vp8"), "video/webm;codecs=vp8");
  assert.equal(pickWebmMimeType(mime => {
    if (mime.includes("vp9")) throw new Error("unsupported codec string");
    return mime === "video/webm;codecs=vp8,opus";
  }), "video/webm;codecs=vp8,opus");
  assert.equal(pickWebmMimeType(() => false), null);
});

test("detectWebmRecordingSupport explains every unsupported environment", () => {
  assert.deepEqual(detectWebmRecordingSupport({ hasMediaRecorder: false, hasCaptureStream: true, isTypeSupported: null }), {
    supported: false, mimeType: null, reason: "当前环境不支持实时录制（MediaRecorder）",
  });
  assert.deepEqual(detectWebmRecordingSupport({ hasMediaRecorder: true, hasCaptureStream: false, isTypeSupported: null }), {
    supported: false, mimeType: null, reason: "当前环境不支持画布捕获（canvas.captureStream）",
  });
  assert.deepEqual(detectWebmRecordingSupport({ hasMediaRecorder: true, hasCaptureStream: true, isTypeSupported: () => false }), {
    supported: false, mimeType: null, reason: "当前环境不支持 WebM 编码",
  });
  assert.deepEqual(detectWebmRecordingSupport({ hasMediaRecorder: true, hasCaptureStream: true, isTypeSupported: mime => mime === "video/webm;codecs=vp8" }), {
    supported: true, mimeType: "video/webm;codecs=vp8", reason: null,
  });
  assert.deepEqual(detectWebmRecordingSupport({ hasMediaRecorder: true, hasCaptureStream: true, isTypeSupported: null }), {
    supported: true, mimeType: "video/webm", reason: null,
  });
});

test("estimateRecordingVideoBitrate clamps to 4-50 Mbps", () => {
  assert.equal(estimateRecordingVideoBitrate(320, 240, 24), 4_000_000);
  assert.equal(estimateRecordingVideoBitrate(1920, 1080, 30), Math.round(1920 * 1080 * 30 * 0.15));
  assert.equal(estimateRecordingVideoBitrate(3840, 2160, 60), 50_000_000);
  assert.equal(estimateRecordingVideoBitrate(0, 0, 0), 4_000_000);
});

test("canvas recorder merges cloned audio into the canvas stream and returns one webm blob", async () => {
  installFakeMediaRecorder();
  const videoTrack = makeTrack("video");
  const canvasStream = makeStream([videoTrack]);
  const audioTrack = makeTrack("audio");
  const capturedFps: number[] = [];
  const canvas = { captureStream(fps: number) { capturedFps.push(fps); return canvasStream; } };
  try {
    const recorder = createCanvasStreamRecorder({
      canvas: canvas as unknown as RecordableCanvas, fps: 24, mimeType: "video/webm;codecs=vp9,opus",
      videoBitsPerSecond: 9_000_000, audioStream: makeStream([audioTrack]) as unknown as MediaStream,
    });
    assert.equal(recorder.mimeType, "video/webm;codecs=vp9,opus");
    assert.deepEqual(capturedFps, [24]);

    const fake = recorderInstances[0];
    assert.equal(fake.options.mimeType, "video/webm;codecs=vp9,opus");
    assert.equal(fake.options.videoBitsPerSecond, 9_000_000);
    assert.equal(fake.options.audioBitsPerSecond, 192_000);
    assert.equal(canvasStream.added.length, 1);
    assert.notEqual(canvasStream.added[0], audioTrack);
    assert.equal(canvasStream.added[0].kind, "audio");

    recorder.start();
    assert.equal(fake.startedTimeslice, 250);
    fake.emit(new Blob(["hello-"]));
    fake.emit(new Blob(["world"]));
    assert.equal(recorder.getBytes(), 11);

    const blob = await recorder.stop();
    assert.equal(fake.requestDataCalls, 1);
    assert.equal(blob.type, "video/webm;codecs=vp9,opus");
    assert.equal(await blob.text(), "hello-world");
    assert.equal(videoTrack.stopped, true);
    assert.equal(canvasStream.added[0].stopped, true);
    assert.equal(audioTrack.stopped, false);
  } finally {
    uninstallFakeMediaRecorder();
  }
});

test("stop without start settles immediately instead of hanging", async () => {
  installFakeMediaRecorder();
  const canvas = { captureStream: () => makeStream([makeTrack("video")]) };
  try {
    const recorder = createCanvasStreamRecorder({ canvas: canvas as unknown as RecordableCanvas, fps: 30, mimeType: "video/webm" });
    const blob = await recorder.stop();
    assert.equal(blob.size, 0);
    assert.equal((await recorder.stop()).size, 0);
  } finally {
    uninstallFakeMediaRecorder();
  }
});

test("cancel discards captured chunks and ignores late data", () => {
  installFakeMediaRecorder();
  const canvas = { captureStream: () => makeStream([makeTrack("video")]) };
  try {
    const recorder = createCanvasStreamRecorder({ canvas: canvas as unknown as RecordableCanvas, fps: 30, mimeType: "video/webm" });
    recorder.start();
    const fake = recorderInstances[0];
    fake.emit(new Blob(["data"]));
    assert.equal(recorder.getBytes(), 4);

    recorder.cancel();
    assert.equal(recorder.getBytes(), 0);
    assert.equal(fake.state, "inactive");
    fake.emit(new Blob(["late"]));
    assert.equal(recorder.getBytes(), 0);
  } finally {
    uninstallFakeMediaRecorder();
  }
});

test("recorder rejects environments without captureStream or MediaRecorder", () => {
  installFakeMediaRecorder();
  try {
    assert.throws(() => createCanvasStreamRecorder({ canvas: {}, fps: 30, mimeType: "video/webm" }), /画布捕获/);
    uninstallFakeMediaRecorder();
    const canvas = { captureStream: () => makeStream([]) };
    assert.throws(
      () => createCanvasStreamRecorder({ canvas: canvas as unknown as RecordableCanvas, fps: 30, mimeType: "video/webm" }),
      /实时录制/,
    );
  } finally {
    uninstallFakeMediaRecorder();
  }
});

test("recorder releases tracks when MediaRecorder construction fails", () => {
  installFakeMediaRecorder({ fail: true });
  const videoTrack = makeTrack("video");
  const canvasStream = makeStream([videoTrack]);
  const audioTrack = makeTrack("audio");
  const canvas = { captureStream: () => canvasStream };
  try {
    assert.throws(() => createCanvasStreamRecorder({
      canvas: canvas as unknown as RecordableCanvas, fps: 30, mimeType: "video/webm",
      audioStream: makeStream([audioTrack]) as unknown as MediaStream,
    }), /无法启动实时录制/);
    assert.equal(videoTrack.stopped, true);
    assert.equal(canvasStream.added[0].stopped, true);
    assert.equal(audioTrack.stopped, false);
  } finally {
    uninstallFakeMediaRecorder();
  }
});
