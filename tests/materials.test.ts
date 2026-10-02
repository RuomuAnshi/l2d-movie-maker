import { test } from "node:test";
import assert from "node:assert/strict";
import { materialSourceFromAsset, materialSourceToAsset, mergeMaterialAssets, parseMaterialSource, type MaterialSource } from "../src/sequence/materials";
import { ModelAdapter } from "../src/animation/runtime";
import { createEditSequence, type ProjectDocument } from "../src/sequence/types";
import { isProjectDocument } from "../src/sequence/validation";
import { isAnimationDocument } from "../src/animation/validation";
import { emptyAnimation } from "../src/animation/types";

function source(model: string, text: string): MaterialSource {
  return { id: `asset:motion:${model}:Idle`, name: "Idle", kind: "motion", sourceModel: `${model}.model3.json`, parts: [{ partId: "main", uri: `http://127.0.0.1:12345/${model}/idle.motion3.json`, text }] };
}
function project(): ProjectDocument {
  const root = createEditSequence();
  return { version: 3, id: "p", name: "p", assets: {}, sequences: { [root.id]: root }, rootSequenceId: root.id, width: 1920, height: 1080, fps: 30, seed: 1, savedAt: "" };
}

test("same-named animation materials retain distinct source IDs and original text", () => {
  const first = materialSourceToAsset(source("A", '{"Version":3,"Value":1}'));
  const second = materialSourceToAsset(source("B", '{"Version":3,"Value":2}'));
  assert.notEqual(first.id, second.id);
  assert.notEqual(materialSourceFromAsset(first)!.parts[0].text, materialSourceFromAsset(second)!.parts[0].text);
  assert.equal(materialSourceFromAsset(first)!.sourceModel, "A.model3.json");
  assert.equal(materialSourceFromAsset(second)!.sourceModel, "B.model3.json");
});

test("saved animation material text survives reopening without a temporary server URL", () => {
  const original = source("A", "# FPS=60\nPARAM_ANGLE_X=0,1,2");
  const asset = materialSourceToAsset(original);
  const document = project(); document.assets[asset.id] = asset;
  const saved = JSON.stringify(document);
  assert.ok(!saved.includes("127.0.0.1:12345"));
  const restored = JSON.parse(saved);
  assert.equal(isProjectDocument(restored), true);
  const reopened = materialSourceFromAsset(restored.assets[asset.id])!;
  assert.deepEqual(reopened.parts, [{ partId: "main", uri: "", text: original.parts[0].text }]);
  assert.equal(reopened.sourceModel, original.sourceModel);
  assert.equal(materialSourceFromAsset({ id: "image", name: "image", kind: "image", uri: "image.png" }), null);
});

test("material payload validation rejects missing sources, duplicate parts and unread saved sources", () => {
  const original = source("A", "motion");
  for (const bad of [null, {}, { ...original, kind: "image" }, { ...original, id: "" }, { ...original, sourceModel: "" }, { ...original, parts: [] }, { ...original, parts: [{ partId: "main", uri: "" }] }, { ...original, parts: [...original.parts, ...original.parts] }, { ...original, parts: [{ partId: "main", uri: "file.mtn", text: 42 }] }]) {
    assert.throws(() => parseMaterialSource(bad), /来源无效/);
  }
  assert.throws(() => materialSourceToAsset({ ...original, parts: [{ partId: "main", uri: "idle.mtn" }] }), /必须读取全部源文件/);
  assert.throws(() => materialSourceFromAsset({ id: "bad", name: "bad", kind: "motion", uri: "", metadata: { sourceModel: "A", materialParts: "invalid-json" } }), /源文件数据无效/);
  const copy = parseMaterialSource(original); copy.parts[0].text = "edited";
  assert.equal(original.parts[0].text, "motion");
});

test("animation material assets validate while motion/expression timeline clips are rejected", () => {
  const document = project(); const asset = materialSourceToAsset(source("A", "motion")); document.assets[asset.id] = asset;
  assert.equal(isProjectDocument(document), true);
  const bad = structuredClone(document); bad.assets[asset.id].metadata!.materialParts = "[]";
  assert.equal(isProjectDocument(bad), false);
  const root = document.sequences[document.rootSequenceId];
  root.tracks[0].clips.push({ id: "bad", kind: "motion", name: "Idle", assetId: asset.id, start: 0, duration: 1 } as never);
  assert.equal(isProjectDocument(document), false);
});

test("source groups accept persistent source asset IDs and reject malformed IDs", () => {
  const animation = emptyAnimation();
  animation.groups.push({ id: "g", name: "Idle", kind: "motion", sourceAssetId: "asset:motion:A:Idle", start: 0, duration: 1, sourceDuration: 1, offset: 0, speed: 1, curves: {} });
  assert.equal(isAnimationDocument(animation), true);
  animation.groups[0].sourceAssetId = ""; assert.equal(isAnimationDocument(animation), false);
  animation.groups[0].sourceAssetId = undefined; assert.equal(isAnimationDocument(animation), true);
});

test("ModelAdapter materialReference synchronously resolves the actual source and qualified part ID", async () => {
  const model = {
    internalModel: {
      settings: { url: "https://models/A/model.model3.json", json: { FileReferences: { Motions: { Idle: [{ File: "motions/idle.motion3.json" }] }, Expressions: [{ Name: "Smile", File: "expressions/smile.exp3.json" }] } } },
      motionManager: { stopAllMotions() {}, definitions: { Idle: [{ File: "motions/idle.motion3.json" }] }, expressionManager: { definitions: [{ Name: "Smile", File: "expressions/smile.exp3.json" }] } },
      coreModel: { parameters: { ids: ["ParamX"], minimumValues: [0], maximumValues: [1], defaultValues: [0], values: new Float32Array(1) }, parts: { ids: [], opacities: [] }, update() {} },
    },
  };
  const adapter = new ModelAdapter(model, 0, { characterId: "actor", partId: "actor:body" });
  const reference = adapter.materialReference("Idle", "motion");
  assert.deepEqual(reference, { partId: "actor:body", uri: "https://models/A/motions/idle.motion3.json" });
  assert.equal(adapter.materialReference("Smile", "expression").uri, "https://models/A/expressions/smile.exp3.json");
  assert.throws(() => adapter.materialReference("Missing", "motion"), /缺少动作素材/);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (uri) => { assert.equal(uri, reference.uri); return { ok: true, text: async () => "source-A" } as Response; };
  try { assert.equal(await adapter.material("Idle", "motion"), "source-A"); }
  finally { globalThis.fetch = originalFetch; }
});

test("embedded library materials are deduplicated after bundle model relocation", () => {
  const source={id:"old",kind:"motion" as const,name:"smile",sourceModel:"/old/model3.json",parts:[{partId:"0",uri:"",text:'{"Curves":[]}'}]};
  const assets={old:materialSourceToAsset(source)};
  assert.equal(mergeMaterialAssets(assets,[{...source,id:"relocated",sourceModel:"/new/model3.json"}]),assets);
  assert.equal(Object.keys(mergeMaterialAssets(assets,[{...source,id:"modified",parts:[{partId:"0",uri:"",text:'{"Curves":[1]}'}]}])).length,2);
});
