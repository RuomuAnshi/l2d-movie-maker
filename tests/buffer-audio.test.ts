import { test } from "node:test";
import assert from "node:assert/strict";
import AudioManager from "../src/components/AudioManager";

class AudioParamMock {
  value = 0;
  setValueAtTime(value: number) { this.value = value; }
}
class GainMock {
  gain = new AudioParamMock();
  connections: unknown[] = [];
  connect(target: unknown) { this.connections.push(target); }
  disconnect() { this.connections = []; }
}
class SourceMock {
  buffer: unknown;
  playbackRate = new AudioParamMock();
  onended: (() => void) | null = null;
  starts: number[][] = [];
  stopCount = 0;
  connect() {}
  disconnect() {}
  start(...arguments_: number[]) { this.starts.push(arguments_); }
  stop() { this.stopCount++; }
}
class AudioContextMock {
  currentTime = 0;
  state = "running";
  destination = {};
  sources: SourceMock[] = [];
  gains: GainMock[] = [];
  decodeCount = 0;
  createMediaStreamDestination() { return {}; }
  async decodeAudioData() { this.decodeCount++; return { duration: 12, sampleRate: 48000 }; }
  createBufferSource() { const source = new SourceMock(); this.sources.push(source); return source; }
  createGain() { const gain = new GainMock(); this.gains.push(gain); return gain; }
}

test("decoded cache is shared while nested instances have independent sources, rate, gain and source cuts", async () => {
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  let fetchCount = 0;
  Object.assign(globalThis, { window: { AudioContext: AudioContextMock }, fetch: async () => { fetchCount++; return new Response(new Uint8Array([1, 2])); } });
  try {
    const manager = AudioManager({ modelRef: { current: null }, audioClips: [], setCurrentAudioLevel: () => {} });
    const first = manager.prepareAudioBuffer("asset", "/sound.wav");
    const reused = manager.prepareAudioBuffer("asset", "/sound.wav");
    assert.equal(first, reused);
    const buffer = await first;
    assert.equal(fetchCount, 1);
    assert.equal(manager.getDecodedAudioBuffer("asset"), buffer);
    const context = manager.audioContextRef.current as unknown as AudioContextMock;
    const a = { id: "nested/A/audio", assetId: "asset", sourceTime: 1, rate: 16, gain: 8, active: true, remainingDuration: 0.5 };
    const b = { id: "nested/B/audio", assetId: "asset", sourceTime: 4, rate: 0.5, gain: 0.25, active: true, remainingDuration: 4 };
    manager.syncBufferAudio([a, b], true);
    assert.equal(context.sources.length, 2);
    assert.equal(context.sources[0].buffer, context.sources[1].buffer);
    assert.deepEqual(context.sources[0].starts[0], [0, 1, 8]);
    assert.deepEqual(context.sources[1].starts[0], [0, 4, 2]);
    assert.equal(context.sources[0].playbackRate.value, 16);
    assert.equal(context.gains[0].gain.value, 8, "nested gain is not clamped at 4");
    context.currentTime = 0.2;
    manager.syncBufferAudio([{ ...a, sourceTime: 4.2, gain: 16, remainingDuration: 0.3 }, { ...b, sourceTime: 4.1, remainingDuration: 3.8 }], true);
    assert.equal(context.sources.length, 2, "normal clock progress reuses both sources");
    assert.equal(context.gains[0].gain.value, 16);
    manager.syncBufferAudio([{ ...a, sourceTime: 8, remainingDuration: 0.1 }, { ...b, sourceTime: 4.1, remainingDuration: 3.8 }], true);
    assert.equal(context.sources.length, 3, "a seek replaces only the affected instance");
    assert.equal(context.sources[0].stopCount, 1);
    assert.equal(context.sources[1].stopCount, 0);
    manager.syncBufferAudio([], false);
    assert.equal(context.sources[1].stopCount, 1);
    assert.equal(context.sources[2].stopCount, 1);
    assert.equal(manager.getDecodedAudioBuffer("asset"), buffer);
    manager.cleanupAudio();
    assert.equal(manager.getDecodedAudioBuffer("asset"), undefined);
  } finally { Object.assign(globalThis, { window: previousWindow, fetch: previousFetch }); }
});

test("buffer scheduler pauses HTML playback, handles source completion, and replaces changed asset URLs", async () => {
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  Object.assign(globalThis, { window: { AudioContext: AudioContextMock }, fetch: async () => new Response(new Uint8Array([1])) });
  try {
    const manager = AudioManager({ modelRef: { current: null }, audioClips: [], setCurrentAudioLevel: () => {} });
    await manager.prepareAudioBuffer("asset", "/old.wav");
    let pauses = 0;
    manager.audioRefs.current.set("legacy", { paused: false, pause() { pauses++; }, src: "", currentTime: 0 } as HTMLAudioElement);
    const item = { id: "audio", assetId: "asset", sourceTime: 0, rate: 1, gain: 1, active: true };
    manager.syncBufferAudio([item], true);
    assert.equal(pauses, 1);
    const context = manager.audioContextRef.current as unknown as AudioContextMock;
    const original = context.sources[0];
    await manager.prepareAudioBuffer("asset", "/new.wav");
    manager.syncBufferAudio([item], true);
    assert.equal(original.stopCount, 1);
    assert.equal(context.sources.length, 2);
    manager.syncBufferAudio([{ ...item, sourceTime: 12 }], true);
    assert.equal(context.sources[1].stopCount, 1, "end-of-source never restarts audio");
    manager.stopAllAudio();
    manager.cleanupAudio();
  } finally { Object.assign(globalThis, { window: previousWindow, fetch: previousFetch }); }
});
