import { test } from "node:test";
import assert from "node:assert/strict";
import { createClip, createEditSequence } from "../src/sequence/types";
import {
  addTrack,
  changeClipRate,
  createCompound,
  createIndependentClip,
  insertClip,
  moveClips,
  moveClip,
  ProjectHistory,
  resolveLive2DActorsAt,
  resolveSequenceAt,
  splitClip,
  pasteClips,
  trimClip,
  deleteClips,
  updateClip,
  evaluateClipTransform,
  clipVolumeAt,
  sequenceDuration,
} from "../src/sequence/engine";
import { migrateLegacyProject } from "../src/sequence/migration";
import { isProjectDocument } from "../src/sequence/validation";
import { audioGainAt, resolveAudioSchedule } from "../src/sequence/audio";
import { syncLegacyMedia } from "../src/sequence/syncLegacy";
import { DEFAULT_TRANSFORM, type ProjectDocument } from "../src/sequence/types";
import { targetId } from "../src/animation/types";

function project(): ProjectDocument {
  const root = createEditSequence("主序列");
  root.id = "root";
  return { version: 3, id: "p", name: "test", assets: {}, sequences: { root }, rootSequenceId: "root", width: 1920, height: 1080, fps: 30, seed: 1729, savedAt: "" };
}
const clip = (id: string, start: number, duration: number, kind: "image" | "audio" = "image") => createClip({ id, kind, name: id, start, duration });

test("mixed insert allows gaps and creates an adjacent lane on collision", () => {
  let doc = project();
  const root = doc.sequences.root;
  const lane = root.tracks[0];
  doc = insertClip(doc, "root", lane.id, clip("bg", 0, 3)).project;
  doc = insertClip(doc, "root", lane.id, clip("audio", 1, 2, "audio")).project;
  const tracks = doc.sequences.root.tracks;
  assert.equal(tracks.length, 2);
  assert.equal(tracks[0].clips[0].id, "audio");
  assert.equal(tracks[0].order, 0);
  assert.equal(tracks[1].clips[0].id, "bg");
});

test("move, split, trim and speed preserve source mapping", () => {
  let doc = project();
  const first = doc.sequences.root.tracks[0];
  doc = insertClip(doc, "root", first.id, clip("a", 0, 4)).project;
  doc = splitClip(doc, "root", first.id, "a", 2);
  const halves = doc.sequences.root.tracks[0].clips;
  assert.deepEqual(halves.map((item) => [item.start, item.duration, item.sourceIn]), [[0, 2, 0], [2, 2, 2]]);
  doc = changeClipRate(doc, "root", first.id, halves[1].id, 2);
  assert.equal(doc.sequences.root.tracks[0].clips[1].duration, 1);
  doc = trimClip(doc, "root", first.id, halves[1].id, "left", 0.5);
  assert.equal(doc.sequences.root.tracks[0].clips[1].sourceIn, 3);
  doc = moveClip(doc, "root", first.id, halves[1].id, first.id, 5).project;
  assert.equal(doc.sequences.root.tracks[0].clips[1].start, 5);
});

test("moving and pasting a selection keep relative timing and track offsets", () => {
  let doc = project();
  doc = addTrack(doc, "root", "轨道 2");
  const firstTrack = doc.sequences.root.tracks[0];
  const secondTrack = doc.sequences.root.tracks[1];
  doc = insertClip(doc, "root", firstTrack.id, clip("a", 0, 2)).project;
  doc = insertClip(doc, "root", secondTrack.id, clip("b", 1, 2)).project;
  doc = moveClips(doc, "root", ["a", "b"], "a", secondTrack.id, 3);
  const moved = doc.sequences.root.tracks.slice().sort((a, b) => a.order - b.order);
  assert.deepEqual(moved.flatMap((track) => track.clips.map((item) => [item.id, track.order, item.start])), [["a", 1, 3], ["b", 2, 4]]);
  const pasted = pasteClips(doc, "root", moved[0].id, 6, [
    { trackOffset: 0, timeOffset: 0, clip: moved[1].clips[0] },
    { trackOffset: 1, timeOffset: 1, clip: moved[2].clips[0] },
  ]);
  const newClips = pasted.project.sequences.root.tracks.flatMap((track) => track.clips.map((item) => ({ track, item }))).filter(({ item }) => pasted.clipIds.includes(item.id));
  assert.deepEqual(newClips.map(({ track, item }) => [track.order, item.start]), [[0, 6], [1, 7]]);
});

test("nested sequence resolver maps source time and inherited transforms", () => {
  let doc = project();
  const child = createEditSequence("内层");
  child.id = "child";
  const lane = child.tracks[0];
  doc = { ...doc, sequences: { ...doc.sequences, child } };
  doc = insertClip(doc, "child", lane.id, clip("leaf", 1, 5)).project;
  const rootTrack = doc.sequences.root.tracks[0];
  doc = insertClip(doc, "root", rootTrack.id, createClip({ kind: "sequence", sequenceId: "child", name: "compound", start: 2, duration: 5, sourceIn: 1, rate: 2, transform: { x: 30, y: 10, scaleX: 2, scaleY: 2, rotation: 0, opacity: 0.5 } })).project;
  const resolved = resolveSequenceAt(doc, "root", 3)[0];
  assert.equal(resolved.clip.id, "leaf");
  assert.equal(resolved.sourceTime, 2);
  assert.equal(resolved.transform.x, 30);
  assert.equal(resolved.transform.opacity, 0.5);
  assert.deepEqual(resolved.sequencePath, ["root", doc.sequences.root.tracks[0].clips[0].id]);
});

test("Live2D actor resolves through nested clip source-in and rate", () => {
  let doc = project();
  const assetId = "model";
  const liveId = "live";
  doc = { ...doc, assets: { [assetId]: { id: assetId, kind: "live2d", name: "actor", uri: "actor.model3.json" } }, sequences: { ...doc.sequences, [liveId]: { id: liveId, name: "actor", kind: "live2d", duration: 10, width: 1920, height: 1080, fps: 30, tracks: [], animation: { tracks: [], groups: [], seed: 1 }, actors: [{ id: "actor-instance", assetId, modelPartId: "part", name: "actor", transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 }, visible: true }] } } };
  const track = doc.sequences.root.tracks[0];
  doc = insertClip(doc, "root", track.id, createClip({ kind: "sequence", sequenceId: liveId, name: "nested", start: 2, duration: 4, sourceIn: 1, rate: 2 })).project;
  const [actor] = resolveLive2DActorsAt(doc, "root", 3);
  assert.equal(actor.actor.id, "actor-instance");
  assert.equal(actor.sourceTime, 3);
});

test("compound clips retain source positions and reject visual blockers", () => {
  let doc = project();
  doc = addTrack(doc, "root", "上层");
  doc = addTrack(doc, "root", "最上层");
  const tracks = doc.sequences.root.tracks;
  doc = insertClip(doc, "root", tracks[0].id, clip("a", 0, 2)).project;
  doc = insertClip(doc, "root", tracks[1].id, clip("blocker", 0, 2)).project;
  doc = insertClip(doc, "root", tracks[2].id, clip("b", 0, 2)).project;
  assert.throws(() => createCompound(doc, "root", ["a", "b"], "有阻挡"), /未选片段/);
  const selected = ["a", "b"];
  const withoutBlocker = { ...doc, sequences: { ...doc.sequences, root: { ...doc.sequences.root, tracks: doc.sequences.root.tracks.map((track) => ({ ...track, clips: track.clips.filter((item) => item.id !== "blocker") })) } } };
  const made = createCompound(withoutBlocker, "root", selected, "组合");
  assert.equal(made.project.sequences[made.sequenceId].tracks.length, 2);
  const nested = made.project.sequences[made.sequenceId];
  assert.deepEqual(nested.tracks.map((track) => track.clips[0].start), [0, 0]);
  assert.throws(() => insertClip(made.project, "root", made.project.sequences.root.tracks[0].id, createClip({ kind: "sequence", sequenceId: "root", name: "循环", start: 20, duration: 1 })), /自身/);
});

test("history undo and redo include nested project edits", () => {
  const before = project();
  const history = new ProjectHistory(before);
  const track = before.sequences.root.tracks[0];
  const after = history.execute((doc) => insertClip(doc, "root", track.id, clip("one", 0, 1)).project);
  assert.equal(after.sequences.root.tracks[0].clips.length, 1);
  assert.deepEqual(history.undo(), before);
  assert.deepEqual(history.redo(), after);
});

test("nested audio flattening preserves source mapping, fades and mute", () => {
  let doc = project();
  const child = createEditSequence("子序列");
  child.id = "child-audio";
  child.tracks[0].muted = true;
  const audioAsset = { id: "asset-audio", kind: "audio" as const, name: "music", uri: "/music.wav", duration: 20 };
  doc = { ...doc, assets: { [audioAsset.id]: audioAsset }, sequences: { ...doc.sequences, [child.id]: child } };
  doc = insertClip(doc, child.id, child.tracks[0].id, createClip({ kind: "audio", assetId: audioAsset.id, name: "music", start: 1, duration: 6, sourceIn: 2, rate: 1.5, volume: 0.7, fadeIn: 0.5, fadeOut: 1 })).project;
  const rootTrack = doc.sequences.root.tracks[0];
  doc = insertClip(doc, "root", rootTrack.id, createClip({ kind: "sequence", sequenceId: child.id, name: "nested", start: 4, duration: 3, sourceIn: 2, rate: 2 })).project;
  const [audio] = resolveAudioSchedule(doc);
  assert.equal(audio.start, 4);
  assert.equal(audio.duration, 2.5);
  assert.equal(audio.sourceIn, 3.5);
  assert.equal(audio.rate, 3);
  assert.equal(audio.fadeIn, 0.25);
  assert.equal(audio.fadeOut, 0.5);
  assert.equal(audio.muted, true);
  assert.equal(audioGainAt(audio, 0.125), 0.7); // Original fade already elapsed before the parent's in-point.
  assert.equal(audio.gainEnvelopes![1].fadeInStart, -0.5);
});

test("hidden parent tracks hide nested visuals while audio remains independently resolvable", () => {
  let doc = project();
  const child = createEditSequence("nested"); child.id = "hidden-child";
  child.tracks[0].clips.push(createClip({ id: "nested-image", kind: "image", assetId: "image", name: "image", start: 0, duration: 4 }));
  doc = { ...doc, sequences: { ...doc.sequences, [child.id]: child }, assets: { image: { id: "image", kind: "image", name: "image", uri: "image.png" } } };
  const rootTrack = doc.sequences.root.tracks[0];
  doc = insertClip(doc, "root", rootTrack.id, createClip({ kind: "sequence", sequenceId: child.id, name: "nested", start: 0, duration: 4 })).project;
  const root = doc.sequences.root;
  doc = { ...doc, sequences: { ...doc.sequences, root: { ...root, tracks: root.tracks.map((track) => ({ ...track, hidden: true })) } } };
  assert.equal(resolveSequenceAt(doc, "root", 1)[0].visible, false);
});

test("legacy audio bridge retains source-in, speed, gain and fades", () => {
  const doc = migrateLegacyProject({
    selectedModel: null, playhead: 0, motionClips: [], exprClips: [], subtitleClips: [],
    audioClips: [{ id: "aud", name: "music", start: 0, duration: 3, audioPath: "/music.wav", audioSourceDuration: 8, sourceIn: 2, playbackRate: 1.5, gain: 0.4, fadeIn: 0.25, fadeOut: 0.5 }],
  });
  const synced = syncLegacyMedia(doc, [{ id: "aud", name: "music", start: 0, duration: 3, audioPath: "/music.wav", audioSourceDuration: 8, sourceIn: 2, playbackRate: 1.5, gain: 0.4, fadeIn: 0.25, fadeOut: 0.5 }], []);
  const [audio] = synced.sequences[synced.rootSequenceId].tracks.flatMap((track) => track.clips).filter((clip) => clip.kind === "audio");
  assert.deepEqual([audio.sourceIn, audio.rate, audio.volume, audio.fadeIn, audio.fadeOut], [2, 1.5, 0.4, 0.25, 0.5]);
});

test("independent compound clips deep-copy nested sequences", () => {
  let doc = project();
  const child = createEditSequence("child"); child.id = "copy-source";
  doc = { ...doc, sequences: { ...doc.sequences, [child.id]: child } };
  const rootTrack = doc.sequences.root.tracks[0];
  doc = insertClip(doc, "root", rootTrack.id, createClip({ id: "source-clip", kind: "sequence", sequenceId: child.id, name: "source", start: 0, duration: 2 })).project;
  const copied = createIndependentClip(doc, "root", rootTrack.id, "source-clip");
  const copiedClip = copied.project.sequences.root.tracks[0].clips.find((item) => item.id === copied.clipId)!;
  assert.notEqual(copiedClip.sequenceId, child.id);
  assert.equal(copied.project.sequences[copiedClip.sequenceId!].name, "child");
});

test("legacy project migration creates a V3 document with nested Live2D and media tracks", () => {
  const doc = migrateLegacyProject({
    selectedModel: "sample/model3.json",
    playhead: 0,
    motionClips: [], exprClips: [],
    audioClips: [{ id: "aud", name: "music", start: 1, duration: 4, audioPath: "/music.wav", audioSourceDuration: 4 }],
    subtitleClips: [{ id: "txt", name: "caption", start: 2, duration: 2, subtitleText: "hello" }],
  });
  assert.equal(doc.version, 3);
  assert.equal(doc.sequences["sequence:live2d:main"].kind, "live2d");
  assert.equal(doc.sequences[doc.rootSequenceId].kind, "edit");
  assert.equal(Object.values(doc.assets).filter((asset) => asset.kind === "audio").length, 1);
  assert.equal(isProjectDocument(doc), true);
});

test("locked tracks reject split, trim, speed, compound and deletion without mutation", () => {
  let doc = project();
  const lane = doc.sequences.root.tracks[0];
  doc = insertClip(doc, "root", lane.id, clip("locked", 0, 3)).project;
  doc.sequences.root.tracks[0].locked = true;
  const before = structuredClone(doc);
  assert.throws(() => splitClip(doc, "root", lane.id, "locked", 1), /锁定/);
  assert.throws(() => trimClip(doc, "root", lane.id, "locked", "right", 1), /锁定/);
  assert.throws(() => changeClipRate(doc, "root", lane.id, "locked", 0.5), /锁定/);
  assert.throws(() => createCompound(doc, "root", ["locked"]), /锁定/);
  assert.throws(() => deleteClips(doc, "root", ["locked"]), /锁定/);
  assert.deepEqual(doc, before);
});

test("slower playback and extension move colliding clips above the target lane", () => {
  let doc = project();
  const lane = doc.sequences.root.tracks[0];
  doc = insertClip(doc, "root", lane.id, clip("first", 0, 2)).project;
  doc = insertClip(doc, "root", lane.id, clip("later", 3, 2)).project;
  const slowed = changeClipRate(doc, "root", lane.id, "first", 0.5);
  assert.equal(slowed.sequences.root.tracks[0].clips[0].id, "first");
  assert.equal(slowed.sequences.root.tracks[1].clips[0].id, "later");
  const extended = trimClip(doc, "root", lane.id, "first", "right", 2);
  assert.equal(extended.sequences.root.tracks[0].clips[0].id, "first");
  assert.equal(extended.sequences.root.tracks[1].id, lane.id);
  const irregular = changeClipRate(doc, "root", lane.id, "first", 1.7);
  const changed = irregular.sequences.root.tracks.flatMap((track) => track.clips).find((item) => item.id === "first")!;
  assert.ok(Math.abs(changed.sourceIn + changed.duration * changed.rate - 2) < 1e-12);
  assert.ok(Math.abs(changed.duration * 30 - Math.round(changed.duration * 30)) < 1e-12);
});

test("selection movement clamps a common offset and collision relocates the whole lane span", () => {
  let doc = addTrack(project(), "root");
  doc = addTrack(doc, "root");
  const lanes = doc.sequences.root.tracks;
  doc = insertClip(doc, "root", lanes[1].id, clip("early", 1, 1)).project;
  doc = insertClip(doc, "root", lanes[2].id, clip("late", 3, 1)).project;
  const clamped = moveClips(doc, "root", ["early", "late"], "late", lanes[0].id, 0);
  const positions = clamped.sequences.root.tracks.flatMap((track) => track.clips.map((item) => [item.id, track.order, item.start]));
  assert.deepEqual(positions, [["early", 0, 0], ["late", 1, 2]]);
  doc = insertClip(doc, "root", lanes[0].id, clip("blocker", 5, 4)).project;
  const collided = moveClips(doc, "root", ["early", "late"], "early", lanes[0].id, 5);
  const moved = collided.sequences.root.tracks.flatMap((track) => track.clips.map((item) => ({ item, track }))).filter(({ item }) => ["early", "late"].includes(item.id));
  assert.deepEqual(moved.map(({ item, track }) => [item.id, track.order, item.start]), [["early", 0, 5], ["late", 1, 7]]);
  assert.equal(collided.sequences.root.tracks.find((track) => track.clips.some((item) => item.id === "blocker"))!.order, 2);
});

test("nested source-time property curves and rotated translations seek deterministically", () => {
  let doc = project();
  const child = createEditSequence("child"); child.id = "key-child";
  const leaf = createClip({ id: "leaf", kind: "image", name: "leaf", start: 0, duration: 8, transform: { ...DEFAULT_TRANSFORM, x: 4 }, transformKeys: [
    { id: "a", time: 2, ...DEFAULT_TRANSFORM, x: 10 },
    { id: "b", time: 4, ...DEFAULT_TRANSFORM, x: 30, opacity: 0.5 },
  ], volume: 0.4, volumeKeys: [{ id: "a", time: 2, value: 0.2 }, { id: "b", time: 4, value: 0.8 }] });
  child.tracks[0].clips = [leaf];
  doc = { ...doc, sequences: { ...doc.sequences, [child.id]: child } };
  doc = insertClip(doc, "root", doc.sequences.root.tracks[0].id, createClip({ kind: "sequence", sequenceId: child.id, name: "child", start: 0, duration: 4, sourceIn: 1, rate: 2, volume: 0.5, transform: { ...DEFAULT_TRANSFORM, x: 10, rotation: 90, scaleX: 2 } })).project;
  const at = resolveSequenceAt(doc, "root", 1)[0];
  assert.equal(at.sourceTime, 3);
  assert.ok(Math.abs(at.transform.x - 10) < 1e-10);
  assert.equal(at.transform.y, 40);
  assert.equal(at.transform.opacity, 0.75);
  assert.equal(at.volume, 0.25);
  assert.equal(evaluateClipTransform(leaf, 0).x, 4);
  assert.equal(clipVolumeAt(leaf, 0), 0.4);
  assert.equal(evaluateClipTransform(leaf, 7).x, 30);
  assert.deepEqual(resolveSequenceAt(doc, "root", 1), at ? [at] : []);
});

test("top track draws last and compound preserves visual layer ordering", () => {
  let doc = addTrack(project(), "root");
  doc = addTrack(doc, "root");
  const lanes = doc.sequences.root.tracks;
  for (const [index, id] of ["top", "middle", "bottom"].entries()) doc = insertClip(doc, "root", lanes[index].id, clip(id, 0, 3)).project;
  assert.deepEqual(resolveSequenceAt(doc, "root", 1).map(({ clip }) => clip.name), ["bottom", "middle", "top"]);
  const made = createCompound(doc, "root", ["top", "middle", "bottom"]);
  assert.deepEqual(resolveSequenceAt(made.project, "root", 1).map(({ clip }) => clip.name), ["bottom", "middle", "top"]);
});

test("nested audio multiplies keyed parent gain and keeps clipped fade phase", () => {
  let doc = project();
  const child = createEditSequence("child"); child.id = "envelope-child";
  doc = { ...doc, assets: { audio: { id: "audio", kind: "audio", name: "audio", uri: "audio.wav", duration: 12 } }, sequences: { ...doc.sequences, [child.id]: child } };
  doc = insertClip(doc, child.id, child.tracks[0].id, createClip({ kind: "audio", assetId: "audio", name: "audio", start: 0, duration: 8, volume: 0.8, fadeIn: 4, fadeOut: 2, volumeKeys: [{ id: "k1", time: 2, value: 0.4 }, { id: "k2", time: 6, value: 0.8 }] })).project;
  doc = insertClip(doc, "root", doc.sequences.root.tracks[0].id, createClip({ kind: "sequence", sequenceId: child.id, name: "child", start: 5, duration: 2, sourceIn: 2, rate: 2, volume: 0.5, volumeKeys: [{ id: "v1", time: 2, value: 0.2 }, { id: "v2", time: 6, value: 0.6 }] })).project;
  const [scheduled] = resolveAudioSchedule(doc);
  assert.equal(audioGainAt(scheduled, 0), 0.2 * 0.4 * 0.5);
  assert.ok(Math.abs(audioGainAt(scheduled, 1) - 0.4 * 0.6) < 1e-12);
  assert.equal(scheduled.gainEnvelopes![1].fadeInStart, -1);
  assert.equal(scheduled.gainEnvelopes![1].fadeInDuration, 2);
  assert.equal(audioGainAt(scheduled, -1), 0);
});

test("splitting or trimming audio preserves gain at the corresponding original source time", () => {
  let doc = project();
  const lane = doc.sequences.root.tracks[0];
  doc.assets.audio = { id: "audio", kind: "audio", name: "audio", uri: "audio.wav", duration: 12 };
  doc = insertClip(doc, "root", lane.id, createClip({ id: "faded", kind: "audio", assetId: "audio", name: "audio", start: 1, duration: 6, fadeIn: 3, fadeOut: 2 })).project;
  const original = resolveAudioSchedule(doc)[0];
  const split = resolveAudioSchedule(splitClip(doc, "root", lane.id, "faded", 3));
  for (const time of [1.5, 2, 2.5, 3, 4, 5.5, 6.5]) {
    const item = split.find((item) => item.start <= time && item.start + item.duration > time)!;
    assert.ok(Math.abs(audioGainAt(item, time - item.start) - audioGainAt(original, time - original.start)) < 1e-12);
  }
  const trimmed = resolveAudioSchedule(trimClip(doc, "root", lane.id, "faded", "left", 1))[0];
  assert.equal(audioGainAt(trimmed, 0.5), audioGainAt(original, 1.5));
});

test("independent Live2D copies remap actors, parameter targets, material groups and lip bindings", () => {
  const doc = migrateLegacyProject({ selectedModel: "model.model3.json", motionClips: [], exprClips: [], audioClips: [], subtitleClips: [], playhead: 0 });
  const live = doc.sequences["sequence:live2d:main"];
  assert.equal(live.kind, "live2d");
  if (live.kind !== "live2d") return;
  const oldTarget = targetId("main", "0", "ParamX");
  const key = { id: "k", time: 1, value: 2, interpolation: "linear" as const };
  live.animation = { seed: 1, tracks: [{ definition: { target: oldTarget, characterId: "main", partId: "0", parameterId: "ParamX", name: "X", group: "参数", kind: "parameter", min: -10, max: 10, defaultValue: 0 }, baseValue: 0, animated: true, keys: [key] }], groups: [{ id: "g", name: "motion", kind: "motion", start: 0, duration: 2, sourceDuration: 2, offset: 0, speed: 1, curves: { [oldTarget]: [key] }, originalCurves: { [oldTarget]: [key] } }] };
  live.tracks.push({ ...createEditSequence().tracks[0], clips: [createClip({ kind: "audio", assetId: "audio", name: "audio", start: 0, duration: 2, lipSyncActorId: live.actors[0].id })] });
  const rootTrack = doc.sequences[doc.rootSequenceId].tracks[0];
  const made = createIndependentClip(doc, doc.rootSequenceId, rootTrack.id, "clip:live2d:main");
  const copyClip = made.project.sequences[doc.rootSequenceId].tracks.flatMap((track) => track.clips).find((item) => item.id === made.clipId)!;
  const copy = made.project.sequences[copyClip.sequenceId!];
  assert.equal(copy.kind, "live2d");
  if (copy.kind !== "live2d") return;
  const newActor = copy.actors[0].id;
  assert.notEqual(newActor, live.actors[0].id);
  const newTarget = targetId(newActor, "0", "ParamX");
  assert.equal(copy.animation.tracks[0].definition.target, newTarget);
  assert.ok(copy.animation.groups[0].curves[newTarget]);
  assert.ok(copy.animation.groups[0].originalCurves![newTarget]);
  assert.equal(copy.tracks[0].clips[0].lipSyncActorId, newActor);
  copy.animation.tracks[0].keys[0].value = 8;
  assert.equal(live.animation.tracks[0].keys[0].value, 2);
  assert.equal(sequenceDuration(copy), 5);
  copy.animation.tracks[0].keys.push({ ...key, id: "later", time: 8 });
  assert.equal(sequenceDuration(copy), 8);
});

test("legacy sync preserves V3 library clips, mixed lanes and keyframes", () => {
  let doc = project();
  const lane = doc.sequences.root.tracks[0];
  doc.assets.audio = { id: "audio", kind: "audio", name: "audio", uri: "audio.wav", duration: 9 };
  doc = insertClip(doc, "root", lane.id, createClip({ id: "v3-audio", kind: "audio", assetId: "audio", name: "audio", start: 2, duration: 4, volumeKeys: [{ id: "k", time: 2, value: 0.3 }] })).project;
  const stale = syncLegacyMedia(doc, [], []);
  assert.equal(stale, doc);
  const projected = syncLegacyMedia(doc, [{ id: "v3-audio", name: "audio", start: 0, duration: 1 }], []);
  assert.equal(projected, doc);
  const migrated = migrateLegacyProject({ selectedModel: null, motionClips: [], exprClips: [], subtitleClips: [], audioClips: [{ id: "old", name: "old", start: 0, duration: 2, audioPath: "old.wav" }], playhead: 0 });
  const mediaLane = migrated.sequences[migrated.rootSequenceId].tracks.find((track) => track.clips.some((item) => item.id === "old"))!;
  mediaLane.name = "混合轨";
  mediaLane.clips[0].volumeKeys = [{ id: "key", time: 1, value: 0.5 }];
  const synced = syncLegacyMedia(migrated, [{ id: "old", name: "old", start: 3, duration: 2, audioPath: "old.wav" }], []);
  const updatedLane = synced.sequences[synced.rootSequenceId].tracks.find((track) => track.clips.some((item) => item.id === "old"))!;
  assert.equal(updatedLane.id, mediaLane.id);
  assert.deepEqual(updatedLane.clips[0].volumeKeys, mediaLane.clips[0].volumeKeys);
  assert.equal(syncLegacyMedia(synced, [], []).sequences[synced.rootSequenceId].tracks.flatMap((track) => track.clips).length, 1);
  assert.equal(syncLegacyMedia(synced, [], [], { previousAudioIds: ["old"] }).sequences[synced.rootSequenceId].tracks.flatMap((track) => track.clips).length, 0);
});

test("V3 validation rejects cyclic graphs, duplicate clip IDs and malformed property keys", () => {
  const doc = migrateLegacyProject({ selectedModel: "model.model3.json", motionClips: [], exprClips: [], subtitleClips: [], audioClips: [], playhead: 0 });
  assert.equal(isProjectDocument(doc), true);
  const badKeys = structuredClone(doc);
  badKeys.sequences[doc.rootSequenceId].tracks[0].clips[0].volumeKeys = [{ id: "k", time: 1, value: NaN }];
  assert.equal(isProjectDocument(badKeys), false);
  const badIds = structuredClone(doc);
  badIds.sequences[doc.rootSequenceId].tracks.push({ ...createEditSequence().tracks[0], order: 1, clips: structuredClone(badIds.sequences[doc.rootSequenceId].tracks[0].clips) });
  assert.equal(isProjectDocument(badIds), false);
  const cyclic = structuredClone(doc);
  const nested = cyclic.sequences["sequence:live2d:main"];
  nested.tracks.push({ ...createEditSequence().tracks[0], clips: [createClip({ kind: "sequence", sequenceId: doc.rootSequenceId, name: "cycle", start: 0, duration: 5 })] });
  assert.equal(isProjectDocument(cyclic), false);
  assert.throws(() => resolveAudioSchedule(cyclic), /循环/);
  assert.throws(() => resolveSequenceAt(cyclic, doc.rootSequenceId, 1), /循环/);
});

test("legacy overlapping media migrate onto independent tracks without data loss", () => {
  const doc = migrateLegacyProject({ selectedModel: null, motionClips: [], exprClips: [], subtitleClips: [], audioClips: [
    { id: "one", name: "one", start: 0, duration: 3, audioPath: "one.wav" },
    { id: "two", name: "two", start: 1, duration: 4, audioPath: "two.wav" },
  ], playhead: 0 });
  assert.equal(isProjectDocument(doc), true);
  assert.equal(doc.sequences[doc.rootSequenceId].tracks.flatMap((track) => track.clips).length, 2);
  assert.equal(doc.sequences[doc.rootSequenceId].duration, 5);
});

test("legacy hidden subtitles retain hidden state on every collision lane and speaker metadata", () => {
  const doc = migrateLegacyProject({ selectedModel: null, motionClips: [], exprClips: [], audioClips: [], subtitleClips: [
    { id: "one", name: "one", start: 0, duration: 3, subtitleText: "正文一", speakerName: "Anon" },
    { id: "two", name: "two", start: 1, duration: 4, subtitleText: "正文二", speakerName: "Soyo" },
  ], playhead: 0, showSubtitles: false, showSubtitleSpeaker: false, subtitleSpeakerAlign: "left" });
  assert.equal(isProjectDocument(doc), true);
  const textTracks = doc.sequences[doc.rootSequenceId].tracks.filter((track) => track.clips.some((clip) => clip.kind === "text"));
  assert.equal(textTracks.length, 2);
  assert.ok(textTracks.every((track) => track.hidden && !track.muted));
  assert.deepEqual(Object.values(doc.assets).map((asset) => [asset.metadata!.speaker, asset.metadata!.showSpeaker, asset.metadata!.speakerAlign]), [["Anon", false, "left"], ["Soyo", false, "left"]]);
  const reopened = JSON.parse(JSON.stringify(doc));
  assert.equal(isProjectDocument(reopened), true);
  assert.ok(reopened.sequences[doc.rootSequenceId].tracks.filter((track: { clips: Array<{ kind: string }> }) => track.clips.some((clip) => clip.kind === "text")).every((track: { hidden: boolean }) => track.hidden));
});

test("legacy subtitle migration preserves visible speaker defaults and an explicit right alignment", () => {
  const input = { selectedModel: null, motionClips: [], exprClips: [], audioClips: [], subtitleClips: [{ id: "line", name: "line", start: 0, duration: 2, subtitleText: "正文", speakerName: "Anon" }], playhead: 0 };
  const defaults = migrateLegacyProject(input);
  const textTrack = defaults.sequences[defaults.rootSequenceId].tracks.find((track) => track.clips.some((clip) => clip.kind === "text"))!;
  assert.equal(textTrack.hidden, false);
  assert.equal(defaults.assets["asset:text:line"].metadata!.showSpeaker, true);
  assert.equal(defaults.assets["asset:text:line"].metadata!.speakerAlign, "center");
  const explicit = migrateLegacyProject({ ...input, showSubtitles: true, showSubtitleSpeaker: true, subtitleSpeakerAlign: "right" });
  assert.equal(explicit.assets["asset:text:line"].metadata!.speakerAlign, "right");
});

test("legacy media synchronization preserves migrated speaker flags and hidden lanes", () => {
  const subtitle = { id: "line", name: "line", start: 0, duration: 2, subtitleText: "正文", speakerName: "Anon", fontFamily: "serif", fontSize: 34, textColor: "#ffffff" };
  const migrated = migrateLegacyProject({ selectedModel: null, motionClips: [], exprClips: [], audioClips: [], subtitleClips: [subtitle], playhead: 0, showSubtitles: false, showSubtitleSpeaker: false, subtitleSpeakerAlign: "right" });
  const synced = syncLegacyMedia(migrated, [], [subtitle]);
  assert.equal(synced.assets["asset:text:line"].metadata!.showSpeaker, false);
  assert.equal(synced.assets["asset:text:line"].metadata!.speakerAlign, "right");
  assert.ok(synced.sequences[synced.rootSequenceId].tracks.filter((track) => track.clips.some((clip) => clip.kind === "text")).every((track) => track.hidden));
  assert.equal(isProjectDocument(synced), true);
});

test("audio source bounds reject invalid inspector edits without moving or truncating other data", () => {
  let doc = project();
  doc.assets.audio = { id: "audio", kind: "audio", name: "audio", uri: "audio.wav", duration: 4 };
  const lane = doc.sequences.root.tracks[0];
  doc = insertClip(doc, "root", lane.id, createClip({ id: "audio", kind: "audio", assetId: "audio", name: "audio", start: 0, duration: 2, sourceIn: 1 })).project;
  const before = structuredClone(doc);
  assert.throws(() => updateClip(doc, "root", lane.id, "audio", { sourceIn: 3 }), /素材/);
  assert.throws(() => updateClip(doc, "root", lane.id, "audio", { duration: 4 }), /实际时长/);
  assert.throws(() => insertClip(doc, "root", lane.id, createClip({ kind: "audio", assetId: "audio", name: "audio", start: 6, duration: 5 })), /实际时长/);
  assert.deepEqual(doc, before);
  const trimmed = trimClip(doc, "root", lane.id, "audio", "right", 5, 30, 4);
  assert.equal(trimmed.sequences.root.tracks[0].clips[0].duration, 3);
});

test("shared nested audio references expose separate binding paths and mapped source times", () => {
  let doc = project();
  const child = createEditSequence("child"); child.id = "shared-child";
  child.tracks[0].clips.push(createClip({ id: "audio", kind: "audio", assetId: "audio-asset", name: "audio", start: 0, duration: 6, lipSyncActorId: "actor" }));
  doc = { ...doc, assets: { "audio-asset": { id: "audio-asset", kind: "audio", name: "audio", uri: "audio.wav", duration: 10 } }, sequences: { ...doc.sequences, [child.id]: child } };
  const lane = doc.sequences.root.tracks[0];
  doc = insertClip(doc, "root", lane.id, createClip({ id: "one", kind: "sequence", sequenceId: child.id, name: "one", start: 0, duration: 3 })).project;
  doc = insertClip(doc, "root", lane.id, createClip({ id: "two", kind: "sequence", sequenceId: child.id, name: "two", start: 4, duration: 2, sourceIn: 2, rate: 2 })).project;
  const [first, second] = resolveAudioSchedule(doc);
  assert.equal(first.lipSyncActorId, "actor");
  assert.equal(second.lipSyncActorId, "actor");
  assert.deepEqual(first.sequencePath, ["root", "one"]);
  assert.deepEqual(second.sequencePath, ["root", "two"]);
  assert.notEqual(first.id, second.id);
  assert.equal(second.sourceIn, 2);
  assert.equal(second.rate, 2);
});

test("missing V1 model retains motion/expression sources and timing in a repairable V3 placeholder", () => {
  const motions = [{ id: "motion", name: "walk", start: 2.25, duration: 3.75 }];
  const expressions = [{ id: "expression", name: "smile", start: 5.5, duration: 2.5 }];
  const before = structuredClone({ motions, expressions });
  const doc = migrateLegacyProject({ selectedModel: null, motionClips: motions, exprClips: expressions, audioClips: [], subtitleClips: [], playhead: 0 });
  assert.equal(isProjectDocument(doc), true);
  const asset = doc.assets["asset:model:main"];
  assert.equal(asset.missing, true);
  assert.equal(asset.uri, "");
  assert.deepEqual(JSON.parse(String(asset.metadata!.legacyMotions)), motions);
  assert.deepEqual(JSON.parse(String(asset.metadata!.legacyExpressions)), expressions);
  const [modelClip] = doc.sequences[doc.rootSequenceId].tracks.flatMap((track) => track.clips);
  assert.equal(modelClip.duration, 8);
  assert.equal(modelClip.placeholder?.reason, "旧动画等待模型转换");
  assert.deepEqual(modelClip.placeholder?.original, { motionClips: motions, exprClips: expressions });
  const reopened = JSON.parse(JSON.stringify(doc));
  assert.equal(isProjectDocument(reopened), true);
  assert.deepEqual(JSON.parse(reopened.assets["asset:model:main"].metadata.legacyMotions), before.motions);
  assert.deepEqual({ motions, expressions }, before);
});

test("V2 static transform migration preserves original scale metadata and bottom-positioned text", () => {
  const oldTransform = { x: 10, y: -20, scaleX: .3, scaleY: .4, rotation: 15 };
  const doc = migrateLegacyProject({ selectedModel: "model.model3.json", motionClips: [], exprClips: [], audioClips: [], subtitleClips: [{ id: "caption", name: "caption", start: 1, duration: 2, subtitleText: "hello" }], playhead: 0, width: 1280, height: 720, fps: 24, characterTransform: oldTransform, characterTransformMode: "single-relative" });
  const model = doc.sequences["sequence:live2d:main"];
  if (model.kind !== "live2d") throw new Error("expected Live2D");
  assert.deepEqual(model.actors[0].transform, { x: 64, y: -72, scaleX: .3, scaleY: .4, rotation: 15, opacity: 1 });
  assert.equal(doc.assets["asset:model:main"].metadata?.legacyTransform, true);
  assert.deepEqual(JSON.parse(String(doc.assets["asset:model:main"].metadata?.legacyTransformJson)), oldTransform);
  const text = doc.sequences[doc.rootSequenceId].tracks.flatMap((track) => track.clips).find((clip) => clip.kind === "text")!;
  assert.equal(text.transform.y, 300);
  assert.equal(doc.sequences[doc.rootSequenceId].tracks[0].clips[0].kind, "text");
  assert.equal(doc.fps, 24);
  assert.equal(doc.width, 1280);
});
