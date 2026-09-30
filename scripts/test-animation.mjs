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
    entryPoints: ["tests/animation.test.ts", "tests/real-model.test.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: dir,
  });
  const run = spawnSync(
    process.execPath,
    ["--test", join(dir, "animation.test.js"), join(dir, "real-model.test.js")],
    { stdio: "inherit" },
  );
  process.exitCode = run.status ?? 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
