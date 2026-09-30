import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite/package.json"))(
  "esbuild",
);
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const dir = await mkdtemp(join(tmpdir(), "l2d-tests-"));
try {
  await build({
    entryPoints: ["tests/animation.test.ts", "tests/real-model.test.ts", "tests/sequence.test.ts", "tests/scene-runtime.test.ts", "tests/text.test.ts", "tests/materials.test.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: dir,
  });
  await build({
    entryPoints: ["tests/export-storage.test.ts", "tests/buffer-audio.test.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: dir,
    banner: { js: 'import { createRequire as testCreateRequire } from "node:module"; const require = testCreateRequire(import.meta.url);' },
    alias: {
      "@tauri-apps/api/path": "./tests/mocks/tauri-storage.ts",
      "@tauri-apps/api/core": "./tests/mocks/tauri-storage.ts",
      "@tauri-apps/plugin-fs": "./tests/mocks/tauri-storage.ts",
      "react": "./tests/mocks/react-audio.ts",
    },
  });
  await build({
    entryPoints: ["tests/model-manager.test.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: dir,
    alias: {
      "react": "./tests/mocks/model-manager.ts",
      "pixi.js": "./tests/mocks/model-manager.ts",
      "pixi-live2d-display": "./tests/mocks/model-manager.ts",
      "composite-model": "./tests/mocks/model-manager.ts",
    },
  });
  await build({
    entryPoints: ["tests/scene-compositor.test.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: dir,
    alias: {
      "pixi.js": "./tests/mocks/scene-compositor.ts",
      "pixi-live2d-display": "./tests/mocks/scene-compositor.ts",
      "composite-model": "./tests/mocks/scene-compositor.ts",
    },
  });
  const run = spawnSync(
    process.execPath,
    ["--test", join(dir, "animation.test.js"), join(dir, "real-model.test.js"), join(dir, "sequence.test.js"), join(dir, "scene-runtime.test.js"), join(dir, "export-storage.test.js"), join(dir, "buffer-audio.test.js"), join(dir, "model-manager.test.js"), join(dir, "text.test.js"), join(dir, "scene-compositor.test.js"), join(dir, "materials.test.js")],
    { stdio: "inherit" },
  );
  process.exitCode = run.status ?? 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
