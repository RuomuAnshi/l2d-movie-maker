import { test } from "node:test";
import assert from "node:assert/strict";
import {
  curveValue,
  evaluateAt,
  evaluateTrack,
  upsertKey,
  insertSource,
  editSource,
  CommandHistory,
  reconcileSourceEdits,
  removeSource,
} from "../src/animation/engine";
import {
  importMaterial,
  parseMotion,
  bakeLipSync,
} from "../src/animation/importers";
import {
  emptyAnimation,
  targetId,
  type Keyframe,
  type ParameterTrack,
} from "../src/animation/types";
import { ModelAdapter, TimelineRenderer } from "../src/animation/runtime";
import { exportAnimation, type AnimationExportOptions } from "../src/animation/exporters";
const k = (
  time: number,
  value: number,
  interpolation: Keyframe["interpolation"] = "linear",
): Keyframe => ({ id: `${time}-${value}`, time, value, interpolation });
const track = (id = "X"): ParameterTrack => ({
  definition: {
    target: targetId("main", "0", id),
    characterId: "main",
    partId: "0",
    parameterId: id,
    name: id,
    group: "参数",
    kind: "parameter",
    min: -100,
    max: 100,
    defaultValue: 0,
  },
  baseValue: 0,
  animated: true,
  keys: [],
});
const near = (a: number, b: number) =>
  assert.ok(Math.abs(a - b) < 1e-5, `${a} != ${b}`);
test("linear, base before first key and last hold", () => {
  const keys = [k(1, 10), k(3, 30)];
  assert.equal(curveValue(keys, 5, 0), 5);
  assert.equal(curveValue(keys, 5, 4), 30);
  near(curveValue(keys, 5, 2), 20);
});
test("hold and inverse hold preserve exact endpoints", () => {
  assert.equal(curveValue([k(0, 2, "hold"), k(2, 8)], 0, 1), 2);
  assert.equal(curveValue([k(0, 2, "inverse-hold"), k(2, 8)], 0, 1), 8);
  assert.equal(curveValue([k(0, 2, "inverse-hold"), k(2, 8)], 0, 0), 2);
});
test("restricted and unrestricted Bezier time solving", () => {
  const a = { ...k(0, 0, "bezier"), outHandle: { time: 0, value: 0 } },
    b = { ...k(1, 1), inHandle: { time: 1, value: 1 } };
  near(curveValue([a, b], 0, 0.5), 0.5);
  near(
    curveValue(
      [
        { ...a, outHandle: { time: 0.15, value: 0 } },
        { ...b, inHandle: { time: 0.9, value: 1 } },
      ],
      0,
      0.20546875,
    ),
    0.15625,
  );
});
test("motion3 preserves interpolation, opacity and subframe keys", () => {
  const parsed = parseMotion(
    JSON.stringify({
      Meta: { Duration: 1 },
      Curves: [
        {
          Target: "Parameter",
          Id: "X",
          Segments: [0, 0, 1, 0.1, 0.2, 0.4, 0.8, 0.731, 1, 2, 1, 0],
        },
        { Target: "PartOpacity", Id: "P", Segments: [0, 1, 3, 0.3, 0] },
      ],
    }),
  );
  assert.equal(parsed.curves["parameter:X"][1].time, 0.731);
  assert.equal(parsed.curves["parameter:X"][0].interpolation, "bezier");
  assert.equal(parsed.curves["parameter:X"][1].interpolation, "hold");
  assert.equal(parsed.curves["opacity:P"][0].interpolation, "inverse-hold");
});
test("MTN native frame rate", () => {
  const motion = parseMotion("# comment\n$fps=24\nX=0,12,24");
  near(motion.curves["parameter:X"][1].time, 1 / 24);
  near(motion.duration, 3 / 24);
});
test("expression add/multiply/overwrite and final hold", () => {
  for (const [Blend, expected] of [
    ["Add", 5],
    ["Multiply", 6],
    ["Overwrite", 3],
  ] as const) {
    const t = { ...track(), baseValue: 2 };
    const doc = { ...emptyAnimation(), tracks: [t] };
    const result = importMaterial(
      doc,
      [t],
      JSON.stringify({
        FadeInTime: 0.4,
        Parameters: [{ Id: "X", Value: 3, Blend }],
      }),
      "expression",
      "smile",
      1,
    );
    near(evaluateTrack(result.tracks[0], 1), 2);
    near(evaluateTrack(result.tracks[0], 2), expected);
  }
});
test("range clamp and upsert", () => {
  const t = upsertKey(upsertKey(track(), 0, 200), 0, 300);
  assert.equal(t.keys.length, 1);
  assert.equal(evaluateTrack(t, 0), 100);
});
test("interval replacement leaves other parameters and outside curve untouched", () => {
  const x = { ...track(), keys: [k(0, 0), k(10, 10)] },
    y = { ...track("Y"), keys: [k(0, 9)] };
  const doc = { ...emptyAnimation(), tracks: [x, y] };
  const result = insertSource(doc, {
    id: "source",
    name: "test",
    kind: "motion",
    start: 3,
    duration: 2,
    sourceDuration: 2,
    offset: 0,
    speed: 1,
    curves: { [x.definition.target]: [k(0, 30), k(2, 50)] },
  });
  near(evaluateTrack(result.tracks[0], 2), 2);
  near(evaluateTrack(result.tracks[0], 7), 7);
  near(evaluateTrack(result.tracks[0], 4), 40);
  assert.deepEqual(result.tracks[1], y);
});
test("move, trim, extend hold and speed; original curves retained", () => {
  const t = track();
  let doc = insertSource(
    { ...emptyAnimation(), tracks: [t] },
    {
      id: "s",
      name: "test",
      kind: "motion",
      start: 0,
      duration: 2,
      sourceDuration: 2,
      offset: 0,
      speed: 1,
      curves: { [t.definition.target]: [k(0, 0), k(2, 20)] },
    },
  );
  doc = editSource(doc, "s", { start: 3 });
  near(evaluateTrack(doc.tracks[0], 4), 10);
  doc = editSource(doc, "s", { duration: 1 });
  near(evaluateTrack(doc.tracks[0], 4), 10);
  doc = editSource(doc, "s", { duration: 4 });
  near(evaluateTrack(doc.tracks[0], 7), 20);
  doc = editSource(doc, "s", { speed: 2, duration: 1 });
  near(evaluateTrack(doc.tracks[0], 3.5), 10);
  assert.equal(doc.groups[0].curves[t.definition.target][1].time, 2);
});
test("history and saved v2 keys need no source fetch", () => {
  const history = new CommandHistory<ReturnType<typeof emptyAnimation>>(),
    before = { ...emptyAnimation(), tracks: [track()] };
  history.commit(before);
  const after = { ...before, tracks: [upsertKey(before.tracks[0], 1, 20)] };
  assert.deepEqual(history.undo(after), before);
  assert.deepEqual(history.redo(before), after);
  assert.deepEqual(
    evaluateAt(JSON.parse(JSON.stringify(after)), 2),
    evaluateAt(after, 2),
  );
});
test("qualified composite targets cannot collide", () =>
  assert.notEqual(
    targetId("role", "partA", "X"),
    targetId("role", "partB", "X"),
  ));
const fakeModel = () => {
  const parameters = {
    ids: ["X", "ParamMouthOpenY", "ParamEyeLOpen"],
    minimumValues: [-100, 0, 0],
    maximumValues: [100, 1, 1],
    defaultValues: [0, 0, 1],
    values: new Float32Array([0, 0, 1]),
  };
  return {
    autoUpdate: true,
    deltaTime: 100,
    internalModel: {
      settings: {},
      motionManager: { stopAllMotions() {} },
      coreModel: {
        parameters,
        parts: { ids: [], opacities: new Float32Array() },
        update() {},
      },
      physics: {
        velocity: 0,
        evaluate(core: { parameters: { values: Float32Array } }, dt: number) {
          this.velocity += dt * (core.parameters.values[0] - this.velocity);
          core.parameters.values[1] = this.velocity / 100;
        },
      },
    },
  };
};
test("physics snapshots give the same direct, forward, reverse and fractional seeks", () => {
  const model = fakeModel(),
    adapter = new ModelAdapter(model, 0),
    renderer = new TimelineRenderer([adapter]);
  const doc = {
    ...emptyAnimation(),
    tracks: adapter.tracks.map((t, i) =>
      i === 0 ? upsertKey(upsertKey(t, 0, 0), 4, 40) : t,
    ),
  };
  renderer.seek(doc, 2.413);
  const first = [...model.internalModel.coreModel.parameters.values];
  for (const time of [4, 0, 3, 1.31, 2.413]) renderer.seek(doc, time);
  assert.deepEqual([...model.internalModel.coreModel.parameters.values], first);
  const other = fakeModel(),
    fresh = new ModelAdapter(other, 0);
  new TimelineRenderer([fresh]).seek(doc, 2.413);
  assert.deepEqual([...other.internalModel.coreModel.parameters.values], first);
  assert.equal(model.autoUpdate, false);
  assert.equal(model.deltaTime, 0);
});
test("manual mouth keys override lip sync and physics", () => {
  const model = fakeModel(),
    adapter = new ModelAdapter(model, 0);
  const doc = {
    ...emptyAnimation(),
    tracks: adapter.tracks.map((t) =>
      t.definition.parameterId === "ParamMouthOpenY" ? upsertKey(t, 0, 0.7) : t,
    ),
  };
  new TimelineRenderer([adapter]).seek(doc, 1, () => 1);
  near(model.internalModel.coreModel.parameters.values[1], 0.7);
});
test("lip analysis is baked at 120 Hz", () => {
  const values = bakeLipSync({
    numberOfChannels: 1,
    sampleRate: 240,
    length: 240,
    duration: 1,
    getChannelData: () => new Float32Array(240).fill(0.1),
  } as AudioBuffer);
  assert.equal(values.length, 120);
  near(values[60], 0.5);
});
test("Cubism2 adapter reads actual parameter IDs from shipped SDK context", () => {
  const values = [0.5];
  const model = {
    autoUpdate: true,
    internalModel: {
      motionManager: {},
      coreModel: {
        getModelContext: () => ({
          _$pb: [{ id: "PARAM_X" }],
          _$F2: [],
          getParamMin: () => -1,
          getParamMax: () => 1,
        }),
        getParamFloat: () => values[0],
        setParamFloat: (_id: string | number, v: number) => {
          values[0] = v;
        },
        update() {},
      },
    },
  };
  const adapter = new ModelAdapter(model, 0);
  assert.equal(adapter.tracks[0].definition.parameterId, "PARAM_X");
});

import { migrateLegacyClips } from "../src/animation/migration";
import { isAnimationDocument } from "../src/animation/validation";
test("V1 migration preserves start/duration, trims and holds without changing input", async () => {
  const t = track(),
    base = { ...emptyAnimation(), tracks: [t] },
    motion = JSON.stringify({
      Meta: { Duration: 2 },
      Curves: [{ Target: "Parameter", Id: "X", Segments: [0, 0, 0, 2, 20] }],
    });
  const clips = [{ id: "old", name: "m", start: 3, duration: 4 }];
  const original = structuredClone(clips);
  const migrated = await migrateLegacyClips(base, clips, [], async () => [
    { text: motion, targets: [t.definition.target] },
  ]);
  near(evaluateTrack(migrated.tracks[0], 4), 10);
  near(evaluateTrack(migrated.tracks[0], 7), 20);
  assert.deepEqual(clips, original);
  const trimmed = await migrateLegacyClips(
    base,
    [{ ...clips[0], duration: 1 }],
    [],
    async () => [{ text: motion, targets: [t.definition.target] }],
  );
  near(evaluateTrack(trimmed.tracks[0], 5), 10);
  await assert.rejects(
    migrateLegacyClips(base, clips, [], async () => []),
    /缺失素材/,
  );
});
test("editing an imported frame survives group movement, trimming and restoring", () => {
  const t = track();
  const doc = importMaterial(
    { ...emptyAnimation(), tracks: [t] },
    [t],
    JSON.stringify({
      Meta: { Duration: 2 },
      Curves: [
        { Target: "Parameter", Id: "X", Segments: [0, 0, 0, 1, 10, 0, 2, 20] },
      ],
    }),
    "motion",
    "m",
    0,
  );
  const edited = reconcileSourceEdits(doc, {
    ...doc,
    tracks: [upsertKey(doc.tracks[0], 1, 70)],
  });
  const group = edited.groups[0];
  assert.equal(group.originalCurves![t.definition.target][1].value, 10);
  const moved = editSource(edited, group.id, { start: 3 });
  near(evaluateTrack(moved.tracks[0], 4), 70);
  const trimmed = editSource(moved, group.id, { duration: 0.5 });
  const restored = editSource(trimmed, group.id, { duration: 2 });
  near(evaluateTrack(restored.tracks[0], 4), 70);
});
test("V2 document rejects malformed keys and duplicate qualified targets", () => {
  const doc = { ...emptyAnimation(), tracks: [track()] };
  assert.ok(isAnimationDocument(doc));
  assert.ok(!isAnimationDocument({ ...doc, tracks: [track(), track()] }));
  assert.ok(
    !isAnimationDocument({
      ...doc,
      tracks: [{ ...track(), keys: [k(NaN, 0)] }],
    }),
  );
});

test("overlapping materials retain lower curves, insertion priority, manual underlay and undo", () => {
  const x = { ...track(), keys: [k(0, 0), k(10, 10)] }, y = track("Y");
  const base = { ...emptyAnimation(), tracks: [x, y] };
  const a = { id: "a", name: "motion", kind: "motion" as const, start: 1, duration: 5, sourceDuration: 5, offset: 0, speed: 1,
    curves: { [x.definition.target]: [k(0, 0), k(5, 50)], [y.definition.target]: [k(0, 5), k(5, 5)] } };
  const first = insertSource(base, a);
  const second = insertSource(first, { ...a, id: "b", kind: "expression", start: 2, duration: 2, sourceDuration: 2,
    curves: { [x.definition.target]: [k(0, 80), k(2, 90)] } });
  near(evaluateTrack(second.tracks[0], 3), 85);
  near(evaluateTrack(second.tracks[0], 5), 40);
  near(evaluateTrack(second.tracks[1], 3), 5);
  const lowerMoved = editSource(second, "a", { start: 0 });
  assert.deepEqual(lowerMoved.groups.map(g => g.id), ["a", "b"]);
  near(evaluateTrack(lowerMoved.tracks[0], 3), 85);
  const moved = editSource(second, "b", { start: 7 });
  near(evaluateTrack(moved.tracks[0], 3), 20);
  const removed = removeSource(second, "b");
  near(evaluateTrack(removed.tracks[0], 3), 20);
  const original = removeSource(removed, "a");
  assert.deepEqual(original.tracks[0].keys, base.tracks[0].keys);
  near(evaluateTrack(original.tracks[0], 3), 3);
  const history = new CommandHistory<typeof second>(); history.commit(second);
  assert.deepEqual(evaluateAt(history.undo(removed), 3), evaluateAt(second, 3));
  const saved = JSON.parse(JSON.stringify(second));
  near(evaluateTrack(removeSource(saved, "b").tracks[0], 3), 20);
});

test("manual underlay edits outside source intervals survive rebuild and removal", () => {
  const t = { ...track(), keys: [k(0, 0), k(10, 10)] };
  const doc = importMaterial({ ...emptyAnimation(), tracks: [t] }, [t], "$fps=1\nX=20,30", "motion", "m", 3);
  const edited = reconcileSourceEdits(doc, { ...doc, tracks: [upsertKey(doc.tracks[0], 9, 90)] });
  const removed = removeSource(edited, edited.groups[0].id);
  near(evaluateTrack(removed.tracks[0], 9), 90);
});

const exportOptions: AnimationExportOptions = { name: "test", kind: "motion", characterId: "main", partId: "0", start: 0, end: 2, time: 1, fps: 30, fadeIn: 0.5, scope: "all", destination: "file" };
test("motion3 export preserves clipped Beziers, hold, inverse hold, opacity and qualified identities", () => {
  const x = { ...track(), keys: [
    { ...k(0, 0, "bezier"), outHandle: { time: 0.2, value: 20 } },
    { ...k(1, 10, "hold"), inHandle: { time: 0.8, value: 30 } }, k(1.4, 40, "inverse-hold"), k(2, 50),
  ] };
  const opacity = { ...track("Part"), definition: { ...track("Part").definition, kind: "opacity" as const, min: 0, max: 1 }, keys: [k(0, 1), k(2, 0)] };
  const other = { ...track(), definition: { ...track().definition, target: targetId("other", "0", "X"), characterId: "other" }, keys: [k(0, 99)] };
  const doc = { ...emptyAnimation(), tracks: [x, opacity, other] };
  const result = exportAnimation(doc, { ...exportOptions, start: 0.271, end: 1.9 }, 3);
  const parsed = parseMotion(result.text), json = JSON.parse(result.text);
  assert.equal(json.Meta.AreBeziersRestricted, false);
  assert.equal(result.parameterCount, 2);
  assert.ok(json.Meta.TotalPointCount > json.Meta.TotalSegmentCount);
  for (const time of [0.271, 0.5, 0.9, 1, 1.2, 1.4, 1.7, 1.9]) {
    near(curveValue(parsed.curves["parameter:X"], 0, time - 0.271), evaluateTrack(x, time));
    near(curveValue(parsed.curves["opacity:Part"], 0, time - 0.271), evaluateTrack(opacity, time));
  }
});
test("motion3 export before first frame uses base, static values clamp and overshoot bakes", () => {
  const t = { ...track(), baseValue: 2, keys: [k(1, 20), k(2, 40)] };
  let parsed = parseMotion(exportAnimation({ ...emptyAnimation(), tracks: [t] }, exportOptions, 3).text);
  near(curveValue(parsed.curves["parameter:X"], 0, 0.5), 2);
  const overshoot = { ...track(), keys: [k(0, -200), k(2, 200)] };
  parsed = parseMotion(exportAnimation({ ...emptyAnimation(), tracks: [overshoot] }, exportOptions, 3).text);
  for (const time of [0, 0.5, 1, 1.5, 2]) near(curveValue(parsed.curves["parameter:X"], 0, time), evaluateTrack(overshoot, time));
});
test("Cubism2 motion exports at requested sample rate including part opacity", () => {
  const t = { ...track(), keys: [k(0, 0), k(2, 48)] };
  const p = { ...track("P"), definition: { ...track("P").definition, kind: "opacity" as const }, keys: [k(0, 1)] };
  const exported = exportAnimation({ ...emptyAnimation(), tracks: [t, p] }, { ...exportOptions, fps: 24 }, 2);
  assert.equal(exported.extension, "mtn");
  const parsed = parseMotion(exported.text);
  assert.equal(parsed.curves["parameter:X"].length, 48);
  near(parsed.curves["parameter:X"][13].value, 13);
  assert.ok(parsed.curves["opacity:P"]);
});
test("expression exports overwrite pose, exclude opacity, and reimport native fade units", () => {
  for (const cubism of [2, 3] as const) {
    const t = { ...track(), keys: [k(0, 0), k(2, 40)] };
    const p = { ...track("P"), definition: { ...track("P").definition, kind: "opacity" as const }, keys: [k(0, 1)] };
    const result = exportAnimation({ ...emptyAnimation(), tracks: [t, p] }, { ...exportOptions, kind: "expression" }, cubism);
    assert.equal(result.parameterCount, 1);
    const imported = importMaterial({ ...emptyAnimation(), tracks: [track()] }, [track()], result.text, "expression", "pose", 0);
    near(imported.groups[0].duration, 0.5);
    near(evaluateTrack(imported.tracks[0], 0.5), 20);
  }
});
test("animation export rejects empty selections, wrong parts and invalid ranges", () => {
  const doc = { ...emptyAnimation(), tracks: [track()] };
  assert.throws(() => exportAnimation(doc, { ...exportOptions, partId: "missing" }, 3), /没有可导出/);
  assert.throws(() => exportAnimation(doc, { ...exportOptions, scope: "material" }, 3), /请选择素材/);
  assert.throws(() => exportAnimation(doc, { ...exportOptions, end: 0 }, 3), /无效/);
});

test("new parameter frames inside material become editable source curves and survive moving", () => {
  const t = track();
  const doc = importMaterial({ ...emptyAnimation(), tracks: [t] }, [t], "$fps=1\nX=0,10,20", "motion", "m", 1);
  const edited = reconcileSourceEdits(doc, { ...doc, tracks: [upsertKey(doc.tracks[0], 2.25, 77)] });
  assert.equal(edited.tracks[0].keys.find(k => k.time === 2.25)?.sourceId, doc.groups[0].id);
  const moved = editSource(edited, doc.groups[0].id, { start: 3 });
  near(evaluateTrack(moved.tracks[0], 4.25), 77);
  const extended = editSource(moved, doc.groups[0].id, { duration: 5 });
  near(evaluateTrack(extended.tracks[0], 8), 20);
});
