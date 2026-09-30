import { test } from "node:test";
import assert from "node:assert/strict";
import type { Texture, BaseTexture } from "pixi.js";
import { ModelAdapter, TimelineRenderer } from "../src/animation/runtime";
import { upsertKey } from "../src/animation/engine";
import { emptyAnimation } from "../src/animation/types";
import { getSceneLipAt } from "../src/sequence/sceneAudio";
import { resolveLive2DActorsAt } from "../src/sequence/engine";
import { beginModelResourceLoad, retainModelResources, releaseModelResources } from "../src/sequence/modelResources";
import { createClip, createEditSequence, DEFAULT_TRANSFORM, type ProjectDocument } from "../src/sequence/types";

function fixture(): ProjectDocument {
  const root = createEditSequence(); root.id = "root";
  const doc: ProjectDocument = { version: 3, id: "p", name: "p", assets: {
    model: { id: "model", kind: "live2d", name: "model", uri: "model.model3.json" },
    audio: { id: "audio", kind: "audio", name: "audio", uri: "audio.wav", duration: 6, lipSyncSampleRate: 2, lipSync: [0, .2, .4, .6, .8, 1, .8, .6, .4, .2, 0, 0] },
    external: { id: "external", kind: "audio", name: "external", uri: "external.wav", duration: 6, lipSyncSampleRate: 2, lipSync: new Array(12).fill(.9) },
  }, sequences: { root, live: { id: "live", name: "live", kind: "live2d", width: 1920, height: 1080, fps: 30, duration: 6, animation: emptyAnimation(), actors: [{ id: "actor", assetId: "model", modelPartId: "main", name: "actor", transform: { ...DEFAULT_TRANSFORM }, visible: true }], tracks: [] } }, rootSequenceId: "root", width: 1920, height: 1080, fps: 30, seed: 1, savedAt: "" };
  const live = doc.sequences.live;
  live.tracks.push({ ...createEditSequence().tracks[0], clips: [createClip({ id: "internal-audio", kind: "audio", assetId: "audio", name: "audio", start: 0, duration: 6, lipSyncActorId: "actor", volume: .5 })] });
  return doc;
}

function fakeModel() {
  const parameters = {
    ids: ["ParamAngleX", "ParamMouthOpenY", "ParamPhysics"],
    minimumValues: [-100, 0, -100], maximumValues: [100, 1, 100], defaultValues: [0, 0, 0], values: new Float32Array(3),
  };
  return { autoUpdate: true, deltaTime: 77, internalModel: {
    settings: {}, motionManager: { stopAllMotions() {} },
    coreModel: { parameters, parts: { ids: [], opacities: new Float32Array() }, update() {} },
    physics: { velocity: 0, evaluate(core: { parameters: typeof parameters }, dt: number) {
      this.velocity += dt * (core.parameters.values[0] + core.parameters.values[1] * 10 - this.velocity);
      core.parameters.values[2] = this.velocity;
    } },
  } };
}

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test("shared Live2D paths keep separate adapter values and physics caches across forward/reverse seeks", () => {
  const doc = fixture();
  doc.sequences.root.tracks[0].clips = [
    createClip({ id: "one", kind: "sequence", sequenceId: "live", name: "one", start: 0, duration: 6 }),
  ];
  doc.sequences.root.tracks.push({ ...createEditSequence().tracks[0], order: 1, clips: [createClip({ id: "two", kind: "sequence", sequenceId: "live", name: "two", start: 1, duration: 5, sourceIn: .5, rate: .5 })] });
  const firstModel = fakeModel(), secondModel = fakeModel();
  const adapter1 = new ModelAdapter(firstModel, 0, { characterId: "actor", partId: "main" });
  const adapter2 = new ModelAdapter(secondModel, 0, { characterId: "actor", partId: "main" });
  const animation = { ...emptyAnimation(), tracks: adapter1.tracks.map((track) => track.definition.parameterId === "ParamAngleX" ? upsertKey(upsertKey(track, 0, 0), 6, 60) : track) };
  const live = doc.sequences.live;
  if (live.kind !== "live2d") throw new Error("expected live2d");
  live.animation = animation;
  const instances = new Map([
    [JSON.stringify(["root", "one"]), { renderer: new TimelineRenderer([adapter1]), model: firstModel }],
    [JSON.stringify(["root", "two"]), { renderer: new TimelineRenderer([adapter2]), model: secondModel }],
  ]);
  const lip = getSceneLipAt(doc);
  const seek = (time: number) => {
    for (const actor of resolveLive2DActorsAt(doc, "root", time)) {
      const instance = instances.get(JSON.stringify(actor.sequencePath))!;
      instance.renderer.seek(animation, actor.sourceTime, (t) => lip("live", "actor", t, actor.sequencePath), "audio-v1");
    }
  };
  seek(2.413);
  const first = [...firstModel.internalModel.coreModel.parameters.values];
  const second = [...secondModel.internalModel.coreModel.parameters.values];
  assert.notDeepEqual(first, second);
  for (const time of [5.6, 1.11, 4, 2, 2.413]) seek(time);
  assert.deepEqual([...firstModel.internalModel.coreModel.parameters.values], first);
  assert.deepEqual([...secondModel.internalModel.coreModel.parameters.values], second);
  const fresh = fakeModel(), freshAdapter = new ModelAdapter(fresh, 0, { characterId: "actor", partId: "main" });
  new TimelineRenderer([freshAdapter]).seek(animation, 2.413, (time) => lip("live", "actor", time, ["root", "one"]), "audio-v1");
  assert.deepEqual([...fresh.internalModel.coreModel.parameters.values], first);
  assert.equal(firstModel.autoUpdate, false);
  assert.equal(secondModel.deltaTime, 0);
});

test("internal mouth animation reconstructs before a parent's in-point and ignores its outer volume/mute", () => {
  const doc = fixture();
  doc.sequences.root.tracks[0].muted = true;
  doc.sequences.root.tracks[0].clips = [createClip({ id: "trimmed", kind: "sequence", sequenceId: "live", name: "trimmed", start: 10, duration: 2, sourceIn: 1, rate: 2, volume: 0 })];
  const nested = getSceneLipAt(doc, "root");
  const direct = getSceneLipAt(doc, "live");
  for (const time of [0, .25, .7, 1, 1.3, 2.7]) near(nested("live", "actor", time, ["root", "trimmed"]), direct("live", "actor", time, ["live"]));
  near(nested("live", "actor", .25, ["root", "trimmed"]), .05);
  assert.equal(nested("live", "unbound-actor", .25, ["root", "trimmed"]), 0);
  assert.equal(nested("live", "actor", .25, ["root", "missing"]), 0);
});

test("external lip binding maps through nested rate/source-in and never leaks from a sibling instance", () => {
  const doc = fixture();
  const parent = createEditSequence("parent"); parent.id = "parent";
  parent.tracks[0].clips = [createClip({ id: "model-instance", kind: "sequence", sequenceId: "live", name: "model", start: 1, duration: 4, sourceIn: .5, rate: 2 })];
  parent.tracks.push({ ...createEditSequence().tracks[0], order: 1, clips: [createClip({ id: "external-audio", kind: "audio", assetId: "external", name: "external", start: 2, duration: 1, lipSyncActorId: "actor" })] });
  doc.sequences.parent = parent;
  doc.sequences.root.tracks[0].clips = [createClip({ id: "one", kind: "sequence", sequenceId: "parent", name: "one", start: 0, duration: 5 }), createClip({ id: "two", kind: "sequence", sequenceId: "parent", name: "two", start: 6, duration: 5, sourceIn: 1, rate: .5 })];
  // A separately bound root clip targets the actor through either visible parent instance.
  doc.sequences.root.tracks.push({ ...createEditSequence().tracks[0], order: 1, clips: [createClip({ id: "root-audio", kind: "audio", assetId: "external", name: "external", start: 0, duration: .5, lipSyncActorId: "actor" })] });
  const sampler = getSceneLipAt(doc);
  near(sampler("live", "actor", 2.5, ["root", "one", "model-instance"]), .9);
  near(sampler("live", "actor", 2.5, ["root", "two", "model-instance"]), .9);
  // Same source time outside the ancestor audio range receives only internal audio.
  near(sampler("live", "actor", 1.5, ["root", "one", "model-instance"]), .3);
  assert.equal(sampler("parent", "actor", 1.5, ["root", "one", "model-instance"]), 0);
});

test("deleting one model cannot destroy shared textures or resources used by a pending load", () => {
  let baseDestructions = 0, wrapperDestructions = 0;
  const base = { destroyed: false, destroy() { this.destroyed = true; baseDestructions++; } } as unknown as BaseTexture;
  const wrapper = { baseTexture: base, destroy() { wrapperDestructions++; this.baseTexture = null; } } as unknown as Texture;
  const first = { textures: [wrapper, wrapper] }, second = { textures: [wrapper] };
  retainModelResources(first);
  retainModelResources(first); // Idempotent retention.
  retainModelResources(second);
  releaseModelResources(first);
  assert.equal(baseDestructions, 0);
  const finish = beginModelResourceLoad();
  releaseModelResources(second);
  assert.equal(baseDestructions, 0);
  const pendingModel = { textures: [wrapper] };
  retainModelResources(pendingModel);
  finish(); finish();
  assert.equal(baseDestructions, 0);
  releaseModelResources(pendingModel);
  releaseModelResources(pendingModel);
  assert.equal(baseDestructions, 1);
  assert.equal(wrapperDestructions, 1);
});

test("failed pending model loads eventually free deferred texture cache wrappers", () => {
  let baseDestructions = 0, wrappers = 0;
  const base = { destroyed: false, destroy() { this.destroyed = true; baseDestructions++; } } as unknown as BaseTexture;
  const wrapper = { baseTexture: base, destroy() { wrappers++; this.baseTexture = null; } } as unknown as Texture;
  const first = { textures: [wrapper] };
  retainModelResources(first);
  const finishFirst = beginModelResourceLoad(), finishSecond = beginModelResourceLoad();
  releaseModelResources(first);
  finishFirst();
  assert.equal(baseDestructions, 0);
  finishSecond();
  assert.equal(baseDestructions, 1);
  assert.equal(wrappers, 1);
});
