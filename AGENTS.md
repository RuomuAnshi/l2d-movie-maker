# AGENTS.md

Live2D Movie Maker — React 19 + PIXI.js 6 frontend inside a Tauri 2 (Rust) desktop shell. Records/exports Live2D motion, expression, audio, and subtitle timelines to WebM/MOV, and imports WebGAL projects. UI and most comments are Chinese.

## Commands
- `npm run tauri:dev` — use this for any model, recording, export, or WebGAL work; the Rust `invoke` bridge and dialog/fs plugins only exist here.
- `npm run dev` — Vite-only on port 1431 (strictPort, HMR shares it). `invoke` calls fail and no models load; fine only for pure UI work.
- `npm run build` = `tsc -b && vite build`. Typecheck alone: `npx tsc -b`. Lint: `npm run lint` (ESLint, ts/tsx only) — passes with ~10 `react-hooks/exhaustive-deps` warnings.
- Rust: `cargo check` inside `src-tauri/` (crate `app_lib`, Rust >= 1.77.2); currently passes with warnings.
- No test suite and no CI. Verification = `npx tsc -b` + `npm run build` + `cargo check` + manual run.
- `src-tauri/tauri.conf.json` hardcodes `pnpm run dev` / `pnpm run build`, so pnpm must be installed even when launching via `npm run tauri:*`. Both `pnpm-lock.yaml` and `bun.lock` are committed; README and `.claude/settings.local.json` assume npm.
- pnpm 11 blocks unapproved build scripts and makes every `pnpm run *` fail with `ERR_PNPM_IGNORED_BUILDS`. The untracked `pnpm-workspace.yaml` (`allowBuilds: esbuild: true`) is required for esbuild/Vite to work — don't delete it.
- `ffmpeg` must be on PATH; Rust media commands call bare `ffmpeg`. The checked-in `src-tauri/bin/ffmpeg.exe` is not referenced anywhere.

## Architecture
- `src/components/Live2DView.tsx` (~2000 lines) is effectively the whole app: PIXI bootstrap, all timeline state, `applyTimelineAtTime`, playback loop, recording, offline export, WebGAL import, subtitle rendering. `ModelManager` / `AudioManager` / `RecordingManager` are hook-style factories returning imperative APIs, not React contexts.
- Models are served by a Rust `tiny_http` server, not Vite: `get_model_server_info` returns `http://127.0.0.1:<port>/model`, serving `<exe_dir>/model` and `<exe_dir>/figure`; `refresh_model_index` scans and writes `models.json`, which the frontend fetches first. WebGAL project assets go through `register_external_asset_root` and are served at `/external/<hash>/...`. `src/config/ports.ts` is largely legacy.
- In `tauri dev`, `<exe_dir>` is the cargo target dir (`src-tauri/target/debug` normally; with the redirect above, `~/.cache/l2d-movie-maker/cargo-target/debug/`), so test models belong in `<exe_dir>/model/`. The repo ships no model assets; README's `public/model/` layout is stale.
- Two model formats: single `.model.json`/`.model3.json`, and composite `.jsonl` unpacked by the `composite-model` package into `Live2DModel[]` plus a group container. `src/utils/modelData.ts` normalizes Cubism 2 (top-level `motions`/`expressions`) and Cubism 3/4/5 (`FileReferences.Motions/Expressions`) settings into the UI shape, with an `internalModel` runtime fallback; use it whenever reading motion/expression metadata.
- Offline export writes PNG frames to appCacheDir via plugin-fs, then Rust `encode_png_sequence_to_webm_alpha` (ffmpeg) muxes frame-aligned audio. Real-time recording uses `MediaRecorder` + VP9 alpha; `vp9_to_prores4444` converts to MOV.
- Current behavior lives only in code: `README.md` and `demo.md` predate WebGAL mode, subtitles, composite models, and offline export.

## Gotchas
- `scripts/gen-model-index.mjs` is legacy (browser-only model index, not wired to any npm script); the live path is Rust `refresh_model_index` → `models.json`.
- Several `src/` files contain mojibake Chinese comments rendered as `?` from an old encoding accident. Files are valid UTF-8; don't mass-rewrite them.
- This checkout sits on an exFAT drive. macOS writes a `com.apple.provenance` xattr on every new file there, producing an AppleDouble `._*` sibling (now gitignored). Cargo's target must stay off exFAT: `src-tauri/.cargo/config.toml` (machine-local, git-excluded) redirects `target-dir` to `~/.cache/l2d-movie-maker/cargo-target`. Without it, Tauri's `build.rs` panics reading its own `._default.toml` (`stream did not contain valid UTF-8`).
- Feature work lands on `dev` and merges to `main` via PRs (see git log); commit messages are short and often Chinese.
