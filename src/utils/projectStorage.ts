import { isAnimationDocument } from "../animation/validation";
import type { AnimationDocument } from "../animation/types";
import JSZip from "jszip";
import { appDataDir, appLocalDataDir, dirname, extname, join } from "@tauri-apps/api/path";
import { copyFile, mkdir, readFile, readTextFile, stat, writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import type { Clip, SubtitleClip } from "../components/timeline/clipTypes";
import { isProjectDocument } from "../sequence/validation";
import type { ProjectDocument } from "../sequence/types";

export type StoredClip = Omit<Clip, "audioBuffer" | "audioUrl">;
export type StoredSubtitleClip = Omit<SubtitleClip, "audioBuffer" | "audioUrl">;

export type ProjectSnapshot = {
  version: 1 | 2 | 3;
  document?: ProjectDocument;
  animation?: AnimationDocument;
  externalModelPath?: string;
  savedAt: string;
  selectedModel: string | null;
  selectedCharacterId: string;
  motionClips: Clip[];
  exprClips: Clip[];
  audioClips: StoredClip[];
  subtitleClips: StoredSubtitleClip[];
  showSubtitles: boolean;
  showSubtitleSpeaker: boolean;
  subtitleSpeakerAlign: "left" | "center" | "right";
  playhead: number;
  motionDur: number;
  exprDur: number;
  characterVisible: boolean;
  characterTransformMode: "single-relative" | "composite-container";
  characterTransform: { x: number; y: number; scaleX: number; scaleY: number; rotation: number };
  recordingQuality: "low" | "medium" | "high";
  transparentBg: boolean;
  customRecordingBounds: { x: number; y: number; width: number; height: number };
};

const AUTOSAVE_FILE = "autosave-project.json";
const BUNDLE_PROJECT_FILE = "project.json";
const MAX_BUNDLE_BYTES = 1536 * 1024 * 1024;
const MAX_AUDIO_ASSETS_BYTES = 450 * 1024 * 1024;
const MAX_AUDIO_FILE_BYTES = 256 * 1024 * 1024;
const MAX_MODEL_ASSETS_BYTES = 1024 * 1024 * 1024;
const MAX_MODEL_FILE_BYTES = 512 * 1024 * 1024;
const MAX_BUNDLE_FILES = 20_000;
const MAX_PROJECT_MANIFEST_BYTES = 64 * 1024 * 1024;

/** Keep filesystem relationships intact, including JSONL parts in sibling folders. */
export function normalizeResourcePath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const prefix = normalized.startsWith("//") ? "//" : normalized.startsWith("/") ? "/" : /^[A-Za-z]:\//.test(normalized) ? normalized.slice(0, 3) : "";
  const parts: string[] = [];
  for (const part of normalized.slice(prefix.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length && parts[parts.length - 1] !== "..") parts.pop();
    else if (part === ".." && !prefix || part !== "..") parts.push(part);
  }
  return `${prefix}${parts.join("/")}`;
}

export function modelResourceReferences(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];
  const value = raw as Record<string, unknown>;
  const references: string[] = [];
  const add = (candidate: unknown) => { if (typeof candidate === "string" && candidate.trim()) references.push(candidate); };
  const list = (candidate: unknown) => { if (Array.isArray(candidate)) candidate.forEach(add); };
  const entries = (candidate: unknown) => {
    if (!Array.isArray(candidate)) return;
    for (const item of candidate) {
      if (item && typeof item === "object") {
        const entry = item as Record<string, unknown>;
        add(entry.file ?? entry.File); add(entry.sound ?? entry.Sound);
      }
    }
  };
  add(value.model); add(value.physics); add(value.pose); list(value.textures); entries(value.expressions);
  if (value.motions && typeof value.motions === "object") Object.values(value.motions).forEach(entries);
  if (value.FileReferences && typeof value.FileReferences === "object") {
    const files = value.FileReferences as Record<string, unknown>;
    for (const key of ["Moc", "Physics", "Pose", "DisplayInfo", "UserData"]) add(files[key]);
    list(files.Textures); entries(files.Expressions);
    if (files.Motions && typeof files.Motions === "object") Object.values(files.Motions).forEach(entries);
  }
  return [...new Set(references)];
}

function remapModelReferences(raw: Record<string, unknown>, remap: (path: string) => string) {
  const fields = (record: Record<string, unknown>, names: string[]) => {
    for (const name of names) if (typeof record[name] === "string") record[name] = remap(record[name] as string);
  };
  const list = (record: Record<string, unknown>, name: string) => {
    if (Array.isArray(record[name])) record[name] = (record[name] as unknown[]).map(item => typeof item === "string" ? remap(item) : item);
  };
  const entries = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) if (item && typeof item === "object") fields(item as Record<string, unknown>, ["file", "File", "sound", "Sound"]);
  };
  fields(raw, ["model", "physics", "pose"]); list(raw, "textures"); entries(raw.expressions);
  if (raw.motions && typeof raw.motions === "object") Object.values(raw.motions).forEach(entries);
  if (raw.FileReferences && typeof raw.FileReferences === "object") {
    const files = raw.FileReferences as Record<string, unknown>;
    fields(files, ["Moc", "Physics", "Pose", "DisplayInfo", "UserData"]); list(files, "Textures"); entries(files.Expressions);
    if (files.Motions && typeof files.Motions === "object") Object.values(files.Motions).forEach(entries);
  }
}

function absoluteResourcePath(sourceDir: string, reference: string) {
  if (/^[a-z]+:/i.test(reference) && !/^[A-Za-z]:[\\/]/.test(reference)) throw new Error(`模型引用远程资源，无法建立离线工程包：${reference}`);
  return normalizeResourcePath(/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(reference) ? reference : `${sourceDir}/${reference}`);
}

function relativeResourcePath(sourceDir: string, targetPath: string) {
  const from = normalizeResourcePath(sourceDir).replace(/\/$/, "").split("/");
  const to = normalizeResourcePath(targetPath).split("/");
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common++;
  if (!common) throw new Error("模型资源跨文件系统，无法打包。");
  return [...from.slice(common).map(() => ".."), ...to.slice(common)].join("/");
}

function safeArchivePath(path: string, prefix: string) {
  const parts = path.split("/");
  return path.startsWith(prefix) && !path.includes("\\") && !path.includes("\0") && parts.every(part => part && part !== "." && part !== "..");
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, byte) => {
  let crc = byte;
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

async function readCheckedArchiveEntry(entry: JSZip.JSZipObject, maximum: number): Promise<Uint8Array> {
  const metadata = (entry as unknown as { _data?: { uncompressedSize?: number; crc32?: number } })._data;
  if ((metadata?.uncompressedSize ?? 0) > maximum) throw new Error(`工程包文件过大：${entry.name}`);
  const data = await entry.async("uint8array");
  if (data.byteLength > maximum || (metadata?.uncompressedSize != null && data.byteLength !== metadata.uncompressedSize)) throw new Error(`工程包文件长度不正确：${entry.name}`);
  if (metadata?.crc32 != null) {
    let crc = 0xffffffff;
    for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    if ((~crc >>> 0) !== (metadata.crc32 >>> 0)) throw new Error(`工程包文件校验失败：${entry.name}`);
  }
  return data;
}

async function contentDigest(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}

async function collectModelResources(primaryPath: string, availableBytes: number, cache: Map<string, Uint8Array>) {
  const resources = new Map<string, Uint8Array>();
  const settings = new Set<string>();
  const parsedSettings = new Map<string, Array<Record<string, unknown>>>();
  let resourceBytes = 0;
  const read = async (path: string, isSettings: boolean): Promise<void> => {
    path = normalizeResourcePath(path);
    if (!resources.has(path)) {
      if (resources.size >= MAX_BUNDLE_FILES) throw new Error(`模型文件过多（上限 ${MAX_BUNDLE_FILES} 个）。`);
      const cached = cache.get(path);
      if (cached) resources.set(path, cached);
      else {
        let size = 0;
        try { size = (await stat(path)).size; } catch { throw new Error(`模型引用的资源不存在：${path}`); }
        if (size > MAX_MODEL_FILE_BYTES) throw new Error(`模型文件超过 512 MiB：${path}`);
        if (resourceBytes + size > availableBytes) throw new Error("工程模型资源总量超过 1 GiB，无法打包。");
        const data = await readFile(path);
        if (data.byteLength > MAX_MODEL_FILE_BYTES) throw new Error(`模型文件超过 512 MiB：${path}`);
        resourceBytes += data.byteLength;
        if (resourceBytes > availableBytes) throw new Error("工程模型资源总量超过 1 GiB，无法打包。");
        resources.set(path, data);
        cache.set(path, data);
      }
    }
    if (!isSettings || settings.has(path)) return;
    settings.add(path);
    const text = new TextDecoder().decode(resources.get(path)!);
    const sourceDir = normalizeResourcePath(await dirname(path));
    const readReference = async (reference: string, model = false) => {
      await read(absoluteResourcePath(sourceDir, reference), model);
    };
    if (/\.jsonl$/i.test(path)) {
      const lines: Array<Record<string, unknown>> = [];
      for (const line of text.split(/\r?\n/).filter(line => line.trim())) {
        const raw = JSON.parse(line) as Record<string, unknown>;
        lines.push(raw);
        if (typeof raw.path === "string") await readReference(raw.path, true);
        else for (const reference of modelResourceReferences(raw)) await readReference(reference);
      }
      parsedSettings.set(path, lines);
    } else {
      const raw = JSON.parse(text) as Record<string, unknown>;
      for (const reference of modelResourceReferences(raw)) await readReference(reference);
      parsedSettings.set(path, [raw]);
    }
  };
  await read(primaryPath, true);
  const paths = [...resources.keys()];
  let root = normalizeResourcePath(await dirname(paths[0]));
  while (!paths.every(path => path.startsWith(root.endsWith("/") ? root : `${root}/`))) {
    const parent = normalizeResourcePath(await dirname(root));
    if (parent === root) throw new Error("模型资源跨文件系统，无法打包。");
    root = parent;
  }
  for (const [path, records] of parsedSettings) {
    const sourceDir = normalizeResourcePath(await dirname(path));
    const remap = (reference: string) => relativeResourcePath(sourceDir, absoluteResourcePath(sourceDir, reference));
    for (const raw of records) {
      if (/\.jsonl$/i.test(path) && typeof raw.path === "string") raw.path = remap(raw.path);
      remapModelReferences(raw, remap);
    }
    resources.set(path, new TextEncoder().encode(records.map(raw => JSON.stringify(raw)).join("\n")));
  }
  return { root, resources };
}

async function checkRestoredModelResources(primaryPath: string, packageRoot: string) {
  const checkedFiles = new Set<string>();
  const checkedSettings = new Set<string>();
  const normalizedRoot = normalizeResourcePath(packageRoot);
  const check = async (path: string, settings: boolean): Promise<void> => {
    path = normalizeResourcePath(path);
    if (!path.startsWith(`${normalizedRoot}/`)) throw new Error(`模型资源不在工程包内：${path}`);
    if (!checkedFiles.has(path)) {
      if (checkedFiles.size >= MAX_BUNDLE_FILES) throw new Error("模型资源引用过多。");
      if (!(await stat(path)).isFile) throw new Error(`模型资源不存在：${path}`);
      checkedFiles.add(path);
    }
    if (!settings || checkedSettings.has(path)) return;
    checkedSettings.add(path);
    const text = await readTextFile(path);
    const sourceDir = normalizeResourcePath(await dirname(path));
    if (/\.jsonl$/i.test(path)) {
      let parts = 0;
      for (const line of text.split(/\r?\n/).filter(line => line.trim())) {
        const raw = JSON.parse(line) as Record<string, unknown>;
        if (typeof raw.path === "string") { parts++; await check(absoluteResourcePath(sourceDir, raw.path), true); }
      }
      if (!parts) throw new Error("组合模型没有可用的模型部件。");
    } else {
      const raw: unknown = JSON.parse(text);
      const references = modelResourceReferences(raw);
      if (!references.length) throw new Error("模型配置没有可用的资源引用。");
      for (const reference of references) await check(absoluteResourcePath(sourceDir, reference), false);
    }
  };
  await check(primaryPath, true);
}

export async function storeAudioAsset(sourcePath: string) {
  const audioRoot = await join(await appDataDir(), "projects", "autosave", "audio");
  await mkdir(audioRoot, { recursive: true });
  const extension = await extname(sourcePath);
  const managedPath = await join(audioRoot, `${crypto.randomUUID()}${extension}`);
  await copyFile(sourcePath, managedPath);
  return managedPath;
}

export async function storeImageAsset(sourcePath: string) {
  const imageRoot = await join(await appDataDir(), "projects", "autosave", "images");
  await mkdir(imageRoot, { recursive: true });
  const extension = await extname(sourcePath);
  const managedPath = await join(imageRoot, `${crypto.randomUUID()}${extension || ".img"}`);
  await copyFile(sourcePath, managedPath);
  return managedPath;
}

export async function storeAudioBytes(bytes: Uint8Array, extension: string) {
  return storeAssetBytes(bytes, extension, "audio");
}

export async function storeImageBytes(bytes: Uint8Array, extension: string) {
  return storeAssetBytes(bytes, extension, "image");
}

async function storeAssetBytes(bytes: Uint8Array, extension: string, kind: "audio" | "image") {
  const assetRoot = await join(await appDataDir(), "projects", "autosave", kind === "audio" ? "audio" : "images");
  await mkdir(assetRoot, { recursive: true });
  const safeExtension = /^\.[a-z0-9]{1,8}$/i.test(extension) ? extension : kind === "audio" ? ".audio" : ".img";
  const managedPath = await join(assetRoot, `${crypto.randomUUID()}${safeExtension}`);
  await writeFile(managedPath, bytes);
  return managedPath;
}

export async function saveAutosaveProject(snapshot: ProjectSnapshot) {
  const localData = await appLocalDataDir();
  await mkdir(localData, { recursive: true });
  const path = await join(localData, AUTOSAVE_FILE);
  if (snapshot.version === 2 || snapshot.version === 3) {
    let previous: string | null = null;
    try { previous = await readTextFile(path); } catch { /* A first save has no previous file. */ }
    if (previous) {
      let previousVersion: number | undefined;
      try { previousVersion = JSON.parse(previous).version; } catch { /* Preserve valid legacy documents before upgrading. */ }
      if (previousVersion && previousVersion < snapshot.version && (previousVersion === 1 || previousVersion === 2)) {
        await writeTextFile(await join(localData, `autosave-v${previousVersion}-backup-${Date.now()}.json`), previous);
      }
    }
  }
  await writeTextFile(path, JSON.stringify(snapshot));
}

export async function loadAutosaveProject(): Promise<ProjectSnapshot | null> {
  try {
    const path = await join(await appLocalDataDir(), AUTOSAVE_FILE);
    const value: unknown = JSON.parse(await readTextFile(path));
    return isProjectSnapshot(value) ? value : null;
  } catch {
    return null;
  }
}

export async function createProjectBundle(snapshot: ProjectSnapshot, modelRoot?: string): Promise<Uint8Array> {
  const zip = new JSZip();
  const bundleSnapshot: ProjectSnapshot = {
    ...snapshot,
    document: snapshot.document ? structuredClone(snapshot.document) : undefined,
    savedAt: new Date().toISOString(),
    motionClips: snapshot.motionClips.map(stripRuntimeAudio),
    exprClips: snapshot.exprClips.map(stripRuntimeAudio),
    audioClips: snapshot.audioClips.map((clip) => ({ ...clip })),
    subtitleClips: snapshot.subtitleClips.map(stripRuntimeAudio),
  };
  let totalAudioBytes = 0;
  let totalModelBytes = 0;
  const bundledPaths = new Map<string, string>();
  const bundledContent = new Map<string, string>();
  const bundledModelRoots = new Map<string, string>();
  const bundledModelPaths = new Map<string, string>();
  const modelResourceCache = new Map<string, Uint8Array>();
  for (const asset of Object.values(bundleSnapshot.document?.assets ?? {})) {
    if (asset.uri.startsWith("bundle:") && !asset.missing) throw new Error(`素材“${asset.name}”尚未恢复，请重新链接素材。`);
  }

  const addAssetBytes = async (sourcePath: string, kind: "audio" | "image", name: string, id: string) => {
    const cacheKey = `${kind}:${sourcePath}`;
    const existing = bundledPaths.get(cacheKey);
    if (existing) return existing;
    const extension = await extname(sourcePath);
    const safeId = encodeURIComponent(id);
    let entryPath = `assets/${kind}/${safeId}${extension || (kind === "audio" ? ".audio" : ".img")}`;
    let size = 0;
    try { size = (await stat(sourcePath)).size; } catch { throw new Error(`找不到素材文件：${name}`); }
    if (size > MAX_AUDIO_FILE_BYTES) throw new Error(`单个素材文件超过 256 MiB：${name}`);
    const bytes = await readFile(sourcePath);
    if (bytes.byteLength > MAX_AUDIO_FILE_BYTES) throw new Error(`单个素材文件超过 256 MiB：${name}`);
    const digest = `${kind}:${await contentDigest(bytes)}`;
    const sameContent = bundledContent.get(digest);
    if (sameContent) {
      bundledPaths.set(cacheKey, sameContent);
      return sameContent;
    }
    if (zip.file(entryPath)) entryPath = `assets/${kind}/${crypto.randomUUID()}${extension}`;
    totalAudioBytes += bytes.byteLength;
    if (totalAudioBytes > MAX_AUDIO_ASSETS_BYTES) throw new Error("工程内媒体素材总量超过 450 MiB，无法打包。");
    zip.file(entryPath, bytes);
    bundledPaths.set(cacheKey, entryPath);
    bundledContent.set(digest, entryPath);
    return entryPath;
  };

  for (const clip of bundleSnapshot.audioClips) {
    if (!clip.audioPath) continue;
    const audioAsset = bundleSnapshot.document?.assets[`asset:audio:${clip.id}`]
      ?? Object.values(bundleSnapshot.document?.assets ?? {}).find(asset => asset.kind === "audio" && asset.uri === clip.audioPath);
    if (audioAsset?.missing) continue;
    if (clip.audioPath.startsWith("bundle:")) throw new Error(`音频素材“${clip.name}”尚未恢复，请重新链接素材。`);
    const entryPath = await addAssetBytes(clip.audioPath, "audio", clip.name, clip.id);
    clip.audioPath = `bundle:${entryPath}`;
    if (audioAsset) audioAsset.uri = `bundle:${entryPath}`;
  }

  for (const asset of Object.values(bundleSnapshot.document?.assets ?? {})) {
    if ((asset.kind !== "audio" && asset.kind !== "image") || !asset.uri || asset.uri.startsWith("bundle:")) continue;
    if (asset.missing) continue;
    asset.uri = `bundle:${await addAssetBytes(asset.uri, asset.kind, asset.name, asset.id)}`;
    asset.missing = false;
  }

  for (const asset of Object.values(bundleSnapshot.document?.assets ?? {})) {
    if (asset.kind !== "live2d" || !asset.uri || asset.uri.startsWith("bundle:") || asset.missing) continue;
    if (!modelRoot) throw new Error(`打包模型“${asset.name}”需要模型库路径，但模型库尚未初始化。`);
    const modelPath = /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(asset.uri) ? asset.uri : await join(modelRoot, asset.uri);
    const previousUri = bundledModelPaths.get(normalizeResourcePath(modelPath));
    if (previousUri) { asset.uri = previousUri; continue; }
    const { root, resources } = await collectModelResources(modelPath, MAX_MODEL_ASSETS_BYTES - totalModelBytes, modelResourceCache);
    let prefix = bundledModelRoots.get(root);
    if (!prefix) {
      prefix = `assets/models/model-${encodeURIComponent(asset.id)}`;
      bundledModelRoots.set(root, prefix);
    }
    const rootPrefix = root.endsWith("/") ? root : `${root}/`;
    for (const [path, data] of resources) {
      const entryPath = `${prefix}/${path.slice(rootPrefix.length)}`;
      if (zip.file(entryPath)) continue;
      totalModelBytes += data.byteLength;
      if (totalModelBytes > MAX_MODEL_ASSETS_BYTES) throw new Error("工程模型资源总量超过 1 GiB，无法打包。");
      zip.file(entryPath, data);
    }
    asset.uri = `bundle:${prefix}/${normalizeResourcePath(modelPath).slice(rootPrefix.length)}`;
    bundledModelPaths.set(normalizeResourcePath(modelPath), asset.uri);
  }

  const manifest = JSON.stringify(bundleSnapshot, null, 2);
  if (new TextEncoder().encode(manifest).byteLength > MAX_PROJECT_MANIFEST_BYTES) throw new Error("工程清单超过 64 MiB。");
  zip.file(BUNDLE_PROJECT_FILE, manifest);
  if (Object.values(zip.files).filter(entry => !entry.dir).length > MAX_BUNDLE_FILES) throw new Error(`工程包文件过多（上限 ${MAX_BUNDLE_FILES} 个）。`);
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 4 } });
  if (bytes.byteLength > MAX_BUNDLE_BYTES) throw new Error("生成的工程包超过 1.5 GiB。");
  return bytes;
}

export async function openProjectBundle(path: string, modelRoot?: string): Promise<ProjectSnapshot> {
  if ((await stat(path)).size > MAX_BUNDLE_BYTES) throw new Error("工程压缩包超过 1.5 GiB。");
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_BUNDLE_BYTES) throw new Error("工程压缩包超过 1.5 GiB。");
  // CRC checking during load inflates every entry before its size can be checked.
  const zip = await JSZip.loadAsync(bytes);
  const files = Object.values(zip.files).filter(entry => !entry.dir);
  if (files.length > MAX_BUNDLE_FILES) throw new Error(`工程包文件过多（上限 ${MAX_BUNDLE_FILES} 个）。`);
  let declaredMediaBytes = 0;
  let declaredModelBytes = 0;
  for (const entry of files) {
    const original = entry.unsafeOriginalName ?? entry.name;
    if (!safeArchivePath(original, "") || original.startsWith("/") || /^[A-Za-z]:/.test(original)) throw new Error(`工程包包含不安全路径：${original}`);
    const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    if (entry.name.startsWith("assets/models/")) {
      if (size > MAX_MODEL_FILE_BYTES) throw new Error(`工程模型文件超过 512 MiB：${entry.name}`);
      declaredModelBytes += size;
    } else if (entry.name.startsWith("assets/audio/") || entry.name.startsWith("assets/image/")) {
      if (size > MAX_AUDIO_FILE_BYTES) throw new Error(`工程素材文件超过 256 MiB：${entry.name}`);
      declaredMediaBytes += size;
    } else if (entry.name === BUNDLE_PROJECT_FILE && size > MAX_PROJECT_MANIFEST_BYTES) throw new Error("工程清单超过 64 MiB。");
  }
  if (declaredModelBytes > MAX_MODEL_ASSETS_BYTES) throw new Error("工程模型资源总量超过 1 GiB。");
  if (declaredMediaBytes > MAX_AUDIO_ASSETS_BYTES) throw new Error("工程内媒体素材总量超过 450 MiB。");
  const projectFile = zip.file(BUNDLE_PROJECT_FILE);
  if (!projectFile) throw new Error("工程包中缺少 project.json。");
  const content = new TextDecoder().decode(await readCheckedArchiveEntry(projectFile, MAX_PROJECT_MANIFEST_BYTES));
  const parsed: unknown = JSON.parse(content);
  if (!isProjectSnapshot(parsed)) throw new Error("不支持的工程格式或工程文件已损坏。");

  const document = parsed.document ? structuredClone(parsed.document) : undefined;
  const restoredBundlePaths = new Map<string, string>();
  let actualMediaBytes = 0;
  const restoreMedia = async (archivePath: string, kind: "audio" | "image") => {
    if (!safeArchivePath(archivePath, `assets/${kind}/`)) throw new Error("工程引用了不安全的素材路径。");
    const cached = restoredBundlePaths.get(archivePath);
    if (cached) return cached;
    const entry = zip.file(archivePath);
    if (!entry || entry.dir) return undefined;
    const data = await readCheckedArchiveEntry(entry, MAX_AUDIO_FILE_BYTES);
    actualMediaBytes += data.byteLength;
    if (actualMediaBytes > MAX_AUDIO_ASSETS_BYTES) throw new Error("工程内媒体素材总量超过 450 MiB。");
    const managedPath = await storeAssetBytes(data, await extname(archivePath), kind);
    restoredBundlePaths.set(archivePath, managedPath);
    return managedPath;
  };
  const markMissing = (asset: NonNullable<ProjectSnapshot["document"]>["assets"][string], reason: string) => {
    asset.missing = true;
    asset.metadata = { ...asset.metadata, missingReason: reason, originalUri: asset.metadata?.originalUri ?? asset.uri };
  };
  const restoredAudio: StoredClip[] = [];
  for (const clip of parsed.audioClips) {
    if (!clip.audioPath?.startsWith("bundle:")) { restoredAudio.push(clip); continue; }
    const archivePath = clip.audioPath.slice("bundle:".length);
    const restoredPath = await restoreMedia(archivePath, "audio");
    restoredAudio.push({ ...clip, audioPath: restoredPath ?? clip.audioPath });
  }
  let restoredModelBytes = 0;
  const restoredModelPackages = new Map<string, string>();
  const modelResourceIssues = new Map<string, string | null>();
  for (const asset of Object.values(document?.assets ?? {})) {
    if (asset.kind === "live2d" && asset.uri.startsWith("bundle:")) {
      const archivePath = asset.uri.slice("bundle:".length);
      const parts = archivePath.split("/");
      if (!safeArchivePath(archivePath, "assets/models/") || parts.length < 4) throw new Error("工程引用了不安全的模型路径。");
      if (!modelRoot) { markMissing(asset, "模型库尚未初始化，请重新链接模型。"); continue; }
      if (!zip.file(archivePath)) { markMissing(asset, `工程包缺少模型配置：${archivePath}`); continue; }
      const prefix = parts.slice(0, 3).join("/");
      let packageKey = restoredModelPackages.get(prefix);
      if (!packageKey) {
        packageKey = crypto.randomUUID();
        const packageEntries = files.filter(entry => entry.name.startsWith(`${prefix}/`));
        for (const entry of packageEntries) {
          const relative = entry.name.slice(prefix.length + 1);
          if (!safeArchivePath(relative, "")) throw new Error("工程模型包中包含不安全路径。");
          const data = await readCheckedArchiveEntry(entry, MAX_MODEL_FILE_BYTES);
          restoredModelBytes += data.byteLength;
          if (restoredModelBytes > MAX_MODEL_ASSETS_BYTES) throw new Error("工程模型资源总量超过 1 GiB。");
          const destination = await join(modelRoot, "project-assets", packageKey, ...relative.split("/"));
          await mkdir(await dirname(destination), { recursive: true });
          await writeFile(destination, data);
        }
        restoredModelPackages.set(prefix, packageKey);
      }
      asset.uri = `project-assets/${packageKey}/${parts.slice(3).join("/")}`;
      let issue = modelResourceIssues.get(asset.uri);
      if (issue === undefined) {
        try {
          await checkRestoredModelResources(await join(modelRoot, asset.uri), await join(modelRoot, "project-assets", packageKey));
          issue = null;
        } catch (error) { issue = `工程模型资源不完整：${String(error)}`; }
        modelResourceIssues.set(asset.uri, issue);
      }
      if (issue) {
        asset.metadata = { ...asset.metadata, originalUri: asset.metadata?.originalUri ?? `bundle:${archivePath}` };
        markMissing(asset, issue);
      } else asset.missing = false;
    } else if ((asset.kind === "audio" || asset.kind === "image") && asset.uri.startsWith("bundle:")) {
      const managedPath = await restoreMedia(asset.uri.slice("bundle:".length), asset.kind);
      if (!managedPath) { markMissing(asset, `工程包缺少素材：${asset.uri}`); continue; }
      asset.uri = managedPath;
      asset.missing = false;
    } else if (asset.kind === "live2d" || asset.kind === "audio" || asset.kind === "image") {
      let assetPath = asset.uri;
      if (asset.kind === "live2d" && !/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(assetPath)) {
        if (!modelRoot) { markMissing(asset, "模型库尚未初始化，请重新链接模型。"); continue; }
        assetPath = await join(modelRoot, assetPath);
      }
      try { if (!(await stat(assetPath)).isFile) markMissing(asset, `素材文件不存在：${asset.uri}`); }
      catch { markMissing(asset, `素材文件不存在：${asset.uri}`); }
    }
  }
  for (const sequence of Object.values(document?.sequences ?? {})) {
    for (const track of sequence.tracks) {
      for (const clip of track.clips) {
        const missingAsset = clip.assetId ? document?.assets[clip.assetId] : undefined;
        if (missingAsset?.missing) clip.placeholder = { reason: String(missingAsset.metadata?.missingReason ?? "缺失素材，请重新链接。"), original: clip.placeholder?.original ?? { assetId: clip.assetId, uri: missingAsset.uri } };
      }
    }
  }
  const visited = new Set<string>();
  const primaryCandidates: string[] = [];
  const collectPrimaryModels = (sequenceId: string): void => {
    if (!document || visited.has(sequenceId)) return;
    visited.add(sequenceId);
    const sequence = document.sequences[sequenceId];
    if (!sequence) return;
    if (sequence.kind === "live2d") {
      primaryCandidates.push(...sequence.actors.map(actor => actor.assetId));
      return;
    }
    for (const track of [...sequence.tracks].sort((a, b) => a.order - b.order)) {
      for (const clip of [...track.clips].sort((a, b) => a.start - b.start)) {
        if (!clip.sequenceId) continue;
        collectPrimaryModels(clip.sequenceId);
      }
    }
  };
  if (document) collectPrimaryModels(document.rootSequenceId);
  const primaryModelId = primaryCandidates.find(id => document?.assets[id]?.kind === "live2d" && !document.assets[id].missing) ?? primaryCandidates[0];
  const primaryModel = primaryModelId ? document?.assets[primaryModelId] : undefined;
  const primaryPath = primaryModel?.kind === "live2d" && !primaryModel.missing ? primaryModel.uri : undefined;
  const absolutePrimary = primaryPath && /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(primaryPath);
  return {
    ...parsed, audioClips: restoredAudio, document,
    ...(document ? { selectedModel: primaryPath && !absolutePrimary ? primaryPath : null, externalModelPath: absolutePrimary ? primaryPath : undefined } : {}),
  };
}

export function stripRuntimeAudio<T extends Clip>(clip: T): Omit<T, "audioBuffer" | "audioUrl"> {
  const stored = { ...clip };
  delete stored.audioBuffer;
  delete stored.audioUrl;
  return stored;
}

function isProjectSnapshot(value: unknown): value is ProjectSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ProjectSnapshot>;
  return (candidate.version === 1 || (candidate.version === 2 && isAnimationDocument(candidate.animation)) || candidate.version === 3) &&
    (candidate.version !== 3 || isProjectDocument(candidate.document)) &&
    Array.isArray(candidate.motionClips) && Array.isArray(candidate.exprClips) &&
    Array.isArray(candidate.audioClips) && Array.isArray(candidate.subtitleClips) &&
    typeof candidate.selectedCharacterId === "string" &&
    typeof candidate.showSubtitles === "boolean" &&
    typeof candidate.showSubtitleSpeaker === "boolean" &&
    ["left", "center", "right"].includes(candidate.subtitleSpeakerAlign ?? "") &&
    ["low", "medium", "high"].includes(candidate.recordingQuality ?? "") &&
    candidate.characterTransform !== undefined && candidate.customRecordingBounds !== undefined;
}
