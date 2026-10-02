import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { emptyAnimation, targetId } from "../src/animation/types";
import { createClip, createEditSequence, DEFAULT_TRANSFORM } from "../src/sequence/types";
import type { ProjectDocument } from "../src/sequence/types";
import { materialSourceFromAsset, materialSourceToAsset } from "../src/sequence/materials";
import { createProjectBundle, modelResourceReferences, normalizeResourcePath, openProjectBundle, saveAutosaveProject, storeAudioAsset, storeImageAsset } from "../src/utils/projectStorage";
import type { ProjectSnapshot } from "../src/utils/projectStorage";
import { buildAudioManifest, resolveExportPipeline } from "../src/utils/videoExporter";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "l2d-storage-test-"));
  process.env.L2D_STORAGE_TEST_ROOT = root;
  const models = join(root, "models");
  const outputModels = join(root, "restored-models");
  await mkdir(join(models, "package", "aggregates"), { recursive: true });
  await mkdir(join(models, "package", "parts"), { recursive: true });
  await mkdir(join(models, "package", "textures"), { recursive: true });
  await writeFile(join(models, "package", "aggregates", "main.jsonl"), JSON.stringify({ path: "../parts/model3.json", id: "character" }));
  await writeFile(join(models, "package", "parts", "model3.json"), JSON.stringify({ FileReferences: { Moc: "model.moc3", Textures: ["../textures/skin.png"], Motions: { Idle: [{ File: "idle.motion3.json" }] }, DisplayInfo: "display.cdi3.json" } }));
  await writeFile(join(models, "package", "parts", "model.moc3"), "model-bytes");
  await writeFile(join(models, "package", "parts", "idle.motion3.json"), "{}");
  await writeFile(join(models, "package", "parts", "display.cdi3.json"), "{}");
  await writeFile(join(models, "package", "textures", "skin.png"), "texture-bytes");
  const audio = join(root, "sound.wav");
  const duplicateAudio = join(root, "sound-copy.wav");
  await writeFile(audio, "same-audio"); await writeFile(duplicateAudio, "same-audio");
  const main = createEditSequence("主序列"); main.id = "root";
  const compound = createEditSequence("复合"); compound.id = "compound";
  const animation = emptyAnimation();
  const document: ProjectDocument = {
    version: 3, id: "project", name: "portable", seed: 1729, savedAt: "", rootSequenceId: "root", width: 1920, height: 1080, fps: 30,
    assets: {
      model: { id: "model", kind: "live2d", uri: "package/aggregates/main.jsonl", name: "Composite" },
      sameModel: { id: "sameModel", kind: "live2d", uri: "package/aggregates/main.jsonl", name: "Composite again" },
      audio: { id: "audio", kind: "audio", uri: audio, name: "Sound", duration: 2 },
      audioCopy: { id: "audioCopy", kind: "audio", uri: duplicateAudio, name: "Copy", duration: 2 },
    },
    sequences: { root: main, compound, live: { id: "live", name: "Live2D", kind: "live2d", tracks: [], actors: [{ id: "actor", assetId: "model", modelPartId: "model", name: "Actor", transform: { ...DEFAULT_TRANSFORM }, visible: true }], animation, duration: 5, width: 1920, height: 1080, fps: 30 } },
  };
  main.tracks[0].clips.push(createClip({ id: "compound-clip", kind: "sequence", sequenceId: "compound", name: "Compound", start: 0, duration: 5 }));
  compound.tracks[0].clips.push(createClip({ id: "model-clip", kind: "sequence", sequenceId: "live", name: "Model", start: 0, duration: 5 }));
  main.tracks.push({ id: "audio-track", name: "Audio", order: 1, hidden: false, locked: false, muted: false, clips: [createClip({ id: "audio-clip", kind: "audio", name: "Audio", assetId: "audio", start: 0, duration: 2 })] });
  const snapshot: ProjectSnapshot = {
    version: 3, document, animation, savedAt: "", selectedModel: "package/aggregates/main.jsonl", selectedCharacterId: "actor", motionClips: [], exprClips: [], audioClips: [{ id: "legacy-audio", name: "Sound", start: 0, duration: 2, audioPath: audio }], subtitleClips: [], showSubtitles: true, showSubtitleSpeaker: false, subtitleSpeakerAlign: "left", playhead: 0, motionDur: 5, exprDur: 5, characterVisible: true, characterTransformMode: "single-relative", characterTransform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, recordingQuality: "medium", transparentBg: true, customRecordingBounds: { x: 0, y: 0, width: 1920, height: 1080 },
  };
  return { root, models, outputModels, snapshot, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("portable V3 bundle preserves JSONL sibling resources, deduplicates media, and restores nested primary model", async () => {
  const value = await fixture();
  try {
    const original = structuredClone(value.snapshot);
    const bytes = await createProjectBundle(value.snapshot, value.models);
    assert.deepEqual(value.snapshot, original, "packing never mutates the open project");
    const archive = await JSZip.loadAsync(bytes);
    const files = Object.values(archive.files).filter(entry => !entry.dir);
    assert.equal(files.filter(entry => entry.name.startsWith("assets/audio/")).length, 1);
    assert.equal(files.filter(entry => entry.name.endsWith("main.jsonl")).length, 1);
    assert.ok(files.some(entry => entry.name.endsWith("parts/model.moc3")));
    assert.ok(files.some(entry => entry.name.endsWith("textures/skin.png")));
    const bundle = join(value.root, "project.l2dmm"); await writeFile(bundle, bytes);
    // Original assets can disappear without affecting the restored project.
    await rm(value.models, { recursive: true, force: true });
    const restored = await openProjectBundle(bundle, value.outputModels);
    assert.equal(restored.document?.assets.audio.uri, restored.document?.assets.audioCopy.uri);
    assert.equal(restored.audioClips[0].audioPath, restored.document?.assets.audio.uri);
    assert.equal(restored.selectedModel, restored.document?.assets.model.uri);
    assert.equal(restored.document?.assets.model.uri, restored.document?.assets.sameModel.uri);
    const primary = join(value.outputModels, restored.document!.assets.model.uri);
    const line = JSON.parse(await readFile(primary, "utf8"));
    const settingsPath = join(primary, "..", line.path);
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(await readFile(join(settingsPath, "..", settings.FileReferences.Textures[0]), "utf8"), "texture-bytes");
    const openedAgain = await openProjectBundle(bundle, value.outputModels);
    assert.notEqual(openedAgain.selectedModel, restored.selectedModel, "opening another package never overwrites a loaded model instance");
  } finally { await value.cleanup(); }
});

test("V3 bundles retain motion and expression source text without temporary server URLs", async () => {
  const value = await fixture();
  try {
    const motionTexts = [
      '{\n  "Version": 3,\n  "Meta": {"Duration": 1.75},\n  "Curves": [{"Target":"Parameter","Id":"ParamAngleX","Segments":[0,0,0,1.75,15]}]\n}\n',
      '# Live2D Motion Data\n$fps=30\nParamHair=0,0.25,0.5\n',
    ];
    const expressionText = '{\n  "Type":"Live2D Expression",\n  "FadeInTime":0.125,\n  "Parameters":[{"Id":"ParamMouthForm","Value":0.75,"Blend":"Add"},{"Id":"ParamEyeLOpen","Value":0.5,"Blend":"Multiply"},{"Id":"ParamBrowLY","Value":-0.25,"Blend":"Overwrite"}]\n}\n';
    const motion = materialSourceToAsset({ id: "motion-source", name: "转身动作", kind: "motion", sourceModel: "package/aggregates/main.jsonl", parts: motionTexts.map((text, index) => ({ partId: String(index), uri: `http://127.0.0.1:49152/model/part${index}/turn.motion3.json`, text })) });
    const expression = materialSourceToAsset({ id: "expression-source", name: "微笑表情", kind: "expression", sourceModel: "package/aggregates/main.jsonl", parts: [{ partId: "0", uri: "http://127.0.0.1:49152/model/smile.exp3.json", text: expressionText }] });
    value.snapshot.document!.assets[motion.id] = motion;
    value.snapshot.document!.assets[expression.id] = expression;
    const bundle = join(value.root, "materials.l2dmm");
    await writeFile(bundle, await createProjectBundle(value.snapshot, value.models));
    // Reopening uses the saved raw curves even after the original files disappear.
    await rm(value.models, { recursive: true, force: true });
    const restored = await openProjectBundle(bundle, value.outputModels);
    for (const asset of [motion, expression]) {
      const reopened = restored.document!.assets[asset.id];
      assert.deepEqual(reopened, asset);
      assert.equal(reopened.uri, "");
      assert.equal(JSON.stringify(reopened).includes("127.0.0.1"), false);
      const source = materialSourceFromAsset(reopened)!;
      assert.ok(source.parts.every((part) => part.uri === ""));
      assert.deepEqual(source.parts.map((part) => part.text), asset.kind === "motion" ? motionTexts : [expressionText]);
    }
    const savedAgain = join(value.root, "materials-resaved.l2dmm");
    await writeFile(savedAgain, await createProjectBundle(restored, value.outputModels));
    const reopenedAgain = await openProjectBundle(savedAgain, value.outputModels);
    assert.deepEqual(reopenedAgain.document!.assets[motion.id], motion);
    assert.deepEqual(reopenedAgain.document!.assets[expression.id], expression);
  } finally { await value.cleanup(); }
});

test("missing bundle assets retain repairable references and timing", async () => {
  const value = await fixture();
  try {
    const archive = await JSZip.loadAsync(await createProjectBundle(value.snapshot, value.models));
    for (const entry of Object.values(archive.files)) if (entry.name.startsWith("assets/audio/")) archive.remove(entry.name);
    const bundle = join(value.root, "missing.l2dmm"); await writeFile(bundle, await archive.generateAsync({ type: "uint8array" }));
    const restored = await openProjectBundle(bundle, value.outputModels);
    assert.equal(restored.document?.assets.audio.missing, true);
    const audioClip = restored.document?.sequences.root.tracks[1].clips[0];
    assert.equal(audioClip?.start, 0); assert.equal(audioClip?.duration, 2);
    assert.ok(audioClip?.placeholder?.reason.includes("缺少"));
    assert.ok(restored.audioClips[0].audioPath?.startsWith("bundle:"));
    // A known missing asset remains saveable as a placeholder.
    await createProjectBundle(restored, value.outputModels);
  } finally { await value.cleanup(); }
});

test("local absolute model references are rewritten for portable reopening", async () => {
  const value = await fixture();
  try {
    await writeFile(join(value.models, "package", "aggregates", "main.jsonl"), JSON.stringify({ path: join(value.models, "package", "parts", "model3.json"), id: "character" }));
    await writeFile(join(value.models, "package", "parts", "model3.json"), JSON.stringify({ FileReferences: { Moc: join(value.models, "package", "parts", "model.moc3"), Textures: [join(value.models, "package", "textures", "skin.png")] } }));
    const bundle = join(value.root, "absolute.l2dmm");
    await writeFile(bundle, await createProjectBundle(value.snapshot, value.models));
    await rm(value.models, { recursive: true, force: true });
    const restored = await openProjectBundle(bundle, value.outputModels);
    const primary = join(value.outputModels, restored.document!.assets.model.uri);
    const part = JSON.parse(await readFile(primary, "utf8"));
    assert.equal(part.path, "../parts/model3.json");
    const settingsPath = join(primary, "..", part.path);
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(settings.FileReferences.Moc, "model.moc3");
    assert.equal(await readFile(join(settingsPath, "..", settings.FileReferences.Moc), "utf8"), "model-bytes");
  } finally { await value.cleanup(); }
});

test("missing bundled model dependencies remain repairable and retain animation across another save", async () => {
  const value = await fixture();
  try {
    const sequence = value.snapshot.document!.sequences.live;
    assert.equal(sequence.kind, "live2d");
    if (sequence.kind !== "live2d") throw new Error("expected Live2D fixture");
    const target = targetId("actor", "model", "ParamAngleX");
    const keys = [{ id: "k0", time: 0, value: 0, interpolation: "linear" as const }, { id: "k1", time: 0.166666666666, value: 12.5, interpolation: "hold" as const }];
    sequence.animation.tracks.push({ definition: { target, characterId: "actor", partId: "model", parameterId: "ParamAngleX", name: "角度", group: "参数", kind: "parameter", min: -30, max: 30, defaultValue: 0 }, baseValue: 2, animated: true, keys });
    sequence.animation.groups.push({ id: "motion", name: "动作", kind: "motion", start: 0, duration: 0.166666666666, sourceDuration: 5, offset: 0, speed: 1, curves: { [target]: keys }, originalCurves: { [target]: structuredClone(keys) } });
    value.snapshot.document!.assets.model.metadata = { legacyMotions: '[{"name":"Idle","start":1.5,"duration":2}]' };
    const expectedAnimation = structuredClone(sequence.animation);
    const archive = await JSZip.loadAsync(await createProjectBundle(value.snapshot, value.models));
    for (const entry of Object.values(archive.files)) if (entry.name.endsWith("textures/skin.png")) archive.remove(entry.name);
    const bundle = join(value.root, "missing-texture.l2dmm"); await writeFile(bundle, await archive.generateAsync({ type: "uint8array" }));
    const restored = await openProjectBundle(bundle, value.outputModels);
    assert.equal(restored.document?.assets.model.missing, true);
    assert.ok(String(restored.document?.assets.model.metadata?.missingReason).includes("资源不完整"));
    assert.ok(String(restored.document?.assets.model.metadata?.originalUri).startsWith("bundle:"));
    assert.equal(restored.selectedModel, null);
    const secondBundle = join(value.root, "missing-texture-resaved.l2dmm"); await writeFile(secondBundle, await createProjectBundle(restored, value.outputModels));
    const reopened = await openProjectBundle(secondBundle, value.outputModels);
    assert.equal(reopened.document?.assets.model.missing, true);
    const reopenedSequence = reopened.document!.sequences.live;
    assert.equal(reopenedSequence.kind, "live2d");
    if (reopenedSequence.kind !== "live2d") throw new Error("expected retained Live2D sequence");
    assert.deepEqual(reopenedSequence.animation, expectedAnimation);
    assert.equal(reopened.document?.assets.model.metadata?.legacyMotions, value.snapshot.document!.assets.model.metadata?.legacyMotions);
  } finally { await value.cleanup(); }
});

test("bundle refuses traversal and oversized declared entries before asset inflation", async () => {
  const value = await fixture();
  try {
    const archive = new JSZip(); archive.file("assets/audio/../../outside.wav", "invalid"); archive.file("project.json", JSON.stringify(value.snapshot));
    const traversal = join(value.root, "traversal.l2dmm"); await writeFile(traversal, await archive.generateAsync({ type: "uint8array" }));
    await assert.rejects(openProjectBundle(traversal, value.outputModels), /不安全路径/);
    const bytes = Buffer.from(await createProjectBundle(value.snapshot, value.models));
    for (let i = 0; i < bytes.length - 46; i++) {
      if (bytes.readUInt32LE(i) !== 0x02014b50) continue;
      const name = bytes.subarray(i + 46, i + 46 + bytes.readUInt16LE(i + 28)).toString();
      if (!name.startsWith("assets/audio/") || name.endsWith("/")) continue;
      bytes.writeUInt32LE(257 * 1024 * 1024, i + 24); break;
    }
    const oversized = join(value.root, "oversized.l2dmm"); await writeFile(oversized, bytes);
    await assert.rejects(openProjectBundle(oversized, value.outputModels), /超过 256 MiB/);
    const corrupted = Buffer.from(await createProjectBundle(value.snapshot, value.models));
    for (let i = 0; i < corrupted.length - 46; i++) {
      if (corrupted.readUInt32LE(i) !== 0x02014b50) continue;
      const name = corrupted.subarray(i + 46, i + 46 + corrupted.readUInt16LE(i + 28)).toString();
      if (!name.startsWith("assets/audio/") || name.endsWith("/")) continue;
      corrupted.writeUInt32LE((corrupted.readUInt32LE(i + 16) ^ 1) >>> 0, i + 16); break;
    }
    const corruptPath = join(value.root, "corrupted.l2dmm"); await writeFile(corruptPath, corrupted);
    await assert.rejects(openProjectBundle(corruptPath, value.outputModels), /校验失败/);
  } finally { await value.cleanup(); }
});

test("autosave preserves both V1 and V2 originals when upgrading", async () => {
  const value = await fixture();
  try {
    for (const version of [1, 2] as const) {
      await saveAutosaveProject({ ...value.snapshot, version, document: undefined });
      await saveAutosaveProject(value.snapshot);
    }
    const backups = await readdir(join(value.root, "local"));
    assert.ok(backups.some(name => name.startsWith("autosave-v1-backup-")));
    assert.ok(backups.some(name => name.startsWith("autosave-v2-backup-")));
  } finally { await value.cleanup(); }
});

test("audio manifest preserves nested subframe schedule, rates and gain envelopes", () => {
  const gainEnvelopes = [{ gain: 0.8, keys: [{ time: -0.1, value: 0.25 }, { time: 1, value: 1 }], fadeInStart: -0.5, fadeInDuration: 1, fadeOutStart: 2, fadeOutDuration: 1 }];
  const manifest = buildAudioManifest([{ id: "nested", audioPath: "/sound.wav", start: 0.005, duration: 2, sourceIn: 1, playbackRate: 16, gainEnvelopes }], 30);
  assert.equal(manifest[0].startSec, 0.005); assert.equal(manifest[0].durationSec, 2);
  assert.equal(manifest[0].playbackRate, 16); assert.equal(manifest[0].sourceInSec, 1);
  assert.deepEqual(manifest[0].gainEnvelopes, gainEnvelopes);
  assert.throws(() => buildAudioManifest([{ id: "missing", start: 0, duration: 1, audioUrl: "blob:runtime-only" }], 30), /缺少可读取/);
  assert.deepEqual(modelResourceReferences({ model: "a.moc", textures: ["a.png"], motions: { Idle: [{ file: "a.mtn" }] } }), ["a.moc", "a.png", "a.mtn"]);
  assert.equal(normalizeResourcePath("/models/aggregate/../parts/model.json"), "/models/parts/model.json");
});

test("export pipeline keeps real-time WebM recording only when it can preserve the output", () => {
  assert.deepEqual(resolveExportPipeline({ format: "webm", method: "record", transparentBg: false, recordingSupported: true }), {
    kind: "record", format: "webm", note: null,
  });
  assert.deepEqual(resolveExportPipeline({ format: "webm", method: "record", transparentBg: false, recordingSupported: false }), {
    kind: "frames", format: "webm", note: "当前环境不支持 WebM 实时录制，已改用逐帧渲染（PNG → WebM）。",
  });
  assert.deepEqual(resolveExportPipeline({ format: "webm", method: "record", transparentBg: true, recordingSupported: true }), {
    kind: "frames", format: "webm", note: "透明背景需要逐帧渲染（PNG → WebM），已改用逐帧渲染。",
  });
  assert.deepEqual(resolveExportPipeline({ format: "mov", method: "record", transparentBg: false, recordingSupported: true }), {
    kind: "frames", format: "mov", note: "MOV 需要逐帧渲染才能保留 ProRes 4444 与透明通道，已改用逐帧渲染。",
  });
  assert.deepEqual(resolveExportPipeline({ format: "mov", method: "frames", transparentBg: false, recordingSupported: true }), {
    kind: "frames", format: "mov", note: null,
  });
  assert.deepEqual(resolveExportPipeline({ format: "webm", method: "frames", transparentBg: true, recordingSupported: false }), {
    kind: "frames", format: "webm", note: null,
  });
});

test("native extension semantics preserve imported and restored media suffixes", async () => {
  const f=await fixture();
  try {
    const sound=join(f.root,"tone.wav"),picture=join(f.root,"picture.png");
    await writeFile(sound,"sound");await writeFile(picture,"image");
    assert.match(await storeAudioAsset(sound),/\.wav$/);
    assert.match(await storeImageAsset(picture),/\.png$/);
  } finally {await rm(f.root,{recursive:true,force:true});}
});
