import JSZip from "jszip";
import { appDataDir, appLocalDataDir, extname, join } from "@tauri-apps/api/path";
import { copyFile, mkdir, readFile, readTextFile, stat, writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import type { Clip, SubtitleClip } from "../components/timeline/clipTypes";

export type StoredClip = Omit<Clip, "audioBuffer" | "audioUrl">;
export type StoredSubtitleClip = Omit<SubtitleClip, "audioBuffer" | "audioUrl">;

export type ProjectSnapshot = {
  version: 1;
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
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;
const MAX_AUDIO_ASSETS_BYTES = 450 * 1024 * 1024;
const MAX_AUDIO_FILE_BYTES = 256 * 1024 * 1024;

export async function storeAudioAsset(sourcePath: string) {
  const audioRoot = await join(await appDataDir(), "projects", "autosave", "audio");
  await mkdir(audioRoot, { recursive: true });
  const extension = await extname(sourcePath);
  const managedPath = await join(audioRoot, `${crypto.randomUUID()}${extension}`);
  await copyFile(sourcePath, managedPath);
  return managedPath;
}

export async function storeAudioBytes(bytes: Uint8Array, extension: string) {
  const audioRoot = await join(await appDataDir(), "projects", "autosave", "audio");
  await mkdir(audioRoot, { recursive: true });
  const safeExtension = /^\.[a-z0-9]{1,8}$/i.test(extension) ? extension : ".audio";
  const managedPath = await join(audioRoot, `${crypto.randomUUID()}${safeExtension}`);
  await writeFile(managedPath, bytes);
  return managedPath;
}

export async function saveAutosaveProject(snapshot: ProjectSnapshot) {
  const localData = await appLocalDataDir();
  await mkdir(localData, { recursive: true });
  await writeTextFile(await join(localData, AUTOSAVE_FILE), JSON.stringify(snapshot));
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

export async function createProjectBundle(snapshot: ProjectSnapshot): Promise<Uint8Array> {
  const zip = new JSZip();
  const bundleSnapshot: ProjectSnapshot = {
    ...snapshot,
    savedAt: new Date().toISOString(),
    motionClips: snapshot.motionClips.map(stripRuntimeAudio),
    exprClips: snapshot.exprClips.map(stripRuntimeAudio),
    audioClips: snapshot.audioClips.map((clip) => ({ ...clip })),
    subtitleClips: snapshot.subtitleClips.map(stripRuntimeAudio),
  };
  let totalAudioBytes = 0;

  for (const clip of bundleSnapshot.audioClips) {
    if (!clip.audioPath) continue;
    const extension = await extname(clip.audioPath);
    const entryPath = `assets/audio/${clip.id}${extension}`;
    if ((await stat(clip.audioPath)).size > MAX_AUDIO_FILE_BYTES) throw new Error(`单个音频文件超过 256 MiB：${clip.name}`);
    const bytes = await readFile(clip.audioPath);
    if (bytes.byteLength > MAX_AUDIO_FILE_BYTES) throw new Error(`单个音频文件超过 256 MiB：${clip.name}`);
    totalAudioBytes += bytes.byteLength;
    if (totalAudioBytes > MAX_AUDIO_ASSETS_BYTES) {
      throw new Error("工程内音频总量超过 450 MiB，无法打包。");
    }
    zip.file(entryPath, bytes);
    clip.audioPath = `bundle:${entryPath}`;
  }

  zip.file(BUNDLE_PROJECT_FILE, JSON.stringify(bundleSnapshot, null, 2));
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 4 } });
  if (bytes.byteLength > MAX_BUNDLE_BYTES) throw new Error("生成的工程包超过 512 MiB。");
  return bytes;
}

export async function openProjectBundle(path: string): Promise<ProjectSnapshot> {
  if ((await stat(path)).size > MAX_BUNDLE_BYTES) throw new Error("工程压缩包超过 512 MiB。");
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_BUNDLE_BYTES) throw new Error("工程压缩包超过 512 MiB。");
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const projectFile = zip.file(BUNDLE_PROJECT_FILE);
  if (!projectFile) throw new Error("工程包中缺少 project.json。");
  const projectSize = (projectFile as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
  if (typeof projectSize === "number" && projectSize > 10 * 1024 * 1024) {
    throw new Error("工程清单超过 10 MiB。");
  }
  const content = await projectFile.async("string");
  if (content.length > 10 * 1024 * 1024) throw new Error("工程清单超过 10 MiB。");
  const parsed: unknown = JSON.parse(content);
  if (!isProjectSnapshot(parsed)) throw new Error("不支持的工程格式或工程文件已损坏。");

  let declaredAudioBytes = 0;
  let actualAudioBytes = 0;
  const restoredAudio: StoredClip[] = [];
  for (const clip of parsed.audioClips) {
    if (!clip.audioPath?.startsWith("bundle:")) {
      restoredAudio.push(clip);
      continue;
    }
    const archivePath = clip.audioPath.slice("bundle:".length);
    if (!archivePath.startsWith("assets/audio/") || archivePath.split("/").some((part) => part === "..")) {
      throw new Error("工程引用了不安全的音频路径。");
    }
    const entry = zip.file(archivePath);
    if (!entry || entry.dir) throw new Error(`找不到工程音频：${archivePath}`);
    const declaredBytes = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
    if (typeof declaredBytes === "number") {
      if (declaredBytes > MAX_AUDIO_FILE_BYTES) throw new Error(`工程音频过大：${archivePath}`);
      declaredAudioBytes += declaredBytes;
      if (declaredAudioBytes > MAX_AUDIO_ASSETS_BYTES) throw new Error("工程内音频总量超过 450 MiB。");
    }
    const audioBytes = await entry.async("uint8array");
    if (audioBytes.byteLength > MAX_AUDIO_FILE_BYTES) throw new Error(`工程音频过大：${archivePath}`);
    actualAudioBytes += audioBytes.byteLength;
    if (actualAudioBytes > MAX_AUDIO_ASSETS_BYTES) throw new Error("工程内音频总量超过 450 MiB。");
    restoredAudio.push({ ...clip, audioPath: await storeAudioBytes(audioBytes, await extname(archivePath)) });
  }
  const restored: ProjectSnapshot = { ...parsed, audioClips: restoredAudio };
  return restored;
}

function stripRuntimeAudio<T extends Clip>(clip: T): Omit<T, "audioBuffer" | "audioUrl"> {
  const { audioBuffer: _audioBuffer, audioUrl: _audioUrl, ...stored } = clip;
  return stored;
}

function isProjectSnapshot(value: unknown): value is ProjectSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ProjectSnapshot>;
  return candidate.version === 1 &&
    Array.isArray(candidate.motionClips) && Array.isArray(candidate.exprClips) &&
    Array.isArray(candidate.audioClips) && Array.isArray(candidate.subtitleClips) &&
    typeof candidate.selectedCharacterId === "string" &&
    typeof candidate.showSubtitles === "boolean" &&
    typeof candidate.showSubtitleSpeaker === "boolean" &&
    ["left", "center", "right"].includes(candidate.subtitleSpeakerAlign ?? "") &&
    ["low", "medium", "high"].includes(candidate.recordingQuality ?? "") &&
    candidate.characterTransform !== undefined && candidate.customRecordingBounds !== undefined;
}
