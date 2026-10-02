/* eslint-disable @typescript-eslint/no-explicit-any */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SceneRuntime } from "../src/sequence/sceneRuntime";
import { createClip, createEditSequence, DEFAULT_TRANSFORM, type ProjectDocument, type Live2DSequence } from "../src/sequence/types";
import { emptyAnimation, targetId } from "../src/animation/types";
import { loadedModels, compositeConfigured, Live2DModel, Texture, RenderTexture, Text, setModelLoader, setImageLoader, resetSceneMocks, makeApp } from "./mocks/scene-compositor";

function fixture(): ProjectDocument {
  const root = createEditSequence(); root.id = "root";
  return { version: 3, id: "p", name: "p", assets: { model: { id: "model", kind: "live2d", name: "model", uri: "https://models/model.model3.json" } }, sequences: { root }, rootSequenceId: root.id, width: 1920, height: 1080, fps: 30, seed: 1, savedAt: "" };
}
function live(id = "live", actorId = "actor"): Live2DSequence {
  return { id, name: id, kind: "live2d", width: 1920, height: 1080, fps: 30, duration: 8, tracks: [], actors: [{ id: actorId, assetId: "model", modelPartId: "main", name: actorId, visible: true, transform: { ...DEFAULT_TRANSFORM } }], animation: { ...emptyAnimation(), tracks: [{ definition: { target: targetId(actorId, "main", "ParamAngleX"), characterId: actorId, partId: "main", parameterId: "ParamAngleX", name: "Angle", group: "Parameters", kind: "parameter", min: -100, max: 100, defaultValue: 0 }, baseValue: 0, animated: true, keys: [{ id: "a", time: 0, value: 0, interpolation: "linear" }, { id: "b", time: 8, value: 80, interpolation: "linear" }] }] } };
}
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-5, `${actual} != ${expected}`);
const callbacks = { resolveAssetUrl: async (asset: any) => asset.uri };
async function settle() { for (let i = 0; i < 10; i++) await Promise.resolve(); }

test("SceneRuntime creates distinct native models per sequence/path and seeks them independently", async () => {
  resetSceneMocks();
  const project = fixture();
  project.sequences.one = live("one", "actor-one");
  project.sequences.two = live("two", "actor-two");
  project.sequences.root.tracks[0].clips = [createClip({ id: "clip-one", kind: "sequence", sequenceId: "one", name: "one", start: 0, duration: 6 })];
  project.sequences.root.tracks.push({ ...createEditSequence().tracks[0], order: 1, clips: [createClip({ id: "clip-two", kind: "sequence", sequenceId: "two", name: "two", start: 0, duration: 6, sourceIn: 1, rate: .5 })] });
  const { app } = makeApp(); const runtime = new SceneRuntime(app as any, project, callbacks);
  try {
    await runtime.seekSceneAt("root", 2.413);
    assert.equal(loadedModels.length, 2);
    assert.notEqual(loadedModels[0].internalModel.coreModel.parameters.values, loadedModels[1].internalModel.coreModel.parameters.values);
    const states = loadedModels.map((model) => [...model.internalModel.coreModel.parameters.values]);
    const values = states.map((state) => state[0]).sort((a, b) => a - b);
    near(values[0], (1 + 2.413 * .5) * 10); near(values[1], 24.13);
    for (const time of [5.5, 0, 3, 1.1, 2.413]) await runtime.seekSceneAt("root", time);
    assert.deepEqual(loadedModels.map((model) => [...model.internalModel.coreModel.parameters.values]), states);
    for (const model of loadedModels) { assert.equal(model.autoUpdate, false); assert.equal(model.deltaTime, 0); assert.equal(model.stopped, true); }
  } finally { runtime.destroy(); }
});

test("SceneRuntime isolates shared compound references and keeps sibling textures alive on deletion", async () => {
  resetSceneMocks(); const project = fixture(); project.sequences.live = live();
  const compound = createEditSequence("compound"); compound.id = "compound";
  compound.tracks[0].clips = [createClip({ id: "inside", kind: "sequence", sequenceId: "live", name: "inside", start: .5, duration: 7 })];
  project.sequences.compound = compound;
  project.sequences.root.tracks[0].clips = [createClip({ id: "first", kind: "sequence", sequenceId: "compound", name: "first", start: 0, duration: 6 })];
  project.sequences.root.tracks.push({ ...createEditSequence().tracks[0], order: 1, clips: [createClip({ id: "second", kind: "sequence", sequenceId: "compound", name: "second", start: 2, duration: 4, sourceIn: 1, rate: 2 })] });
  const { app } = makeApp(); const runtime = new SceneRuntime(app as any, project, callbacks);
  try {
    await runtime.seekSceneAt("root", 2.75);
    assert.equal(loadedModels.length, 2);
    assert.notEqual(loadedModels[0], loadedModels[1]);
    assert.deepEqual(loadedModels.map((model) => model.internalModel.coreModel.parameters.values[0]).sort((a, b) => a - b), [20, 22.5]);
    const sharedBase = loadedModels[0].textures[0].baseTexture;
    assert.equal(sharedBase, loadedModels[1].textures[0].baseTexture);
    const edited = structuredClone(project);
    edited.sequences.root.tracks[1].clips = [];
    runtime.setProject(edited);
    assert.equal(loadedModels.filter((model) => model.destroyed).length, 1);
    assert.equal(sharedBase?.destroyed, false);
    await runtime.seekSceneAt("root", 1.75);
    const survivor = loadedModels.find((model) => !model.destroyed)!;
    near(survivor.internalModel.coreModel.parameters.values[0], 12.5);
  } finally { runtime.destroy(); }
});

test("SceneRuntime coalesces paused seeks and renders only the newest target", async () => {
  resetSceneMocks(); const project = fixture(); project.sequences.live = live();
  project.sequences.root.tracks[0].clips = [createClip({ id: "actor", kind: "sequence", sequenceId: "live", name: "actor", start: 0, duration: 6 })];
  const gate = deferred<Live2DModel>(); setModelLoader(async () => gate.promise);
  const { app, events } = makeApp(); const runtime = new SceneRuntime(app as any, project, callbacks);
  try {
    const old = runtime.seekSceneAt("root", 1);
    const latest = runtime.seekSceneAt("root", 3);
    await settle(); gate.resolve(new Live2DModel("https://models/model.model3.json"));
    await Promise.all([old, latest]);
    assert.equal(loadedModels.length, 1);
    near(loadedModels[0].internalModel.coreModel.parameters.values[0], 30);
    assert.equal(events.filter((event) => !event.renderTexture).length, 1);
  } finally { runtime.destroy(); }
});

test("SceneRuntime rejects deleted instance loads and frees their model textures", async () => {
  resetSceneMocks(); const project = fixture(); project.sequences.live = live();
  project.sequences.root.tracks[0].clips = [createClip({ id: "actor", kind: "sequence", sequenceId: "live", name: "actor", start: 0, duration: 6 })];
  const gate = deferred<Live2DModel>(); setModelLoader(async () => gate.promise);
  const { app } = makeApp(); const runtime = new SceneRuntime(app as any, project, callbacks);
  try {
    const loading = runtime.seekSceneAt("root", 1);
    const rejected = assert.rejects(loading, /关闭|改变|cancel/i);
    await settle();
    const edited = structuredClone(project); edited.sequences.root.tracks[0].clips = [];
    runtime.setProject(edited);
    const model = new Live2DModel("https://models/model.model3.json"), base = model.textures[0].baseTexture;
    gate.resolve(model); await rejected;
    assert.equal(model.destroyed, true);
    assert.equal(base?.destroyed, true);
    await runtime.seekSceneAt("root", 0);
    assert.equal(runtime.getAdapters("live").length, 0);
  } finally { runtime.destroy(); }
});

test("SceneRuntime URI replacement during pending loading cannot install the obsolete actor", async () => {
  resetSceneMocks(); const project = fixture(); project.sequences.live = live();
  project.sequences.root.tracks[0].clips = [createClip({ id: "actor", kind: "sequence", sequenceId: "live", name: "actor", start: 0, duration: 6 })];
  const oldGate = deferred<Live2DModel>();
  setModelLoader(async (url) => url.includes("old") ? oldGate.promise : new Live2DModel(url));
  project.assets.model.uri = "https://models/old.model3.json";
  const { app } = makeApp(); const runtime = new SceneRuntime(app as any, project, callbacks);
  try {
    const old = runtime.seekSceneAt("root", 1), rejected = assert.rejects(old, /改变|关闭|cancel/i);
    await settle();
    const replacement = structuredClone(project); replacement.assets.model.uri = "https://models/new.model3.json";
    runtime.setProject(replacement);
    await runtime.seekSceneAt("root", 2);
    const obsolete = new Live2DModel("https://models/old.model3.json"), base = obsolete.textures[0].baseTexture;
    oldGate.resolve(obsolete); await rejected;
    assert.equal(obsolete.destroyed, true); assert.equal(base?.destroyed, true);
    const adapter = runtime.getAdapters("live")[0];
    assert.equal(adapter.model.url, "https://models/new.model3.json");
    near(adapter.model.internalModel.coreModel.parameters.values[0], 20);
  } finally { runtime.destroy(); }
});

test("SceneRuntime composes child textures before the parent and applies source-time keys and text overrides", async () => {
  resetSceneMocks(); const project = fixture(); project.sequences.root.width = 1000; project.sequences.root.height = 600;
  const child = createEditSequence("child", { width: 640, height: 360 }); child.id = "child";
  project.assets.image = { id: "image", kind: "image", name: "image", uri: "https://assets/child.png" };
  project.assets.text = { id: "text", kind: "text", name: "preset", uri: "", metadata: { fontFamily: "serif", fontSize: 12, color: "#000000" } };
  child.tracks[0].clips = [createClip({ id: "image", kind: "image", assetId: "image", name: "image", start: 0, duration: 8 })]; project.sequences.child = child;
  project.sequences.root.tracks[0].clips = [createClip({ id: "caption", kind: "text", assetId: "text", name: "caption", text: "Override text", fontFamily: "Pixel Font", fontSize: 28, textColor: "#ff0000", start: 0, duration: 5 })];
  project.sequences.root.tracks.push({ ...createEditSequence().tracks[0], order: 1, clips: [createClip({ id: "nested", kind: "sequence", sequenceId: "child", name: "nested", start: 0, duration: 5, sourceIn: 1, rate: 2, transformKeys: [{ id: "a", time: 1, ...DEFAULT_TRANSFORM, x: 10 }, { id: "b", time: 3, ...DEFAULT_TRANSFORM, x: 30, scaleX: 2, scaleY: 2, rotation: 90, opacity: .5 }] })] });
  const { app, events } = makeApp(1000, 600); const runtime = new SceneRuntime(app as any, project, callbacks);
  try {
    await runtime.seekSceneAt("root", 1);
    const frames = events.filter((event) => event.renderTexture);
    assert.deepEqual(frames.map((event) => [event.renderTexture.width, event.renderTexture.height]), [[640, 360], [1000, 600]]);
    assert.equal(frames[0].children[0].texture.url, "https://assets/child.png");
    const root = frames[1];
    assert.equal(root.children.length, 2);
    const nested = root.children[0], text = root.children[1];
    assert.ok(nested.texture instanceof RenderTexture);
    assert.deepEqual(nested.position, { x: 530, y: 300 }); assert.deepEqual(nested.scale, { x: 2, y: 2 }); near(nested.rotation, Math.PI / 2); near(nested.alpha, .5);
    assert.ok(text.display instanceof Text); assert.equal(text.text, "Override text");
    assert.deepEqual([text.style.fontFamily, text.style.fontSize, text.style.fill], ["Pixel Font", 28, "#ff0000"]);
    assert.ok(frames.every((frame) => frame.backgroundAlpha === 0 && frame.clear === true));
    assert.equal(app.renderer.backgroundAlpha, 1);
    const edited = structuredClone(project); edited.sequences.root.tracks[0].clips[0].text = "Edited"; edited.sequences.root.tracks[0].clips[0].textColor = "#00ff00";
    runtime.setProject(edited); await runtime.seekSceneAt("root", 1);
    const updated = events.filter((event) => event.renderTexture?.width === 1000).at(-1).children.at(-1);
    assert.equal(updated.display, text.display); assert.equal(updated.text, "Edited"); assert.equal(updated.style.fill, "#00ff00");
  } finally { runtime.destroy(); }
});

test("SceneRuntime restores hidden composite parts and disables their clocks before configuring independent adapters", async () => {
  resetSceneMocks(); const project = fixture(); project.assets.model.uri = "https://models/model.jsonl"; project.sequences.live = live();
  project.sequences.root.tracks[0].clips = [createClip({ id: "actor", kind: "sequence", sequenceId: "live", name: "actor", start: 0, duration: 6 })];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ parts: [{ id: "body", index: 0, path: "body.model3.json" }, { id: "hair", index: 1, path: "hair.model3.json" }] }) }) as Response;
  const { app } = makeApp(); const runtime = new SceneRuntime(app as any, project, callbacks);
  try {
    await runtime.seekSceneAt("root", 2);
    assert.equal(loadedModels.length, 2); assert.equal(runtime.getAdapters("live").length, 2);
    assert.ok(compositeConfigured.every((state) => state.autoUpdate === false && state.deltaTime === 0 && state.visible === true));
    assert.ok(loadedModels.every((model) => model.visible === true));
    const parts = runtime.getAdapters("live").map((adapter) => adapter.tracks[0].definition.partId);
    assert.deepEqual(parts, ["main:0", "main:1"]);
    assert.notEqual(loadedModels[0].internalModel.physics, loadedModels[1].internalModel.physics);
  } finally { runtime.destroy(); globalThis.fetch = originalFetch; }
});

test("SceneRuntime destroys images that finish after the scene was closed", async () => {
  resetSceneMocks(); const project = fixture();
  project.assets.image = { id: "image", kind: "image", name: "image", uri: "https://assets/image.png" };
  project.sequences.root.tracks[0].clips = [createClip({ id: "image", kind: "image", assetId: "image", name: "image", start: 0, duration: 4 })];
  const image = deferred<Texture>(); setImageLoader(async () => image.promise);
  const { app } = makeApp(); const runtime = new SceneRuntime(app as any, project, callbacks);
  const loading = runtime.seekSceneAt("root", 1), rejected = assert.rejects(loading, /关闭/);
  await settle(); runtime.destroy();
  const texture = new Texture("https://assets/image.png"), base = texture.baseTexture;
  image.resolve(texture); await rejected;
  assert.equal(texture.destroyed, true); assert.equal(base?.destroyed, true);
});

test("SceneRuntime disposes replaced sequence visuals and textures exactly once", async () => {
  resetSceneMocks(); const project = fixture();
  project.assets.text = { id: "text", kind: "text", name: "text", uri: "" };
  const old = createEditSequence("old"); old.id = "old";
  old.tracks[0].clips = [createClip({ id: "old-text", kind: "text", assetId: "text", name: "old-text", start: 0, duration: 4 })];
  const replacement = createEditSequence("replacement"); replacement.id = "replacement";
  project.sequences.old = old; project.sequences.replacement = replacement;
  project.sequences.root.tracks[0].clips = [createClip({ id: "nested", kind: "sequence", sequenceId: "old", name: "nested", start: 0, duration: 4 })];
  const { app, events } = makeApp(); const runtime = new SceneRuntime(app as any, project, callbacks);
  await runtime.seekSceneAt("root", 1);
  const childFrame = events.find((event) => event.children.some((child: any) => child.text === "text"));
  const text = childFrame.children[0].display, texture = childFrame.renderTexture;
  const edited = structuredClone(project); edited.sequences.root.tracks[0].clips[0].sequenceId = "replacement";
  runtime.setProject(edited);
  assert.equal(text.destroyCalls, 1); assert.equal(texture.destroyCalls, 1); assert.equal(childFrame.container.destroyCalls, 1);
  await runtime.seekSceneAt("root", 1);
  runtime.destroy(); runtime.destroy();
  assert.equal(text.destroyCalls, 1); assert.equal(texture.destroyCalls, 1);
  assert.equal(app.stage.children.length, 0);
});

test("SceneRuntime previews healthy siblings of missing clips and repairs them without losing data", async () => {
  resetSceneMocks(); const project = fixture();
  project.assets.image = { id: "image", kind: "image", name: "healthy-image", uri: "https://assets/healthy.png" };
  project.assets.text = { id: "text", kind: "text", name: "healthy-text", uri: "" };
  project.assets.missing = { id: "missing", kind: "image", name: "missing-image", uri: "https://assets/missing.png", missing: true };
  project.assets.broken = { id: "broken", kind: "image", name: "broken-image", uri: "https://assets/broken.png" };
  setImageLoader(async (url) => { if (url.includes("broken")) throw new Error("图片读取失败：broken-image"); return Texture.cached(url); });
  const clips = [
    createClip({ id: "healthy-image", kind: "image", assetId: "image", name: "healthy-image", start: 0, duration: 4 }),
    createClip({ id: "healthy-text", kind: "text", assetId: "text", name: "healthy-text", start: 0, duration: 4 }),
    createClip({ id: "missing-image", kind: "image", assetId: "missing", name: "missing-image", start: 0, duration: 4, transform: { ...DEFAULT_TRANSFORM, x: 200 } }),
    createClip({ id: "placeholder", kind: "image", assetId: "image", name: "placeholder", start: 0, duration: 4, placeholder: { reason: "等待修复", original: { originalPath: "gone.png" } }, transform: { ...DEFAULT_TRANSFORM, x: 200 } }),
    createClip({ id: "broken-image", kind: "image", assetId: "broken", name: "broken-image", start: 0, duration: 4 }),
    createClip({ id: "missing-sequence", kind: "sequence", sequenceId: "gone", name: "missing-sequence", start: 0, duration: 4 }),
  ];
  project.sequences.root.tracks = clips.map((clip, order) => ({ ...createEditSequence().tracks[0], id: `lane-${order}`, order, clips: [clip] }));
  const errors: string[] = []; const { app, events } = makeApp();
  const runtime = new SceneRuntime(app as any, project, { ...callbacks, onError: (message) => errors.push(message) });
  try {
    await runtime.seekSceneAt("root", 1);
    const frame = events.filter((event) => event.renderTexture).at(-1);
    assert.deepEqual(frame.children.map((child: any) => child.text ?? child.texture.url), ["healthy-text", "https://assets/healthy.png"]);
    assert.equal(runtime.hitTest(1160, 540), null);
    assert.equal(errors.length, 1); assert.match(errors[0], /missing-image/); assert.match(errors[0], /等待修复/); assert.match(errors[0], /broken-image/); assert.match(errors[0], /缺少序列/);
    await runtime.seekSceneAt("root", 2); assert.equal(errors.length, 1);
    await assert.rejects(runtime.seekSceneAt("root", 1, { offline: true }), /缺少素材|等待修复|读取失败|缺少序列/);
    await assert.rejects(runtime.prepareSequence("root", true), /缺少素材|等待修复|读取失败|缺少序列/);
    assert.deepEqual(project.sequences.root.tracks[3].clips[0].placeholder?.original, { originalPath: "gone.png" });
    const repaired = structuredClone(project);
    repaired.assets.missing.missing = false; repaired.assets.broken.uri = "https://assets/repaired.png";
    repaired.sequences.root.tracks[3].clips[0].placeholder = undefined;
    const recovered = createEditSequence("recovered"); recovered.id = "gone"; repaired.sequences.gone = recovered;
    runtime.setProject(repaired);
    await runtime.seekSceneAt("root", 1);
    assert.equal(events.filter((event) => event.renderTexture).at(-1).children.length, 6);
    await runtime.prepareSequence("root", true); await runtime.seekSceneAt("root", 1, { offline: true });
  } finally { runtime.destroy(); }
});

test("SceneRuntime keeps healthy actors and internal tracks visible when a nested model is missing", async () => {
  resetSceneMocks(); const project = fixture(); const internal = live();
  internal.actors.push({ ...internal.actors[0], id: "missing-actor", assetId: "missing-model", name: "missing-actor" });
  project.assets.text = { id: "text", kind: "text", name: "internal-caption", uri: "" };
  internal.tracks = [{ ...createEditSequence().tracks[0], clips: [createClip({ id: "caption", kind: "text", assetId: "text", name: "caption", start: 0, duration: 4 })] }];
  project.sequences.live = internal;
  project.sequences.root.tracks[0].clips = [createClip({ id: "nested", kind: "sequence", sequenceId: "live", name: "nested", start: 0, duration: 4 })];
  const errors: string[] = []; const { app, events } = makeApp();
  const runtime = new SceneRuntime(app as any, project, { ...callbacks, onError: (message) => errors.push(message) });
  try {
    await runtime.seekSceneAt("root", 2);
    assert.equal(loadedModels.length, 1); near(loadedModels[0].internalModel.coreModel.parameters.values[0], 20);
    const frames = events.filter((event) => event.renderTexture);
    assert.equal(frames[0].children.length, 2); assert.equal(frames[0].children[1].text, "internal-caption");
    assert.equal(frames[1].children.length, 1); assert.match(errors[0], /缺少模型素材：missing-actor/);
    await assert.rejects(runtime.prepareSequence("root", true), /缺少模型素材：missing-actor/);
  } finally { runtime.destroy(); }
});

test("SceneRuntime hides stale visuals and releases actors when their assets become missing", async () => {
  resetSceneMocks(); const project = fixture(); project.sequences.live = live();
  project.assets.image = { id: "image", kind: "image", name: "image", uri: "https://assets/image.png" };
  project.assets.text = { id: "text", kind: "text", name: "caption", uri: "" };
  const internal = project.sequences.live;
  internal.tracks = [
    { ...createEditSequence().tracks[0], id: "image-track", order: 0, clips: [createClip({ id: "image", kind: "image", assetId: "image", name: "image", start: 0, duration: 4, transform: { ...DEFAULT_TRANSFORM, x: 200 } })] },
    { ...createEditSequence().tracks[0], id: "text-track", order: 1, clips: [createClip({ id: "text", kind: "text", assetId: "text", name: "caption", start: 0, duration: 4 })] },
  ];
  const { app, events } = makeApp(); const runtime = new SceneRuntime(app as any, project, callbacks);
  try {
    await runtime.seekSceneAt("live", 1);
    const model = loadedModels[0], base = model.textures[0].baseTexture;
    const original = events.filter((event) => event.renderTexture).at(-1);
    const imageDisplay = original.children.find((child: any) => child.texture?.url === "https://assets/image.png").display;
    const missing = structuredClone(project); missing.assets.model.missing = true; missing.assets.image.missing = true;
    runtime.setProject(missing);
    assert.equal(model.destroyCalls, 1); assert.equal(base?.destroyed, true);
    await runtime.seekSceneAt("live", 1);
    const frame = events.filter((event) => event.renderTexture).at(-1);
    assert.deepEqual(frame.children.map((child: any) => child.text), ["caption"]);
    assert.equal(imageDisplay.visible, false); assert.equal(runtime.getAdapters("live").length, 0); assert.equal(runtime.hitTest(1160, 540), null);
    runtime.setProject(project); await runtime.seekSceneAt("live", 1);
    assert.equal(loadedModels.length, 2); assert.equal(loadedModels[1].destroyed, false);
    assert.equal(events.filter((event) => event.renderTexture).at(-1).children.length, 3);
  } finally { runtime.destroy(); }
});

test("SceneRuntime export preflight rejects unavailable references outside the current preview time", async () => {
  resetSceneMocks(); const project = fixture();
  project.assets.text = { id: "text", kind: "text", name: "caption", uri: "" };
  project.sequences.root.tracks[0].clips = [
    createClip({ id: "caption", kind: "text", assetId: "text", name: "caption", start: 0, duration: 4 }),
    createClip({ id: "later", kind: "image", assetId: "missing", name: "later", start: 5, duration: 4 }),
  ];
  const { app } = makeApp(); const runtime = new SceneRuntime(app as any, project, callbacks);
  try { await runtime.seekSceneAt("root", 1); await assert.rejects(runtime.prepareSequence("root", true), /缺少素材：later/); }
  finally { runtime.destroy(); }
});

test("SceneRuntime renders migrated speaker labels and responds to the speaker display flag", async () => {
  resetSceneMocks(); const project = fixture();
  project.assets.text = { id: "text", kind: "text", name: "caption", uri: "", metadata: { speaker: "Anon", showSpeaker: true, speakerAlign: "left" } };
  project.sequences.root.tracks[0].clips = [createClip({ id: "text", kind: "text", assetId: "text", name: "caption", text: "正文", start: 0, duration: 4 })];
  const { app, events } = makeApp(); const runtime = new SceneRuntime(app as any, project, callbacks);
  try {
    await runtime.seekSceneAt("root", 1);
    const original = events.filter((event) => event.renderTexture).at(-1).children[0];
    assert.equal(original.text, "Anon\n正文");
    const hidden = structuredClone(project); hidden.assets.text.metadata!.showSpeaker = false;
    runtime.setProject(hidden); await runtime.seekSceneAt("root", 1);
    const updated = events.filter((event) => event.renderTexture).at(-1).children[0];
    assert.equal(updated.display, original.display); assert.equal(updated.text, "正文");
    assert.equal(project.sequences.root.tracks[0].clips[0].text, "正文");
  } finally { runtime.destroy(); }
});

test("preview quality changes texture cost without changing transforms or model evaluation; offline stays full resolution", async () => {
  resetSceneMocks();
  const project=fixture();project.sequences.live=live();
  project.sequences.root.tracks[0].clips=[createClip({id:"clip",kind:"sequence",sequenceId:"live",name:"live",start:0,duration:6})];
  const {app}=makeApp();const runtime=new SceneRuntime(app as any,project,callbacks);
  try {
    await runtime.seekSceneAt("root",2);
    const full=runtime.cacheStats().bytes;
    runtime.setPreviewQuality(0.5);await runtime.seekSceneAt("root",2);
    assert.equal(runtime.cacheStats().bytes,full/4);near(loadedModels[0].internalModel.coreModel.parameters.values[0],20);
    await runtime.seekSceneAt("root",2,{offline:true});assert.equal(runtime.cacheStats().bytes,full);
    runtime.clearCache();assert.deepEqual(runtime.cacheStats(),{instances:0,bytes:0});
    await runtime.seekSceneAt("root",2);near(loadedModels.at(-1)!.internalModel.coreModel.parameters.values[0],20);
  } finally {runtime.destroy();}
});

test("preview cache evicts old instance paths under its budget and rebuilds them deterministically", async () => {
  resetSceneMocks();const project=fixture();project.sequences.live=live();
  project.sequences.root.tracks[0].clips=Array.from({length:6},(_,i)=>createClip({id:`clip-${i}`,kind:"sequence",sequenceId:"live",name:"live",start:i*6,duration:6}));
  const {app}=makeApp();const runtime=new SceneRuntime(app as any,project,callbacks);runtime.setCacheBudget(32);
  try {
    for(let i=0;i<6;i++)await runtime.seekSceneAt("root",i*6+2);
    assert.ok(runtime.cacheStats().bytes<=32*1024*1024);assert.ok(loadedModels[0].destroyed);
    await runtime.seekSceneAt("root",2);near(loadedModels.at(-1)!.internalModel.coreModel.parameters.values[0],20);
  } finally {runtime.destroy();}
});
