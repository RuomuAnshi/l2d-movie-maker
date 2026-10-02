import { appLocalDataDir, join } from "@tauri-apps/api/path";
import { mkdir, readDir, readTextFile, rename, remove, writeTextFile } from "@tauri-apps/plugin-fs";
import { isProjectSnapshot, type ProjectSnapshot } from "./projectStorage";
import type { ProjectDocument } from "../sequence/types";
export type RecoveryEntry = {
    name: string;
    path: string;
    savedAt: string;
    projectName: string;
};
const pending = new Map<string, Promise<void>>();
export function projectSignature(document: ProjectDocument): string {
    return JSON.stringify({ ...document, savedAt: "", assets: Object.fromEntries(Object.entries(document.assets).map(([id, asset]) => [id, { ...asset, lipSync: undefined, lipSyncSampleRate: undefined, waveformPeaks: undefined, metadata: { ...asset.metadata, thumbnail: undefined } }])) });
}
export async function writeAtomicText(path: string, text: string): Promise<void> {
    const temp = `${path}.${crypto.randomUUID()}.tmp`;
    try {
        await writeTextFile(temp, text);
        await rename(temp, path);
    }
    finally {
        try {
            await remove(temp);
        }
        catch { /* Renamed files have no temporary sibling. */ }
    }
}
export async function saveRecovery(snapshot: ProjectSnapshot): Promise<void> {
    const id = snapshot.document?.id;
    if (!id)
        return;
    const old = pending.get(id) ?? Promise.resolve();
    const next = old.catch(() => { }).then(async () => {
        const root = await join(await appLocalDataDir(), "recovery", encodeURIComponent(id));
        await mkdir(root, { recursive: true });
        const bucket = Math.floor(Date.now() / 60000);
        await writeAtomicText(await join(root, `${bucket}.json`), JSON.stringify(snapshot));
        const entries = (await readDir(root)).filter(entry => /^\d+\.json$/.test(entry.name)).sort((a, b) => b.name.localeCompare(a.name));
        for (const entry of entries.slice(30))
            await remove(await join(root, entry.name));
    });
    pending.set(id, next);
    try {
        await next;
    }
    finally {
        if (pending.get(id) === next)
            pending.delete(id);
    }
}
export async function listRecovery(projectId?: string): Promise<RecoveryEntry[]> {
    if (!projectId) {
        const root = await join(await appLocalDataDir(), "recovery");
        let directories;
        try {
            directories = await readDir(root);
        }
        catch {
            return [];
        }
        return (await Promise.all(directories.filter(entry => entry.isDirectory).map(entry => listRecovery(decodeURIComponent(entry.name))))).flat().sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    }
    const root = await join(await appLocalDataDir(), "recovery", encodeURIComponent(projectId));
    let files;
    try {
        files = await readDir(root);
    }
    catch {
        return [];
    }
    const results = await Promise.all(files.filter(entry => /^\d+\.json$/.test(entry.name)).map(async (entry) => {
        const path = await join(root, entry.name);
        try {
            const snapshot: unknown = JSON.parse(await readTextFile(path));
            if (!isProjectSnapshot(snapshot))
                return null;
            return { name: entry.name, path, savedAt: snapshot.savedAt, projectName: snapshot.document?.name ?? "工程" };
        }
        catch {
            return null;
        }
    }));
    return results.filter((entry): entry is RecoveryEntry => !!entry).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}
export async function readRecovery(path: string): Promise<ProjectSnapshot> {
    const value: unknown = JSON.parse(await readTextFile(path));
    if (!isProjectSnapshot(value))
        throw new Error("恢复文件无效。");
    return value;
}
