import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyAnimation } from "../src/animation/types";
import { renderClipText, resolveTextSchedule } from "../src/sequence/text";
import { createClip, createEditSequence, DEFAULT_TRANSFORM } from "../src/sequence/types";
import type { ProjectDocument } from "../src/sequence/types";

function project(): ProjectDocument {
  const root = createEditSequence("主序列"); root.id = "root";
  const child = createEditSequence("嵌套"); child.id = "child";
  return { version: 3, id: "p", name: "text", assets: { text: { id: "text", kind: "text", name: "素材中的文字", uri: "", metadata: { speaker: "  Anon  " } } }, sequences: { root, child }, rootSequenceId: "root", width: 1920, height: 1080, fps: 30, seed: 1729, savedAt: "" };
}

test("text schedule flattens nested trim, source-in and rates without changing the project", () => {
  const document = project();
  const root = document.sequences.root;
  const child = document.sequences.child;
  root.tracks[0].clips.push(createClip({ id: "nested", kind: "sequence", name: "Nested", sequenceId: "child", start: 4, duration: 2, sourceIn: 2, rate: 2 }));
  child.tracks[0].clips.push(createClip({ id: "line", kind: "text", name: "Text", assetId: "text", text: "保留正文", start: 3, duration: 6, sourceIn: 7, rate: 0.5 }));
  child.tracks[0].clips.push(createClip({ id: "outside", kind: "text", name: "Outside", text: "看不到", start: 7, duration: 1 }));
  const original = structuredClone(document);
  assert.deepEqual(resolveTextSchedule(document), [{ id: "root/nested/line", start: 4.5, duration: 1.5, text: "保留正文", speakerName: "Anon" }]);
  assert.deepEqual(document, original);
  assert.deepEqual(resolveTextSchedule(document, "child").map(item => [item.id, item.start, item.duration]), [["line", 3, 6], ["outside", 7, 1]]);
});

test("shared nested text has independent IDs and hidden visual tracks suppress it while muted tracks retain it", () => {
  const document = project();
  const root = document.sequences.root;
  const child = document.sequences.child;
  child.tracks[0].clips.push(createClip({ id: "line", kind: "text", name: "Text", assetId: "text", start: 2, duration: 4 }));
  root.tracks[0].muted = true;
  root.tracks[0].clips.push(createClip({ id: "first", kind: "sequence", name: "First", sequenceId: "child", start: 0, duration: 6 }));
  root.tracks[0].clips.push(createClip({ id: "second", kind: "sequence", name: "Second", sequenceId: "child", start: 10, duration: 6, rate: 0.5 }));
  assert.deepEqual(resolveTextSchedule(document).map(item => [item.id, item.start, item.duration, item.text]), [["root/first/line", 2, 4, "素材中的文字"], ["root/second/line", 14, 2, "素材中的文字"]]);
  child.tracks[0].hidden = true;
  assert.deepEqual(resolveTextSchedule(document), []);
  child.tracks[0].hidden = false; root.tracks[0].hidden = true;
  assert.deepEqual(resolveTextSchedule(document), []);
});

test("opacity keys remove hidden intervals from parent and text while preserving fade visibility", () => {
  const document = project();
  const parent = createClip({ id: "parent", kind: "sequence", name: "Parent", sequenceId: "child", start: 0, duration: 6, transform: { ...DEFAULT_TRANSFORM, opacity: 0 }, transformKeys: [1, 3, 4].map((time, index) => ({ ...DEFAULT_TRANSFORM, id: `p${index}`, time, opacity: index === 2 ? 1 : 0 })) });
  const line = createClip({ id: "line", kind: "text", name: "Text", text: "显示", start: 0, duration: 6, transformKeys: [4, 5, 6].map((time, index) => ({ ...DEFAULT_TRANSFORM, id: `t${index}`, time, opacity: index === 2 ? 1 : 0 })) });
  document.sequences.root.tracks[0].clips.push(parent);
  document.sequences.child.tracks[0].clips.push(line);
  assert.deepEqual(resolveTextSchedule(document).map(item => [item.id, item.start, item.duration]), [["root/parent/line/visible:0", 3, 1], ["root/parent/line/visible:1", 5, 1]]);
});

test("Live2D internal text participates, non-text and empty lines do not, and cycles fail clearly", () => {
  const document = project();
  document.sequences.child = { ...document.sequences.child, kind: "live2d", actors: [], animation: emptyAnimation() };
  document.sequences.root.tracks[0].clips.push(createClip({ id: "model", kind: "sequence", name: "Model", sequenceId: "child", start: 0, duration: 5 }));
  document.sequences.child.tracks[0].clips.push(createClip({ id: "line", kind: "text", name: "Line", text: "内部字幕", start: 1, duration: 2 }));
  document.sequences.child.tracks[0].clips.push(createClip({ id: "empty", kind: "text", name: "Empty", text: " \n ", start: 0, duration: 5 }));
  document.sequences.child.tracks[0].clips.push(createClip({ id: "audio", kind: "audio", name: "Audio", start: 0, duration: 5 }));
  assert.deepEqual(resolveTextSchedule(document).map(item => item.text), ["内部字幕"]);
  assert.deepEqual(resolveTextSchedule(document, "unknown"), []);
  document.sequences.child.tracks[0].clips.push(createClip({ id: "cycle", kind: "sequence", name: "Cycle", sequenceId: "root", start: 0, duration: 5 }));
  assert.throws(() => resolveTextSchedule(document), /循环嵌套/);
});

test("rendered text includes speaker labels while the subtitle schedule keeps a separate body", () => {
  const document = project();
  const clip = createClip({ id: "line", kind: "text", name: "Text", assetId: "text", text: "正文\n下一行", start: 0, duration: 2 });
  document.sequences.root.tracks[0].clips.push(clip);
  assert.equal(renderClipText(clip, document.assets.text), "Anon\n正文\n下一行");
  assert.deepEqual(resolveTextSchedule(document), [{ id: "line", start: 0, duration: 2, text: "正文\n下一行", speakerName: "Anon" }]);
  assert.equal(clip.text, "正文\n下一行");
  document.assets.text.metadata!.showSpeaker = false;
  assert.equal(renderClipText(clip, document.assets.text), "正文\n下一行");
  assert.equal(resolveTextSchedule(document)[0].speakerName, undefined);
});

test("speaker rendering uses asset text fallback and ignores missing or empty speakers", () => {
  const document = project();
  const clip = createClip({ id: "line", kind: "text", name: "Text", start: 0, duration: 1 });
  assert.equal(renderClipText(clip, document.assets.text), "Anon\n素材中的文字");
  document.assets.text.metadata!.speaker = "  ";
  assert.equal(renderClipText(clip, document.assets.text), "素材中的文字");
  assert.equal(renderClipText({ ...clip, text: "正文" }), "正文");
});
