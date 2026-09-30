/* SDK objects cross a VM context, so their private structures have no usable TS types. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import vm from "node:vm";
import { createRequire } from "node:module";
import { ModelAdapter, TimelineRenderer } from "../src/animation/runtime";
import { importMaterial } from "../src/animation/importers";
import { emptyAnimation } from "../src/animation/types";
function findManagedFixture(): string | undefined {
  const managed = join(homedir(), "Library", "Application Support", "com.DongshanRandeng.l2dmm", "models");
  if (!existsSync(managed)) return undefined;
  const visit = (folder: string, depth: number): string | undefined => {
    if (depth > 3) return undefined;
    try {
      const entries = readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) if (entry.isFile() && /\.model3\.json$/i.test(entry.name)) return join(folder, entry.name);
      for (const entry of entries) if (entry.isDirectory() && !entry.name.startsWith(".")) {
        const fixture = visit(join(folder, entry.name), depth + 1);
        if (fixture) return fixture;
      }
    } catch { /* Fixture access is optional on other machines. */ }
    return undefined;
  };
  return visit(managed, 0);
}
const modelPath = process.env.L2D_TEST_MODEL || findManagedFixture();
test(
  "local Cubism model: native core, actual motion/expression files, physics and drawable geometry",
  { skip: !modelPath },
  async () => {
    const context: any = {
      console,
      require: createRequire(import.meta.url),
      process,
      Buffer,
      WebAssembly,
      setTimeout,
      clearTimeout,
      atob,
      __dirname: process.cwd(),
    };
    vm.createContext(context);
    vm.runInContext(
      readFileSync("public/lib/live2dcubismcore.min.js", "utf8"),
      context,
    );
    // The SDK's pure core/physics classes precede its PIXI/browser adapter. No WebGL or mocked physics is involved.
    const sdkText = readFileSync(
      "node_modules/pixi-live2d-display/dist/cubism4.es.js",
      "utf8",
    )
      .split("const HitAreaPrefix")[0]
      .replace(/^import .*;\n/gm, "");
    vm.runInContext(
      sdkText +
        "\nglobalThis.sdk={CubismFramework,CubismModel,CubismPhysics,CubismModelSettingsJson};",
      context,
    );
    for (let i = 0; i < 100; i++) {
      try {
        context.Live2DCubismCore.Version.csmGetVersion();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    const settings = JSON.parse(readFileSync(modelPath!, "utf8")),
      root = dirname(modelPath!);
    context.sdk.CubismFramework.startUp();
    context.sdk.CubismFramework.initialize();
    const make = () => {
      const bytes = readFileSync(resolve(root, settings.FileReferences.Moc));
      const moc = context.Live2DCubismCore.Moc.fromArrayBuffer(
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
      );
      const native = context.Live2DCubismCore.Model.fromMoc(moc),
        core = new context.sdk.CubismModel(native);
      const physics = settings.FileReferences.Physics
        ? context.sdk.CubismPhysics.create(
            JSON.parse(
              readFileSync(
                resolve(root, settings.FileReferences.Physics),
                "utf8",
              ),
            ),
          )
        : undefined;
      const model = {
        autoUpdate: true,
        __characterId: "main",
        internalModel: {
          coreModel: core,
          physics,
          settings: new context.sdk.CubismModelSettingsJson(settings),
          motionManager: {},
        },
      };
      return { native, core, moc, adapter: new ModelAdapter(model, 0) };
    };
    const first = make();
    let document = { ...emptyAnimation(), tracks: first.adapter.tracks };
    const motion = Object.entries(settings.FileReferences.Motions)[0] as [
      string,
      { File: string }[],
    ];
    document = importMaterial(
      document,
      document.tracks,
      readFileSync(resolve(root, motion[1][0].File), "utf8"),
      "motion",
      motion[0],
      0,
    );
    const expression = settings.FileReferences.Expressions?.[0];
    if (expression)
      document = importMaterial(
        document,
        document.tracks,
        readFileSync(resolve(root, expression.File), "utf8"),
        "expression",
        expression.Name ?? expression.File,
        0.25,
      );
    const renderer = new TimelineRenderer([first.adapter]);
    const capture = () => ({
      parameters: [...first.native.parameters.values],
      parts: [...first.native.parts.opacities],
      vertices: first.native.drawables.vertexPositions.map(
        (v: Float32Array) => [...v],
      ),
    });
    const lip = (t: number) => Math.max(0, Math.sin(t * 4));
    renderer.seek(document, 1.413, lip);
    const expected = capture();
    for (const t of [0.1, 2, 0, 1.2, 0.413, 1.413])
      renderer.seek(document, t, lip);
    assert.deepEqual(capture(), expected);
    const second = make();
    new TimelineRenderer([second.adapter]).seek(document, 1.413, lip);
    assert.deepEqual([...second.native.parameters.values], expected.parameters);
    second.native.drawables.vertexPositions.forEach(
      (v: Float32Array, i: number) =>
        assert.deepEqual([...v], expected.vertices[i]),
    );
    assert.ok(document.groups.length >= 1);
    assert.ok(document.tracks.some((t) => t.animated));
    console.log(
      `Native fixture: ${first.native.parameters.count} parameters, ${first.native.parts.count} parts, ${first.native.drawables.count} drawables`,
    );
    first.core.release();
    first.moc._release();
    second.core.release();
    second.moc._release();
  },
);
