/* eslint-disable @typescript-eslint/no-explicit-any */
import { test } from "node:test";
import assert from "node:assert/strict";
import ModelManager from "../src/components/ModelManager";
import { Container, Live2DModel, setSingleLoader, setCompositeLoader, unmountManager } from "./mocks/model-manager";

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
function setup() {
  console.error = () => {}; // Expected failure cases are asserted below.
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}), text: async () => "fixture" }) as Response;
  const app = { screen: { width: 1920, height: 1080 }, stage: new Container() };
  const refs = { appRef: { current: app }, modelRef: { current: null as any }, groupContainerRef: { current: null as any }, isCompositeRef: { current: false }, motionBaseRef: { current: null as string | null } };
  const updates: any[] = [];
  const manager = ModelManager({ ...refs, setModelData: (value) => updates.push(value), setCustomRecordingBounds() {}, enableDragging: false, setIsDragging() {} } as any);
  return { app, refs, manager, updates };
}
function cleanup() { unmountManager(); globalThis.fetch = originalFetch; console.error = originalConsoleError; }

test("library model latest load wins and stale native model textures are released", async () => {
  const one = deferred<Live2DModel>(), two = deferred<Live2DModel>();
  setSingleLoader((url) => url === "one.model3.json" ? one.promise : two.promise);
  const { manager, app, refs } = setup();
  try {
    const first = new Live2DModel(), second = new Live2DModel();
    const firstBase = first.textures[0].baseTexture;
    const a = manager.loadAnyModel(app as any, "one.model3.json");
    const b = manager.loadAnyModel(app as any, "two.model3.json");
    two.resolve(second); await b;
    one.resolve(first); await a;
    assert.equal(refs.modelRef.current, second);
    assert.equal(app.stage.children.length, 1);
    assert.equal(first.destroyed, true);
    assert.equal(firstBase.destroyed, true);
    assert.equal(second.autoUpdate, false);
    assert.equal(second.deltaTime, 0);
  } finally { cleanup(); }
});

test("library load after unmount cannot install a model or call state callbacks", async () => {
  const pending = deferred<Live2DModel>();
  setSingleLoader(() => pending.promise);
  const { manager, app, refs, updates } = setup();
  try {
    const model = new Live2DModel(), base = model.textures[0].baseTexture;
    const loading = manager.loadAnyModel(app as any, "model.model3.json");
    unmountManager();
    pending.resolve(model); await loading;
    assert.equal(refs.modelRef.current, null);
    assert.equal(app.stage.children.length, 0);
    assert.equal(updates.length, 0);
    assert.equal(model.destroyed, true);
    assert.equal(base.destroyed, true);
  } finally { cleanup(); }
});

test("metadata failure after native model load releases retained resources", async () => {
  const model = new Live2DModel(), base = model.textures[0].baseTexture;
  setSingleLoader(async () => model);
  const { manager, app, refs } = setup();
  globalThis.fetch = async () => ({ ok: false, status: 404, statusText: "Not Found" }) as Response;
  try {
    await assert.rejects(manager.loadAnyModel(app as any, "missing.model3.json"), /404/);
    assert.equal(refs.modelRef.current, null);
    assert.equal(app.stage.children.length, 0);
    assert.equal(base.destroyed, true);
  } finally { cleanup(); }
});

test("partial composite failure retains and disables each part immediately then frees every resource", async () => {
  const model = new Live2DModel(), base = model.textures[0].baseTexture;
  let container: Container;
  setCompositeLoader(async (options) => {
    container = options.createContainer();
    container.addChild(model);
    await options.configureModel({ model, part: { id: "role", index: 0 }, resolvedUrl: "role.model3.json", modelIndex: 0 });
    assert.equal(model.autoUpdate, false);
    assert.equal(model.deltaTime, 0);
    assert.equal(model.stopped, true);
    throw new Error("second part failed");
  });
  const { manager, app, refs } = setup();
  try {
    await assert.rejects(manager.loadAnyModel(app as any, "composite.jsonl"), /second part failed/);
    assert.equal(model.destroyed, true);
    assert.equal(base.destroyed, true);
    assert.equal(container!.destroyed, true);
    assert.equal(refs.groupContainerRef.current, null);
    assert.equal(app.stage.children.length, 0);
  } finally { cleanup(); }
});
