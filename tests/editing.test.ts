import { test } from "node:test";
import assert from "node:assert/strict";
import { createClip, createEditSequence, createTrack, DEFAULT_TRANSFORM } from "../src/sequence/types";
import type { Clip, ProjectDocument } from "../src/sequence/types";
import { deleteClips, duplicateClips, ProjectHistory, resolveSequenceAt } from "../src/sequence/engine";
import { editTimelineClip, linkClips, linkedClipIds, linkedTrimDelta, moveTimelineClips, pasteTimelineClips, rippleDeleteClips, rippleDeleteRanges, splitTimelineClips, trimLinkedClips, unlinkClips } from "../src/sequence/editing";
import { adjacentEditTime, formatTimecode, parseTimecode } from "../src/sequence/navigation";
import { isProjectDocument } from "../src/sequence/validation";

function fixture(): ProjectDocument {
  const root = createEditSequence("主序列"); root.id = "root";
  root.tracks = [createTrack(0), createTrack(1), createTrack(2)];
  root.tracks.forEach((track, index) => { track.id = `t${index}`; });
  return { version: 3, id: "p", name: "test", assets: { image: { id: "image", name: "image", kind: "image", uri: "image.png" }, audio: { id: "audio", name: "audio", kind: "audio", uri: "voice.wav", duration: 20 }, text: { id: "text", name: "text", kind: "text", uri: "" } }, sequences: { root }, rootSequenceId: "root", width: 1920, height: 1080, fps: 30, seed: 1, savedAt: "" };
}
function clip(id: string, start: number, duration: number, kind: "image" | "audio" | "text" = "image", patch: Partial<Clip> = {}) {
  return createClip({ id, name: id, kind, assetId: kind, start, duration, ...patch });
}
const all = (project: ProjectDocument) => project.sequences.root.tracks.flatMap((track) => track.clips);
const times = (clips: Clip[]) => clips.map((clip) => [clip.start, clip.duration, clip.sourceIn]);

test("free placement retains collision lanes and leaves later media unchanged", () => {
  const p = fixture(); p.sequences.root.tracks[0].clips = [clip("a", 0, 4)];
  const result = editTimelineClip(p, "root", "t0", clip("new", 1, 2), "free");
  assert.equal(result.createdTrack, true); assert.equal(result.project.sequences.root.tracks.length, 4);
  assert.deepEqual(times([all(result.project).find((clip) => clip.id === "a")!]), [[0, 4, 0]]);
  assert.equal(p.sequences.root.tracks.length, 3);
});

test("insert splits crossing media on every track and preserves source keys and fades", () => {
  const p = fixture(), original = clip("a", 0, 6, "image", { sourceIn: 2, rate: 2, transformKeys: [{ id: "k", time: 3.125, ...DEFAULT_TRANSFORM, x: 10 }] });
  p.sequences.root.tracks[0].clips = [original];
  p.sequences.root.tracks[1].clips = [clip("voice", 1, 4, "audio", { fadeIn: 1, fadeOut: 2 })];
  p.sequences.root.tracks[2].clips = [clip("later", 8, 2)];
  const result = editTimelineClip(p, "root", "t0", clip("new", 3, 2), "insert").project;
  assert.deepEqual(times(result.sequences.root.tracks[0].clips), [[0, 3, 2], [3, 2, 0], [5, 3, 8]]);
  assert.deepEqual(times(result.sequences.root.tracks[1].clips), [[1, 2, 0], [5, 2, 2]]);
  assert.equal(all(result).find((clip) => clip.id === "later")!.start, 10);
  assert.equal(result.sequences.root.tracks[0].clips[2].transformKeys[0].time, 3.125);
  assert.deepEqual(result.sequences.root.tracks[1].clips[1].fadeRegion, { sourceIn: 0, sourceDuration: 4, rate: 1 });
  assert.equal(original.duration, 6); assert.ok(isProjectDocument(result));
});

test("overwrite replaces only the target lane and preserves both outside sections", () => {
  const p = fixture(); p.sequences.root.tracks[0].clips = [clip("a", 0, 6, "image", { rate: 2, sourceIn: 1 })];
  p.sequences.root.tracks[1].clips = [clip("voice", 0, 6, "audio")];
  const result = editTimelineClip(p, "root", "t0", clip("new", 2, 2), "overwrite").project;
  assert.equal(result.sequences.root.tracks.length, 3);
  assert.deepEqual(times(result.sequences.root.tracks[0].clips), [[0, 2, 1], [2, 2, 0], [4, 2, 9]]);
  assert.deepEqual(result.sequences.root.tracks[1], p.sequences.root.tracks[1]);
  assert.equal(result.sequences.root.tracks[0].clips[0].id, "a");
  assert.ok(isProjectDocument(result));
});

test("insert and ripple deletion reject affected locked tracks without changing the project", () => {
  const p = fixture(); p.sequences.root.tracks[1].clips = [clip("locked", 8, 2)]; p.sequences.root.tracks[1].locked = true;
  const before = JSON.stringify(p);
  assert.throws(() => editTimelineClip(p, "root", "t0", clip("new", 2, 1), "insert"), /锁定/);
  assert.throws(() => rippleDeleteRanges(p, "root", [{ start: 2, end: 3 }]), /锁定/);
  assert.equal(JSON.stringify(p), before);
  assert.doesNotThrow(() => editTimelineClip(p, "root", "t0", clip("new", 2, 1), "overwrite"));
});

test("a locked track wholly before the edit point does not obstruct insertion", () => {
  const p = fixture(); p.sequences.root.tracks[1].clips = [clip("locked", 0, 1)]; p.sequences.root.tracks[1].locked = true;
  assert.doesNotThrow(() => editTimelineClip(p, "root", "t0", clip("new", 2, 1), "insert"));
});

test("audio placement rounds inward at an unaligned source end and rejects invalid input", () => {
  const p = fixture(); p.assets.audio.duration = 2.35;
  const result = editTimelineClip(p, "root", "t0", clip("voice", 0, 2.35, "audio"), "insert").project;
  assert.equal(all(result)[0].duration, 70 / 30);
  assert.throws(() => editTimelineClip(p, "root", "t0", clip("invalid", -0.001, 1), "free"));
  assert.throws(() => editTimelineClip(p, "root", "t0", clip("invalid", 0, 0), "overwrite"));
});

test("ripple ranges merge overlaps, cut all crossing media and collapse time once", () => {
  const p = fixture(); p.sequences.root.tracks[0].clips = [clip("bg", 0, 10)];
  p.sequences.root.tracks[1].clips = [clip("voice", 1, 8, "audio", { sourceIn: 2 })];
  const result = rippleDeleteRanges(p, "root", [{ start: 2, end: 4 }, { start: 3, end: 5 }, { start: 7, end: 8 }]);
  assert.deepEqual(times(result.sequences.root.tracks[0].clips), [[0, 2, 0], [2, 2, 5], [4, 2, 8]]);
  assert.deepEqual(times(result.sequences.root.tracks[1].clips), [[1, 1, 2], [2, 2, 6], [4, 1, 9]]);
  assert.equal(result.sequences.root.duration, 6); assert.ok(isProjectDocument(result));
});

test("ripple deletion by selected clips removes their union, not the span of gaps", () => {
  const p = fixture(); p.sequences.root.tracks[0].clips = [clip("a", 1, 1), clip("b", 4, 1), clip("c", 7, 1)];
  const result = rippleDeleteClips(p, "root", ["a", "b"]);
  assert.deepEqual(times(all(result)), [[5, 1, 0]]);
});

test("ripple deletion preserves locked media before the removed range exactly", () => {
  const p = fixture(); p.sequences.root.tracks[0].clips = [clip("before", 0, 1, "audio", { fadeIn: 0.2 })]; p.sequences.root.tracks[0].locked = true;
  p.sequences.root.tracks[1].clips = [clip("later", 5, 1)];
  const result = rippleDeleteRanges(p, "root", [{ start: 2, end: 3 }]);
  assert.deepEqual(result.sequences.root.tracks[0], p.sequences.root.tracks[0]);
  assert.equal(all(result).find((clip) => clip.id === "later")!.start, 4);
});

test("linking merges complete existing groups and persists through JSON validation", () => {
  let p = fixture(); p.sequences.root.tracks[0].clips = [clip("a", 0, 2)]; p.sequences.root.tracks[1].clips = [clip("b", 0.5, 2, "audio")]; p.sequences.root.tracks[2].clips = [clip("c", 1, 1, "text")];
  p = linkClips(p, "root", ["a", "b"]); p = linkClips(p, "root", ["b", "c"]);
  assert.deepEqual(linkedClipIds(p.sequences.root, ["a"]), ["a", "b", "c"]);
  assert.ok(isProjectDocument(JSON.parse(JSON.stringify(p))));
  p = unlinkClips(p, "root", ["b"]); assert.ok(all(p).every((clip) => !clip.linkGroupId));
});

test("linked move retains offsets and clip IDs in each editing mode", () => {
  for (const mode of ["free", "insert", "overwrite"] as const) {
    let p = fixture(); p.sequences.root.tracks[0].clips = [clip("a", 1, 2)]; p.sequences.root.tracks[1].clips = [clip("b", 1.5, 1, "audio")];
    p = linkClips(p, "root", ["a", "b"]);
    const result = moveTimelineClips(p, "root", ["a", "b"], "a", "t1", 5, mode);
    assert.deepEqual(times(all(result)), [[5, 2, 0], [5.5, 1, 0]]);
    assert.deepEqual(all(result).map((clip) => clip.id), ["a", "b"]);
    assert.equal(result.sequences.root.tracks[1].clips[0].id, "a");
    assert.equal(result.sequences.root.tracks[2].clips[0].id, "b");
    assert.deepEqual(linkedClipIds(result.sequences.root, ["a"]), ["a", "b"]);
  }
});

test("linked trim clamps every member to the same feasible delta", () => {
  let p = fixture(); p.assets.audio.duration = 3;
  p.sequences.root.tracks[0].clips = [clip("a", 1, 2)]; p.sequences.root.tracks[1].clips = [clip("b", 1.5, 2, "audio", { sourceIn: 0.5 })];
  p = linkClips(p, "root", ["a", "b"]);
  assert.equal(linkedTrimDelta(p, "root", ["a", "b"], "right", 5), 0.5);
  p = trimLinkedClips(p, "root", ["a", "b"], "right", 5);
  assert.deepEqual(times(all(p)), [[1, 2.5, 0], [1.5, 2.5, 0.5]]);
  p = trimLinkedClips(p, "root", ["a", "b"], "left", -1);
  assert.deepEqual(times(all(p)), [[1, 2.5, 0], [1.5, 2.5, 0.5]]);
});

test("split gives the left and right linked halves separate associations", () => {
  let p = fixture(); p.sequences.root.tracks[0].clips = [clip("a", 0, 4)]; p.sequences.root.tracks[1].clips = [clip("b", 0, 4, "audio")];
  p = linkClips(p, "root", ["a", "b"]); const result = splitTimelineClips(p, "root", ["a", "b"], 2);
  const a = result.sequences.root.tracks[0].clips, b = result.sequences.root.tracks[1].clips;
  assert.equal(a[0].linkGroupId, b[0].linkGroupId); assert.equal(a[1].linkGroupId, b[1].linkGroupId);
  assert.notEqual(a[0].linkGroupId, a[1].linkGroupId); assert.deepEqual(times(a), [[0, 2, 0], [2, 2, 2]]);
});

test("insertion separates associations on either side of the inserted time", () => {
  let p = fixture(); p.sequences.root.tracks[0].clips = [clip("a", 0, 4)]; p.sequences.root.tracks[1].clips = [clip("b", 0, 4, "audio")];
  p = linkClips(p, "root", ["a", "b"]); const result = editTimelineClip(p, "root", "t2", clip("new", 2, 1, "text"), "insert").project;
  assert.deepEqual(linkedClipIds(result.sequences.root, ["a"]), ["a", "b"]);
  assert.notEqual(result.sequences.root.tracks[0].clips[0].linkGroupId, result.sequences.root.tracks[0].clips[1].linkGroupId);
});

test("copy and paste remap associations in all modes, partial copies become independent", () => {
  for (const mode of ["free", "insert", "overwrite"] as const) {
    let p = fixture(); p.sequences.root.tracks[0].clips = [clip("a", 0, 2)]; p.sequences.root.tracks[1].clips = [clip("b", 0, 2, "audio")];
    p = linkClips(p, "root", ["a", "b"]); const oldGroup = all(p)[0].linkGroupId;
    const result = pasteTimelineClips(p, "root", "t0", 5, all(p).map((clip, trackOffset) => ({ clip, trackOffset, timeOffset: 0 })), mode);
    const copied = all(result.project).filter((clip) => result.clipIds.includes(clip.id));
    assert.equal(copied[0].linkGroupId, copied[1].linkGroupId); assert.notEqual(copied[0].linkGroupId, oldGroup);
    assert.deepEqual(new Set(linkedClipIds(result.project.sequences.root, [copied[0].id])), new Set(result.clipIds));
    const partial = pasteTimelineClips(p, "root", "t0", 8, [{ clip: all(p)[0], trackOffset: 0, timeOffset: 0 }], mode);
    assert.equal(all(partial.project).find((clip) => partial.clipIds.includes(clip.id))!.linkGroupId, undefined);
  }
});

test("multi-track insertion paste pushes time once for the group's total span", () => {
  const p = fixture(); p.sequences.root.tracks[2].clips = [clip("later", 10, 2)];
  const result = pasteTimelineClips(p, "root", "t0", 3, [{ clip: clip("a", 0, 2), trackOffset: 0, timeOffset: 0 }, { clip: clip("b", 1, 3, "audio"), trackOffset: 1, timeOffset: 1 }], "insert");
  assert.equal(all(result.project).find((clip) => clip.id === "later")!.start, 14);
});

test("deleting a member dissolves orphan links and duplication keeps originals independent", () => {
  let p = fixture(); p.sequences.root.tracks[0].clips = [clip("a", 0, 2)]; p.sequences.root.tracks[1].clips = [clip("b", 0, 2, "audio")];
  p = linkClips(p, "root", ["a", "b"]);
  const result = duplicateClips(p, "root", ["a", "b"], 5);
  assert.equal(linkedClipIds(result.sequences.root, ["a"]).length, 2);
  assert.equal(all(deleteClips(p, "root", ["b"]))[0].linkGroupId, undefined);
});

test("nested source time mapping and subframe keys survive overwrite and ripple", () => {
  const p = fixture(), child = createEditSequence("child"); child.id = "child";
  child.tracks[0].clips = [clip("inside", 0, 20)]; p.sequences.child = child;
  p.sequences.root.tracks[0].clips = [createClip({ id: "nested", kind: "sequence", sequenceId: "child", name: "nested", start: 0, duration: 8, sourceIn: 1, rate: 2 })];
  const result = rippleDeleteRanges(p, "root", [{ start: 2, end: 3 }]);
  assert.equal(resolveSequenceAt(result, "root", 3).find((item) => item.clip.id === "inside")!.sourceTime, 9);
  assert.deepEqual(result.sequences.child, child);
});

test("each editing command restores the full document through undo and redo", () => {
  const p = fixture(); p.sequences.root.tracks[0].clips = [clip("a", 0, 4)]; p.sequences.root.tracks[1].clips = [clip("b", 0, 4, "audio")];
  const history = new ProjectHistory(p);
  const linked = history.execute((doc) => linkClips(doc, "root", ["a", "b"]));
  const inserted = history.execute((doc) => editTimelineClip(doc, "root", "t2", clip("new", 1, 1, "text"), "insert").project);
  const deleted = history.execute((doc) => rippleDeleteRanges(doc, "root", [{ start: 2, end: 3 }]));
  assert.deepEqual(history.undo(), inserted); assert.deepEqual(history.undo(), linked); assert.deepEqual(history.undo(), p);
  assert.deepEqual(history.redo(), linked); assert.deepEqual(history.redo(), inserted); assert.deepEqual(history.redo(), deleted);
});

test("timecode round-trips frame boundaries, including fractional rates", () => {
  for (const fps of [24, 30, 60, 120, 29.97]) for (const frame of [0, 1, 29, 30, 1799, 1800, 108000]) {
    const time = frame / fps;
    assert.ok(Math.abs(parseTimecode(formatTimecode(time, fps), fps) - time) < 1e-9);
  }
  assert.equal(parseTimecode("2.5", 30), 2.5);
  assert.throws(() => parseTimecode("00:00:00:30", 30)); assert.throws(() => parseTimecode("00:61:00:00", 30)); assert.throws(() => parseTimecode("oops", 30));
});

test("edit navigation skips duplicate cut times and stays within the sequence", () => {
  const p = fixture(); p.sequences.root.tracks[0].clips = [clip("a", 0, 2), clip("b", 4, 2)]; p.sequences.root.tracks[1].clips = [clip("voice", 0, 2, "audio")];
  assert.equal(adjacentEditTime(p.sequences.root, 2, 1), 4); assert.equal(adjacentEditTime(p.sequences.root, 2, -1), 0);
  assert.equal(adjacentEditTime(p.sequences.root, 6, 1), 6); assert.equal(adjacentEditTime(p.sequences.root, 0, -1), 0);
});
