import { addTrack, insertClip, moveClips, pasteClips, setSequence, trimClip } from "./engine";
import type { Clip, ProjectDocument, Sequence, Track } from "./types";
import { cleanClipLinks, linkedClipIds, remapClipLinks } from "./links";
export { linkedClipIds } from "./links";

export type EditMode = "free" | "insert" | "overwrite";
export type TimeRange = { start: number; end: number };
const EPS = 1e-7;
const endOf = (clip: Clip) => clip.start + clip.duration;
const frameAt = (time: number, fps: number) => Math.round(time * fps) / fps;
const sequenceAt = (project: ProjectDocument, id: string) => {
  const sequence = project.sequences[id];
  if (!sequence) throw new Error("序列不存在。");
  return sequence;
};
const entries = (sequence: Sequence, ids: string[]) => sequence.tracks.flatMap((track) => track.clips.filter((clip) => ids.includes(clip.id)).map((clip) => ({ track, clip })));
const assertUnlocked = (items: Array<{ track: Track }>) => {
  const locked = items.find(({ track }) => track.locked);
  if (locked) throw new Error(`轨道“${locked.track.name}”已锁定，请先解锁。`);
};

export function linkClips(project: ProjectDocument, sequenceId: string, ids: string[]): ProjectDocument {
  const sequence = sequenceAt(project, sequenceId);
  const linked = linkedClipIds(sequence, ids), items = entries(sequence, linked);
  if (items.length < 2) throw new Error("请选择至少两个片段。");
  assertUnlocked(items);
  const linkGroupId = crypto.randomUUID();
  return setSequence(project, { ...sequence, tracks: sequence.tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => linked.includes(clip.id) ? { ...clip, linkGroupId } : clip) })) });
}

export function unlinkClips(project: ProjectDocument, sequenceId: string, ids: string[]): ProjectDocument {
  const sequence = sequenceAt(project, sequenceId), linked = linkedClipIds(sequence, ids);
  assertUnlocked(entries(sequence, linked));
  return setSequence(project, { ...sequence, tracks: sequence.tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => linked.includes(clip.id) ? { ...clip, linkGroupId: undefined } : clip) })) });
}

/** Source keys and fade envelopes remain in their original source coordinates. */
function section(clip: Clip, start: number, end: number, destination: number, keepId: boolean): Clip {
  return {
    ...clip, id: keepId ? clip.id : crypto.randomUUID(), start: destination, duration: end - start,
    sourceIn: clip.sourceIn + (start - clip.start) * clip.rate,
    fadeRegion: clip.fadeRegion ?? { sourceIn: clip.sourceIn, sourceDuration: clip.duration * clip.rate, rate: clip.rate },
  };
}

function insertSpace(project: ProjectDocument, sequenceId: string, at: number, amount: number): ProjectDocument {
  const sequence = sequenceAt(project, sequenceId);
  if (sequence.kind !== "edit") throw new Error("插入和波纹编辑请在主序列或复合序列中使用。");
  assertUnlocked(sequence.tracks.flatMap((track) => track.clips.filter((clip) => endOf(clip) > at + EPS).map(() => ({ track }))));
  const splitGroups = new Set(sequence.tracks.flatMap((track) => track.clips.filter((clip) => clip.start < at - EPS && endOf(clip) > at + EPS).map((clip) => clip.linkGroupId)).filter(Boolean));
  const rightGroups = new Map([...splitGroups].map((group) => [group, crypto.randomUUID()]));
  const rightLink = (clip: Clip) => clip.linkGroupId ? rightGroups.get(clip.linkGroupId) ?? clip.linkGroupId : undefined;
  const tracks = sequence.tracks.map((track) => ({ ...track, clips: track.clips.flatMap((clip) => {
    if (endOf(clip) <= at + EPS) return [clip];
    if (clip.start >= at - EPS) return [{ ...clip, start: clip.start + amount, linkGroupId: rightLink(clip) }];
    return [section(clip, clip.start, at, clip.start, true), { ...section(clip, at, endOf(clip), at + amount, false), linkGroupId: rightLink(clip) }];
  }) }));
  return setSequence(project, { ...sequence, tracks: cleanClipLinks(tracks) });
}

export function editTimelineClip(project: ProjectDocument, sequenceId: string, trackId: string, input: Clip, mode: EditMode = "free") {
  const sequence = sequenceAt(project, sequenceId);
  if (![input.start, input.duration, input.sourceIn, input.rate].every(Number.isFinite) || input.start < 0 || input.duration <= 0 || input.sourceIn < 0 || input.rate <= 0) throw new Error("片段时间或速率无效。");
  const clip = { ...input, start: frameAt(input.start, sequence.fps), duration: Math.max(1 / sequence.fps, frameAt(input.duration, sequence.fps)) };
  const sourceDuration = input.assetId ? project.assets[input.assetId]?.duration : undefined;
  if (clip.kind === "audio" && sourceDuration != null) {
    const available = Math.floor(((sourceDuration - clip.sourceIn) / clip.rate + EPS) * sequence.fps) / sequence.fps;
    if (available < 1 / sequence.fps - EPS) throw new Error("音频剩余长度不足一帧。");
    clip.duration = Math.min(clip.duration, available);
  }
  if (mode === "free") return insertClip(project, sequenceId, trackId, clip);
  // Validate before splitting anything, including source limits and nested cycles.
  insertClip(project, sequenceId, trackId, clip);
  const base = mode === "insert" ? insertSpace(project, sequenceId, clip.start, clip.duration) : project;
  const active = sequenceAt(base, sequenceId), track = active.tracks.find((item) => item.id === trackId)!;
  const clips = track.clips.flatMap((existing) => {
    if (endOf(existing) <= clip.start + EPS || existing.start >= endOf(clip) - EPS) return [existing];
    const result: Clip[] = [];
    if (existing.start < clip.start - EPS) result.push(section(existing, existing.start, clip.start, existing.start, true));
    if (endOf(existing) > endOf(clip) + EPS) result.push(section(existing, endOf(clip), endOf(existing), endOf(clip), !result.length));
    return result;
  });
  const tracks = cleanClipLinks(active.tracks.map((item) => item.id === trackId ? { ...item, clips: [...clips, clip].sort((a, b) => a.start - b.start) } : item));
  return { project: setSequence(base, { ...active, tracks }), trackId, createdTrack: false };
}

export function mergeTimeRanges(ranges: TimeRange[], fps: number): TimeRange[] {
  const ordered = ranges.map(({ start, end }) => {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw new Error("时间范围无效。");
    return { start: frameAt(start, fps), end: frameAt(end, fps) };
  }).filter((range) => range.end - range.start >= 1 / fps - EPS).sort((a, b) => a.start - b.start);
  const merged: TimeRange[] = [];
  for (const range of ordered) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + EPS) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/** Removes sequence time on every track, including crossing media, atomically. */
export function rippleDeleteRanges(project: ProjectDocument, sequenceId: string, input: TimeRange[]): ProjectDocument {
  const sequence = sequenceAt(project, sequenceId);
  if (sequence.kind !== "edit") throw new Error("波纹删除请在主序列或复合序列中使用。");
  const ranges = mergeTimeRanges(input, sequence.fps);
  if (!ranges.length) return project;
  assertUnlocked(sequence.tracks.flatMap((track) => track.clips.filter((clip) => endOf(clip) > ranges[0].start + EPS).map(() => ({ track }))));
  const destinationAt = (time: number) => time - ranges.reduce((total, range) => total + Math.max(0, Math.min(time, range.end) - range.start), 0);
  const tracks = sequence.tracks.map((track) => ({ ...track, clips: track.clips.flatMap((clip) => {
    if (endOf(clip) <= ranges[0].start + EPS) return [clip];
    if (!ranges.some((range) => range.start < endOf(clip) - EPS && range.end > clip.start + EPS)) return [{ ...clip, start: destinationAt(clip.start) }];
    const parts: Clip[] = [];
    let cursor = clip.start;
    for (const range of ranges) {
      if (range.end <= cursor + EPS || range.start >= endOf(clip) - EPS) continue;
      if (range.start > cursor + EPS) parts.push(section(clip, cursor, range.start, destinationAt(cursor), !parts.length));
      cursor = Math.max(cursor, range.end);
      if (cursor >= endOf(clip) - EPS) break;
    }
    if (cursor < endOf(clip) - EPS) parts.push(section(clip, cursor, endOf(clip), destinationAt(cursor), !parts.length));
    return parts;
  }) }));
  return setSequence(project, { ...sequence, tracks: cleanClipLinks(tracks) });
}

export function rippleDeleteClips(project: ProjectDocument, sequenceId: string, ids: string[]): ProjectDocument {
  return rippleDeleteRanges(project, sequenceId, entries(sequenceAt(project, sequenceId), ids).map(({ clip }) => ({ start: clip.start, end: endOf(clip) })));
}

export function linkedTrimDelta(project: ProjectDocument, sequenceId: string, ids: string[], edge: "left" | "right", delta: number): number {
  const sequence = sequenceAt(project, sequenceId), items = entries(sequence, ids);
  if (!Number.isFinite(delta)) throw new Error("裁剪时间无效。");
  if (!items.length) return 0;
  let minimum = -Infinity, maximum = Infinity;
  for (const { clip } of items) {
    if (edge === "left") {
      minimum = Math.max(minimum, -clip.start, -clip.sourceIn / clip.rate);
      maximum = Math.min(maximum, clip.duration - 1 / sequence.fps);
    } else {
      minimum = Math.max(minimum, 1 / sequence.fps - clip.duration);
      const sourceDuration = clip.assetId ? project.assets[clip.assetId]?.duration : undefined;
      if (clip.kind === "audio" && sourceDuration != null) maximum = Math.min(maximum, (sourceDuration - clip.sourceIn) / clip.rate - clip.duration);
    }
  }
  return Math.max(Math.ceil((minimum - EPS) * sequence.fps) / sequence.fps, Math.min(frameAt(delta, sequence.fps), Math.floor((maximum + EPS) * sequence.fps) / sequence.fps));
}

export function trimLinkedClips(project: ProjectDocument, sequenceId: string, ids: string[], edge: "left" | "right", delta: number): ProjectDocument {
  const sequence = sequenceAt(project, sequenceId), items = entries(sequence, ids);
  if (!items.length) return project;
  assertUnlocked(items);
  const nextDelta = linkedTrimDelta(project, sequenceId, ids, edge, delta);
  let result = project;
  for (const { clip } of items) {
    const active = sequenceAt(result, sequenceId), track = active.tracks.find((item) => item.clips.some((candidate) => candidate.id === clip.id))!;
    result = trimClip(result, sequenceId, track.id, clip.id, edge, nextDelta, sequence.fps, clip.assetId ? project.assets[clip.assetId]?.duration : undefined);
  }
  return result;
}

export function splitTimelineClips(project: ProjectDocument, sequenceId: string, ids: string[], time: number): ProjectDocument {
  const sequence = sequenceAt(project, sequenceId), at = frameAt(time, sequence.fps), selected = new Set(ids);
  const items = entries(sequence, ids).filter(({ clip }) => at > clip.start + EPS && at < endOf(clip) - EPS);
  if (!items.length) throw new Error("播放头需要位于所选片段内部。");
  assertUnlocked(entries(sequence, ids));
  const splitGroups = new Set(items.map(({ clip }) => clip.linkGroupId).filter(Boolean));
  const rightGroups = new Map<string, string>();
  for (const group of splitGroups) rightGroups.set(group!, crypto.randomUUID());
  const tracks = sequence.tracks.map((track) => ({ ...track, clips: track.clips.flatMap((clip) => {
    if (!selected.has(clip.id)) return [clip];
    if (clip.start >= at - EPS) return [{ ...clip, linkGroupId: clip.linkGroupId ? rightGroups.get(clip.linkGroupId) ?? clip.linkGroupId : undefined }];
    if (endOf(clip) <= at + EPS) return [clip];
    return [section(clip, clip.start, at, clip.start, true), { ...section(clip, at, endOf(clip), at, false), linkGroupId: clip.linkGroupId ? rightGroups.get(clip.linkGroupId) : undefined }];
  }) }));
  return setSequence(project, { ...sequence, tracks: cleanClipLinks(tracks) });
}

type Placement = { trackOffset: number; timeOffset: number; clip: Clip };
export function pasteTimelineClips(project: ProjectDocument, sequenceId: string, trackId: string, at: number, items: Placement[], mode: EditMode) {
  if (mode === "free") return pasteClips(project, sequenceId, trackId, at, items);
  const sequence = sequenceAt(project, sequenceId), target = sequence.tracks.find((track) => track.id === trackId);
  if (!target || target.locked) throw new Error("目标轨道不可编辑。");
  if (!items.length) return { project, clipIds: [] };
  let result = project;
  const copied = remapClipLinks(items.map((item) => ({ ...structuredClone(item.clip), id: crypto.randomUUID() })));
  const placements = items.map((item, index) => ({ order: target.order + item.trackOffset, clip: { ...copied[index], start: frameAt(at + item.timeOffset, sequence.fps) } }));
  if (placements.some(({ order, clip }) => !Number.isInteger(order) || order < 0 || clip.start < 0)) throw new Error("片段投放位置无效。");
  while (result.sequences[sequenceId].tracks.length <= Math.max(...placements.map((item) => item.order))) result = addTrack(result, sequenceId);
  // Preflight every member before making room or overwriting another clip.
  for (const placement of placements) insertClip(result, sequenceId, result.sequences[sequenceId].tracks.find((track) => track.order === placement.order)!.id, placement.clip);
  if (mode === "insert") {
    const start = Math.min(...placements.map(({ clip }) => clip.start)), end = Math.max(...placements.map(({ clip }) => endOf(clip)));
    result = insertSpace(result, sequenceId, start, end - start);
  }
  for (const placement of placements) {
    // Preserve links until the entire group has been placed.
    const group = placement.clip.linkGroupId;
    result = editTimelineClip(result, sequenceId, result.sequences[sequenceId].tracks.find((track) => track.order === placement.order)!.id, placement.clip, "overwrite").project;
    if (group) result = setSequence(result, { ...result.sequences[sequenceId], tracks: result.sequences[sequenceId].tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => clip.id === placement.clip.id ? { ...clip, linkGroupId: group } : clip) })) });
  }
  // Earlier singleton cleanup may have cleared a just-pasted member.
  const groups = new Map(placements.map(({ clip }) => [clip.id, clip.linkGroupId]));
  result = setSequence(result, { ...result.sequences[sequenceId], tracks: cleanClipLinks(result.sequences[sequenceId].tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => groups.has(clip.id) ? { ...clip, linkGroupId: groups.get(clip.id) } : clip) }))) });
  return { project: result, clipIds: placements.map(({ clip }) => clip.id) };
}

export function moveTimelineClips(project: ProjectDocument, sequenceId: string, ids: string[], referenceId: string, trackId: string, start: number, mode: EditMode): ProjectDocument {
  const sequence = sequenceAt(project, sequenceId);
  if (mode === "free") return moveClips(project, sequenceId, ids, referenceId, trackId, start, sequence.fps);
  const selected = entries(sequence, ids), reference = selected.find(({ clip }) => clip.id === referenceId);
  if (!reference) throw new Error("拖动片段不在选区中。");
  assertUnlocked(selected);
  const earliest = Math.min(...selected.map(({ clip }) => clip.start)), top = Math.min(...selected.map(({ track }) => track.order));
  const destination = sequence.tracks.find((track) => track.id === trackId);
  if (!destination) throw new Error("目标轨道不存在。");
  const offset = Math.max(-earliest, frameAt(start - reference.clip.start, sequence.fps));
  const base = setSequence(project, { ...sequence, tracks: sequence.tracks.map((track) => ({ ...track, clips: track.clips.filter((clip) => !ids.includes(clip.id)) })) });
  const result = pasteTimelineClips(base, sequenceId, sequence.tracks.find((track) => track.order === Math.max(0, top + destination.order - reference.track.order))!.id,
    earliest + offset, selected.map(({ track, clip }) => ({ trackOffset: track.order - top, timeOffset: clip.start - earliest, clip })), mode);
  // Moving keeps stable clip IDs and associations; only pasted copies get fresh IDs.
  const restored = new Map(result.clipIds.map((id, index) => [id, selected[index].clip]));
  return setSequence(result.project, { ...result.project.sequences[sequenceId], tracks: result.project.sequences[sequenceId].tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => restored.has(clip.id) ? { ...clip, id: restored.get(clip.id)!.id, linkGroupId: restored.get(clip.id)!.linkGroupId } : clip) })) });
}
