import { setSequence, snapFrame, updateClip } from "./engine";
import type { Clip, ProjectDocument } from "./types";
/** Atomic batch edits refuse locked selections instead of editing just the first item. */
export function patchClips(project: ProjectDocument, sequenceId: string, ids: string[], patch: (clip: Clip) => Partial<Clip>): ProjectDocument {
    const sequence = project.sequences[sequenceId];
    if (!sequence)
        throw new Error("序列不存在。");
    const selected = sequence.tracks.flatMap(track => track.clips.filter(clip => ids.includes(clip.id)).map(clip => ({ track, clip })));
    if (selected.some(item => item.track.locked))
        throw new Error("选区包含锁定轨道。");
    let next = project;
    for (const { track, clip } of selected)
        next = updateClip(next, sequenceId, track.id, clip.id, patch(clip), sequence.fps);
    return next;
}
export function slipClips(project: ProjectDocument, sequenceId: string, ids: string[], delta: number): ProjectDocument {
    const sequence = project.sequences[sequenceId];
    if (!sequence || !Number.isFinite(delta))
        throw new Error("滑动时间无效。");
    const selected = sequence.tracks.flatMap(track => track.clips.filter(clip => ids.includes(clip.id)));
    let low = -Infinity, high = Infinity;
    for (const clip of selected) {
        low = Math.max(low, -clip.sourceIn / clip.rate);
        const asset = clip.assetId ? project.assets[clip.assetId] : undefined;
        const duration = asset?.duration ?? (clip.sequenceId ? project.sequences[clip.sequenceId]?.duration : undefined);
        if (clip.kind === "audio" && duration != null)
            high = Math.min(high, (duration - clip.sourceIn) / clip.rate - clip.duration);
    }
    const bounded = Math.max(Math.ceil(low * sequence.fps) / sequence.fps, Math.min(Math.floor(high * sequence.fps) / sequence.fps, snapFrame(delta, sequence.fps)));
    return patchClips(project, sequenceId, ids, clip => ({ sourceIn: clip.sourceIn + bounded * clip.rate }));
}
/** Move a cut shared by adjacent clips, preserving the outer interval and source phase. */
export function rollCut(project: ProjectDocument, sequenceId: string, clipId: string, delta: number): ProjectDocument {
    const sequence = project.sequences[sequenceId];
    const track = sequence?.tracks.find(track => track.clips.some(clip => clip.id === clipId));
    if (!sequence || !track || !Number.isFinite(delta))
        throw new Error("切点无效。");
    if (track.locked)
        throw new Error("轨道已锁定。");
    const left = track.clips.find(clip => clip.id === clipId)!;
    const right = track.clips.find(clip => clip.id !== left.id && Math.abs(clip.start - left.start - left.duration) < 1e-6);
    if (!right)
        throw new Error("片段右侧没有相邻片段。");
    let low = Math.max(1 / sequence.fps - left.duration, -right.sourceIn / right.rate);
    let high = right.duration - 1 / sequence.fps;
    const duration = left.assetId ? project.assets[left.assetId]?.duration : undefined;
    if (left.kind === "audio" && duration != null)
        high = Math.min(high, (duration - left.sourceIn) / left.rate - left.duration);
    low = Math.ceil(low * sequence.fps) / sequence.fps;
    high = Math.floor(high * sequence.fps) / sequence.fps;
    if (low > high)
        throw new Error("没有可修剪的素材余量。");
    const amount = Math.max(low, Math.min(high, snapFrame(delta, sequence.fps)));
    const region = (clip: Clip) => clip.fadeRegion ?? { sourceIn: clip.sourceIn, sourceDuration: clip.duration * clip.rate, rate: clip.rate };
    return setSequence(project, { ...sequence, tracks: sequence.tracks.map(item => item.id !== track.id ? item : { ...item, clips: item.clips.map(clip => clip.id === left.id ? { ...clip, duration: clip.duration + amount, fadeRegion: region(clip) } : clip.id === right.id ? { ...clip, start: clip.start + amount, sourceIn: clip.sourceIn + amount * clip.rate, duration: clip.duration - amount, fadeRegion: region(clip) } : clip) }) });
}
export function crossfadeAudio(project: ProjectDocument, sequenceId: string, ids: string[], duration: number): ProjectDocument {
    const sequence = project.sequences[sequenceId];
    const selected = sequence?.tracks.flatMap(track => track.clips.filter(clip => ids.includes(clip.id) && clip.kind === "audio")) ?? [];
    if (selected.length !== 2 || !Number.isFinite(duration) || duration <= 0)
        throw new Error("请选择两个音频片段。");
    const [left, right] = selected.sort((a, b) => a.start - b.start);
    const overlap = left.start + left.duration - right.start;
    if (overlap <= 0 || right.start <= left.start || right.start + right.duration < left.start + left.duration)
        throw new Error("将两个音频首尾叠放在不同轨道后添加交叉淡化。");
    // The entire overlap is the shared fade interval; shorter independent fades create a volume bump.
    const amount = Math.min(overlap, right.duration, left.duration);
    return patchClips(project, sequenceId, ids, clip => ({ ...(clip.id === left.id ? { fadeOut: amount } : { fadeIn: amount }), fadeRegion: { sourceIn: clip.sourceIn, sourceDuration: clip.duration * clip.rate, rate: clip.rate } }));
}
