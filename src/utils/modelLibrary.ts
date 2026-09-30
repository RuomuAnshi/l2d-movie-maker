import JSZip from "jszip";
import { appDataDir, basename, dirname, join } from "@tauri-apps/api/path";
import { mkdir, readDir, readFile, readTextFile, remove, stat, writeFile, writeTextFile } from "@tauri-apps/plugin-fs";

export type ModelPackage = {
  id: string;
  name: string;
  importedAt: string;
  modelPaths: string[];
};

const CATALOG_FILE = "model-library.json";
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_FILES = 20_000;
const MAX_SINGLE_FILE_BYTES = 512 * 1024 * 1024;

function ignoredResource(name: string) {
  return name === ".DS_Store" || name.startsWith("._") || name.startsWith("__MACOSX/");
}

export async function loadModelPackages(): Promise<ModelPackage[]> {
  const catalogPath = await join(await appDataDir(), CATALOG_FILE);
  try {
    const parsed: unknown = JSON.parse(await readTextFile(catalogPath));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is ModelPackage => (
      typeof item?.id === "string" && typeof item?.name === "string" &&
      typeof item?.importedAt === "string" && Array.isArray(item?.modelPaths) &&
      item.modelPaths.every((path: unknown) => typeof path === "string")
    ));
  } catch {
    return [];
  }
}

export async function saveModelPackages(packages: ModelPackage[]) {
  const dataDir = await appDataDir();
  await mkdir(dataDir, { recursive: true });
  await writeTextFile(await join(dataDir, CATALOG_FILE), JSON.stringify(packages, null, 2));
}

export async function importModelSource(sourcePath: string, modelRoot: string): Promise<ModelPackage> {
  const id = crypto.randomUUID();
  const packageRoot = await join(modelRoot, id);
  await mkdir(packageRoot, { recursive: true });
  let name = await basename(sourcePath);

  try {
    const info = await stat(sourcePath);
    if (info.isDirectory) {
      await copyDirectoryContents(sourcePath, packageRoot);
    } else if (/\.zip$/i.test(sourcePath)) {
      name = name.replace(/\.zip$/i, "");
      await extractZip(sourcePath, packageRoot);
    } else if (/\.(json|jsonl)$/i.test(sourcePath)) {
      name = name.replace(/(?:\.model[23])?\.(?:json|jsonl)$/i, "");
      const sourceRoot = await dirname(sourcePath);
      await copyDirectoryContents(sourceRoot, packageRoot);
    } else {
      throw new Error("请选择模型文件夹、.zip 压缩包或 .model.json/.model3.json/.jsonl 配置文件。");
    }

    return {
      id,
      name: name || "Live2D 模型",
      importedAt: new Date().toISOString(),
      modelPaths: [],
    };
  } catch (error) {
    try { await remove(packageRoot, { recursive: true }); } catch { /* 清理部分导入 */ }
    throw error;
  }
}

async function extractZip(archivePath: string, destination: string) {
  if ((await stat(archivePath)).size > MAX_ARCHIVE_BYTES) {
    throw new Error("压缩包超过 512 MiB，暂不支持导入。");
  }
  const archiveBytes = await readFile(archivePath);
  if (archiveBytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error("压缩包超过 512 MiB，暂不支持导入。");
  }
  const zip = await JSZip.loadAsync(archiveBytes, { checkCRC32: true });
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (entries.length > MAX_FILES) throw new Error(`压缩包文件过多（上限 ${MAX_FILES} 个）。`);

  let declaredBytesTotal = 0;
  let actualBytesTotal = 0;
  for (const entry of entries) {
    const originalName = entry.unsafeOriginalName ?? entry.name;
    const normalized = originalName.replace(/\\/g, "/");
    const parts = normalized.split("/");
    const unixMode = typeof entry.unixPermissions === "string"
      ? Number.parseInt(entry.unixPermissions, 8)
      : entry.unixPermissions;
    if (
      normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) ||
      parts.some((part) => part === "..") || normalized.includes("\0") ||
      (typeof unixMode === "number" && (unixMode & 0o170000) === 0o120000)
    ) {
      throw new Error(`压缩包包含不安全路径：${originalName}`);
    }
    if (ignoredResource(normalized)) continue;

    const compressedMetadata = (entry as unknown as { _data?: { uncompressedSize?: number } })._data;
    const declaredBytes = compressedMetadata?.uncompressedSize;
    if (typeof declaredBytes === "number") {
      if (declaredBytes > MAX_SINGLE_FILE_BYTES) throw new Error(`文件过大：${normalized}`);
      declaredBytesTotal += declaredBytes;
      if (declaredBytesTotal > MAX_EXPANDED_BYTES) throw new Error("压缩包解压后超过 2 GiB。");
    }

    const content = await entry.async("uint8array");
    if (content.byteLength > MAX_SINGLE_FILE_BYTES) throw new Error(`文件过大：${normalized}`);
    actualBytesTotal += content.byteLength;
    if (actualBytesTotal > MAX_EXPANDED_BYTES) throw new Error("压缩包解压后超过 2 GiB。");
    const outputPath = await join(destination, ...parts);
    await mkdir(await dirname(outputPath), { recursive: true });
    await writeFile(outputPath, content);
  }
}

async function copyDirectoryContents(source: string, destination: string) {
  let fileCount = 0;
  let totalBytes = 0;

  const copy = async (from: string, to: string): Promise<void> => {
    const entries = await readDir(from);
    for (const entry of entries) {
      if (entry.isSymlink || ignoredResource(entry.name)) continue;
      const sourceEntry = await join(from, entry.name);
      const outputEntry = await join(to, entry.name);
      if (entry.isDirectory) {
        await mkdir(outputEntry, { recursive: true });
        await copy(sourceEntry, outputEntry);
      } else if (entry.isFile) {
        fileCount += 1;
        if (fileCount > MAX_FILES) throw new Error(`模型文件过多（上限 ${MAX_FILES} 个）。`);
        const size = (await stat(sourceEntry)).size;
        totalBytes += size;
        if (size > MAX_SINGLE_FILE_BYTES || totalBytes > MAX_EXPANDED_BYTES) {
          throw new Error("模型资源超过导入限制（单个文件 512 MiB，总计 2 GiB）。");
        }
        await writeFile(outputEntry, await readFile(sourceEntry));
      }
    }
  };

  await copy(source, destination);
}
