import { emptyAnimation } from "../animation/types";
import { createClip, createEditSequence, DEFAULT_TRANSFORM } from "./types";
import { sequenceDuration } from "./engine";
import type { ProjectAsset, ProjectDocument, Sequence } from "./types";
export function assetDuration(project: ProjectDocument, asset: ProjectAsset): number {
    const id = asset.metadata?.sequenceId;
    return Math.max(1 / project.fps, typeof id === "string" && project.sequences[id] ? sequenceDuration(project.sequences[id]) : asset.duration ?? (asset.kind === "text" ? 3 : 5));
}
export function assetRange(project: ProjectDocument, asset: ProjectAsset) {
    const duration = assetDuration(project, asset);
    const sourceIn = Math.max(0, Math.min(duration - 1 / project.fps, Number(asset.metadata?.sourceIn) || 0));
    const sourceOut = Math.max(sourceIn + 1 / project.fps, Math.min(duration, Number(asset.metadata?.sourceOut) || duration));
    return { sourceIn, sourceOut, duration: sourceOut - sourceIn };
}
/** Ephemeral sequences stay outside the saved project and never alter existing clips. */
export function sourcePreviewProject(project: ProjectDocument, asset: ProjectAsset): {
    project: ProjectDocument;
    sequenceId: string;
} {
    if (asset.kind === "sequence" && typeof asset.metadata?.sequenceId === "string")
        return { project, sequenceId: asset.metadata.sequenceId };
    const sequenceId = `preview:${project.id}:${asset.id}`;
    let sequence: Sequence;
    if (asset.kind === "live2d")
        sequence = { ...createEditSequence(asset.name), id: sequenceId, width:project.width,height:project.height,fps:project.fps,kind: "live2d", duration: assetDuration(project, asset), actors: [{ id: `preview-actor:${asset.id}`, assetId: asset.id, modelPartId: "main", name: asset.name, transform: { ...DEFAULT_TRANSFORM }, visible: true }], animation: emptyAnimation(), tracks: [] };
    else {
        if (asset.kind === "motion" || asset.kind === "expression")
            throw new Error("动作表情使用参数素材预览。");
        sequence = { ...createEditSequence(asset.name), id: sequenceId, width: project.width, height: project.height, fps: project.fps };
        sequence.tracks[0].clips = [createClip({ kind: asset.kind, assetId: asset.id, name: asset.name, text: asset.kind === "text" ? String(asset.metadata?.text ?? asset.name) : undefined, start: 0, duration: assetDuration(project, asset) })];
    }
    return { project: { ...project, sequences: { ...project.sequences, [sequenceId]: sequence } }, sequenceId };
}
