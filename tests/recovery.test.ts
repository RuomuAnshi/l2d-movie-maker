import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEditSequence } from "../src/sequence/types";
import { listRecovery, readRecovery, saveRecovery, writeAtomicText, projectSignature } from "../src/utils/projectRecovery";
import type { ProjectSnapshot } from "../src/utils/projectStorage";
import { runVideoExport } from "../src/utils/videoExporter";
function snapshot(): ProjectSnapshot { const sequence = createEditSequence(); return { version: 3, projectPath: "/work/test.l2dproject", document: { version: 3, id: "project", name: "test", sequences: { [sequence.id]: sequence }, assets: {}, rootSequenceId: sequence.id, width: 1920, height: 1080, fps: 30, seed: 1, savedAt: "" }, savedAt: new Date().toISOString(), selectedModel: null, selectedCharacterId: "main", motionClips: [], exprClips: [], audioClips: [], subtitleClips: [], showSubtitles: true, showSubtitleSpeaker: true, subtitleSpeakerAlign: "left", playhead: 0, motionDur: 3, exprDur: 3, characterVisible: true, characterTransformMode: "single-relative", characterTransform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, recordingQuality: "medium", transparentBg: true, customRecordingBounds: { x: 0, y: 0, width: 1920, height: 1080 } }; }
test("recovery stores independent project histories and atomically replaces snapshots", async () => { const root = await mkdtemp(join(tmpdir(), "l2d-recovery-")); process.env.L2D_STORAGE_TEST_ROOT = root; try {
    const first = snapshot();
    await saveRecovery(first);
    const second = { ...first, document: { ...first.document!, name: "second", id: "second" } };
    await saveRecovery(second);
    const current = await listRecovery("project");
    assert.equal(current.length, 1);
    assert.equal((await readRecovery(current[0].path)).projectPath, first.projectPath);
    assert.equal((await listRecovery()).length, 2);
    await Promise.all([saveRecovery(first), saveRecovery({ ...first, playhead: 4 })]);
    assert.equal((await readRecovery(current[0].path)).playhead, 4);
    assert.ok((await readdir(join(root, "local", "recovery", "project"))).every(name => name.endsWith(".json")));
    const target = join(root, "test.json");
    await writeAtomicText(target, "a");
    await writeAtomicText(target, "b");
    assert.equal(await readFile(target, "utf8"), "b");
}
finally {
    await rm(root, { recursive: true, force: true });
} });
test("history rotation keeps 30 versions and invalid snapshots are skipped", async () => { const root = await mkdtemp(join(tmpdir(), "l2d-recovery-")); process.env.L2D_STORAGE_TEST_ROOT = root; try {
    const path = join(root, "local", "recovery", "project");
    await mkdir(path, { recursive: true });
    for (let i = 0; i < 35; i++)
        await writeFile(join(path, `${10000 + i}.json`), JSON.stringify(snapshot()));
    await writeFile(join(path, "broken.json"), "bad");
    await saveRecovery(snapshot());
    assert.equal((await listRecovery("project")).length, 30);
    assert.ok((await readdir(path)).includes("broken.json"));
}
finally {
    await rm(root, { recursive: true, force: true });
} });
test("dirty signature excludes analysis caches but retains actual editing data", () => { const first = snapshot().document!; const second = structuredClone(first); second.savedAt = "now"; first.assets.image = { id: "image", kind: "image", name: "img", uri: "img.png" }; second.assets.image = { ...first.assets.image, metadata: { thumbnail: "data:..." }, waveformPeaks: [0.5] }; assert.equal(projectSignature(first), projectSignature(second)); second.name = "edited"; assert.notEqual(projectSignature(first), projectSignature(second)); });
test("offline export cancellation stops frame writing and cleans temporary storage", async () => { const root = await mkdtemp(join(tmpdir(), "l2d-export-cancel-")); process.env.L2D_STORAGE_TEST_ROOT = root; try {
    const controller = new AbortController();
    let renders = 0, seeks = 0;
    const canvas = { toBlob(callback: (blob: Blob) => void) { callback(new Blob(["png"])); } } as HTMLCanvasElement;
    await assert.rejects(runVideoExport({ canvas, outputPath: join(root, "video.mov"), format: "mov", fps: 29.97, targetFrameCount: 10, startTime: 2, signal: controller.signal, applyTimelineAtTime: time => { assert.ok(time >= 2); seeks++; if (seeks === 2)
            controller.abort(); }, renderFrame: () => { renders++; }, audioTracks: [], includeAudio: false }), error => error instanceof Error && error.name === "AbortError");
    assert.equal(renders, 1);
    assert.equal((await readdir(join(root, "cache"))).length, 0);
}
finally {
    await rm(root, { recursive: true, force: true });
} });
