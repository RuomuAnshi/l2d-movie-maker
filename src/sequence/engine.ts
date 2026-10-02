import { createClip, createTrack, DEFAULT_TRANSFORM } from "./types";
import type { Clip, ProjectDocument, ResolvedActor, ResolvedClip, Sequence, Track, Transform } from "./types";
import { targetId, type AnimationDocument } from "../animation/types";

import { cleanClipLinks, remapClipLinks } from "./links";
import { propertyValue, transformProperties } from "./properties";

const EPSILON = 1e-7;
const visual = (clip: Clip) => clip.kind !== "audio";
const endOf = (clip: Clip) => clip.start + clip.duration;
const overlaps = (a: Clip, b: Clip) => a.start < endOf(b) - EPSILON && b.start < endOf(a) - EPSILON;
const clone = <T,>(value: T): T => structuredClone(value);

export function sequenceDuration(sequence: Sequence): number {
  let duration = sequence.kind === "live2d" ? sequence.duration : 0;
  for (const track of sequence.tracks) for (const clip of track.clips) duration = Math.max(duration, endOf(clip));
  if (sequence.kind === "live2d") {
    for (const track of sequence.animation.tracks) for (const key of track.keys) duration = Math.max(duration, key.time);
    for (const group of sequence.animation.groups) duration = Math.max(duration, group.start + group.duration);
  }
  return duration;
}

export function setSequence(project: ProjectDocument, sequence: Sequence): ProjectDocument {
  const duration = sequenceDuration(sequence);
  return { ...project, sequences: { ...project.sequences, [sequence.id]: { ...sequence, duration } } };
}

export function addTrack(project: ProjectDocument, sequenceId: string, name?: string, atOrder?: number): ProjectDocument {
  const sequence = requireSequence(project, sequenceId);
  const order = Math.max(0, Math.min(sequence.tracks.length, atOrder ?? sequence.tracks.length));
  const inserted = createTrack(order, name);
  const tracks = sequence.tracks.map((track) => ({ ...track, order: track.order >= order ? track.order + 1 : track.order }));
  tracks.push(inserted);
  return setSequence(project, { ...sequence, tracks: tracks.sort((a, b) => a.order - b.order) });
}

export function removeEmptyTrack(project: ProjectDocument, sequenceId: string, trackId: string): ProjectDocument {
  const sequence = requireSequence(project, sequenceId);
  const track = requireTrack(sequence, trackId);
  if (track.locked) throw new Error("目标轨道已锁定。");
  if (track.clips.length) throw new Error("只能删除空轨道。");
  const tracks = sequence.tracks.slice().sort((a, b) => a.order - b.order).filter((item) => item.id !== trackId).map((item, order) => ({ ...item, order }));
  return setSequence(project, { ...sequence, tracks });
}

export function patchTrack(project: ProjectDocument, sequenceId: string, trackId: string, patch: Partial<Pick<Track, "name" | "locked" | "hidden" | "muted">>): ProjectDocument {
  const sequence = requireSequence(project, sequenceId);
  return setSequence(project, { ...sequence, tracks: sequence.tracks.map((track) => track.id === trackId ? { ...track, ...patch } : track) });
}

export function reorderTrack(project: ProjectDocument, sequenceId: string, trackId: string, order: number): ProjectDocument {
  const sequence = requireSequence(project, sequenceId);
  const tracks = sequence.tracks.slice().sort((a, b) => a.order - b.order);
  const from = tracks.findIndex((track) => track.id === trackId);
  if (from < 0) throw new Error("轨道不存在。");
  const [track] = tracks.splice(from, 1);
  if (track.locked) throw new Error("目标轨道已锁定。");
  tracks.splice(Math.max(0, Math.min(tracks.length, order)), 0, track);
  return setSequence(project, { ...sequence, tracks: tracks.map((item, index) => ({ ...item, order: index })) });
}

/** Insert without ripple. A collision creates an adjacent track directly above the requested one. */
export function insertClip(project: ProjectDocument, sequenceId: string, trackId: string, clip: Clip): { project: ProjectDocument; trackId: string; createdTrack: boolean } {
  const sequence = requireSequence(project, sequenceId);
  if (![clip.start, clip.duration, clip.sourceIn, clip.rate].every(Number.isFinite) || clip.start < 0 || clip.duration <= 0 || clip.sourceIn < 0 || clip.rate <= 0) throw new Error("片段时间或速率无效。");
  if (sequence.tracks.some((track) => track.clips.some((item) => item.id === clip.id))) throw new Error("片段 ID 已存在。");
  if (clip.sequenceId) assertNoSequenceCycle(project, sequenceId, clip.sequenceId);
  assertAudioSourceRange(project, clip);
  const target = requireTrack(sequence, trackId);
  if (target.locked) throw new Error("目标轨道已锁定。");
  if (!target.clips.some((existing) => overlaps(existing, clip))) {
    const updated = { ...target, clips: [...target.clips, clone(clip)].sort((a, b) => a.start - b.start) };
    return { project: setSequence(project, { ...sequence, tracks: sequence.tracks.map((item) => item.id === trackId ? updated : item) }), trackId, createdTrack: false };
  }

  const next = addTrack(project, sequenceId, undefined, target.order);
  const nextSequence = requireSequence(next, sequenceId);
  const newTrack = nextSequence.tracks.find((item) => item.order === target.order)!;
  const updatedTrack = { ...newTrack, clips: [clone(clip)] };
  return { project: setSequence(next, { ...nextSequence, tracks: nextSequence.tracks.map((item) => item.id === newTrack.id ? updatedTrack : item) }), trackId: newTrack.id, createdTrack: true };
}

export function updateClip(project: ProjectDocument, sequenceId: string, trackId: string, clipId: string, patch: Partial<Clip>, fps = 30): ProjectDocument {
  const sequence = requireSequence(project, sequenceId);
  const track = requireTrack(sequence, trackId);
  if (track.locked) throw new Error("目标轨道已锁定。");
  const original = track.clips.find((item) => item.id === clipId);
  if (!original) throw new Error("片段不存在。");
  const nextClip = { ...original, ...patch };
  if (![nextClip.start, nextClip.duration, nextClip.sourceIn, nextClip.rate, nextClip.volume, nextClip.fadeIn, nextClip.fadeOut].every(Number.isFinite)) throw new Error("片段属性无效。");
  if (nextClip.id !== original.id) throw new Error("不能更改片段 ID。");
  if (nextClip.sequenceId) assertNoSequenceCycle(project, sequenceId, nextClip.sequenceId);
  nextClip.start = snapFrame(Math.max(0, nextClip.start), fps);
  nextClip.duration = snapFrame(Math.max(1 / fps, nextClip.duration), fps);
  nextClip.sourceIn = Math.max(0, nextClip.sourceIn);
  if (nextClip.rate <= 0) throw new Error("速率必须大于 0。");
  nextClip.volume = Math.max(0, nextClip.volume);
  nextClip.fadeIn = Math.max(0, nextClip.fadeIn);
  nextClip.fadeOut = Math.max(0, nextClip.fadeOut);
  if ((patch.fadeIn != null && patch.fadeIn !== original.fadeIn) || (patch.fadeOut != null && patch.fadeOut !== original.fadeOut)) nextClip.fadeRegion = undefined;
  assertAudioSourceRange(project, nextClip);
  const collision = track.clips.some((item) => item.id !== clipId && overlaps(item, nextClip));
  if (collision) throw new Error("同一轨道的片段不能重叠。");
  const clips = track.clips.map((item) => item.id === clipId ? nextClip : item).sort((a, b) => a.start - b.start);
  return setSequence(project, { ...sequence, tracks: sequence.tracks.map((item) => item.id === trackId ? { ...item, clips } : item) });
}

export function moveClip(project: ProjectDocument, sequenceId: string, fromTrackId: string, clipId: string, toTrackId: string, start: number, fps = 30): { project: ProjectDocument; trackId: string; createdTrack: boolean } {
  const sequence = requireSequence(project, sequenceId);
  const from = requireTrack(sequence, fromTrackId);
  const clip = from.clips.find((item) => item.id === clipId);
  if (!clip) throw new Error("片段不存在。");
  if (from.locked) throw new Error("源轨道已锁定。");
  const destination = requireTrack(sequence, toTrackId);
  if (destination.locked) throw new Error("目标轨道已锁定。");
  const detached = setSequence(project, { ...sequence, tracks: sequence.tracks.map((track) => track.id === fromTrackId ? { ...track, clips: track.clips.filter((item) => item.id !== clipId) } : track) });
  const moved = { ...clip, start: snapFrame(Math.max(0, start), fps) };
  return insertClip(detached, sequenceId, toTrackId, moved);
}

export function moveClips(project: ProjectDocument, sequenceId: string, clipIds: string[], referenceClipId: string, toTrackId: string, start: number, fps = 30): ProjectDocument {
  const sequence = requireSequence(project, sequenceId);
  const selected = sequence.tracks.flatMap((track) => track.clips.filter((clip) => clipIds.includes(clip.id)).map((clip) => ({ track, clip })));
  const reference = selected.find((item) => item.clip.id === referenceClipId);
  if (!reference) throw new Error("拖动片段不在选区中。");
  if (selected.some(({ track }) => track.locked)) throw new Error("选区中包含已锁定轨道上的片段。");
  const destination = requireTrack(sequence, toTrackId);
  if (destination.locked) throw new Error("目标轨道已锁定。");
  const earliest = Math.min(...selected.map(({ clip }) => clip.start));
  const top = Math.min(...selected.map(({ track }) => track.order));
  const timeDelta = Math.max(-earliest, snapFrame(start - reference.clip.start, fps));
  const laneDelta = Math.max(-top, destination.order - reference.track.order);
  const detached = setSequence(project, { ...sequence, tracks: sequence.tracks.map((track) => ({ ...track, clips: track.clips.filter((clip) => !clipIds.includes(clip.id)) })) });
  return placeClipGroup(detached, sequenceId, selected.map(({ track, clip }) => ({ order: track.order + laneDelta, clip: { ...clip, start: clip.start + timeDelta } })));
}

export function trimClip(project: ProjectDocument, sequenceId: string, trackId: string, clipId: string, edge: "left" | "right", delta: number, fps = 30, sourceDuration?: number): ProjectDocument {
  const sequence = requireSequence(project, sequenceId);
  const track = requireTrack(sequence, trackId);
  if (track.locked) throw new Error("目标轨道已锁定。");
  const clip = track.clips.find((item) => item.id === clipId);
  if (!clip) throw new Error("片段不存在。");
  const frameDelta = snapFrame(delta, fps);
  const minDuration = 1 / fps;
  let next: Clip;
  if (edge === "left") {
    const shift = Math.max(-clip.start, -clip.sourceIn / clip.rate, Math.min(frameDelta, clip.duration - minDuration));
    const start = Math.max(0, clip.start + shift);
    const actualShift = start - clip.start;
    next = { ...clip, start, duration: clip.duration - actualShift, sourceIn: clip.sourceIn + actualShift * clip.rate };
  } else {
    let duration = Math.max(minDuration, clip.duration + frameDelta);
    if (sourceDuration != null && clip.kind === "audio") {
      const available = (sourceDuration - clip.sourceIn) / clip.rate;
      if (available < minDuration - EPSILON) throw new Error("音频入点已超出素材范围。");
      duration = Math.min(duration, Math.floor((available + EPSILON) * fps) / fps);
    }
    next = { ...clip, duration };
  }
  next.fadeRegion = clip.fadeRegion ?? { sourceIn: clip.sourceIn, sourceDuration: clip.duration * clip.rate, rate: clip.rate };
  const collision = track.clips.some((item) => item.id !== clipId && overlaps(item, next));
  if (!collision) return updateClip(project, sequenceId, trackId, clipId, next, fps);
  const detached = setSequence(project, { ...sequence, tracks: sequence.tracks.map((item) => item.id === trackId ? { ...item, clips: item.clips.filter((clip) => clip.id !== clipId) } : item) });
  return insertClip(detached, sequenceId, trackId, next).project;
}

export function splitClip(project: ProjectDocument, sequenceId: string, trackId: string, clipId: string, at: number, fps = 30): ProjectDocument {
  const sequence = requireSequence(project, sequenceId);
  const track = requireTrack(sequence, trackId);
  if (track.locked) throw new Error("目标轨道已锁定。");
  const clip = track.clips.find((item) => item.id === clipId);
  if (!clip) throw new Error("片段不存在。");
  const cut = snapFrame(at, fps);
  const local = cut - clip.start;
  if (local < 1 / fps || local > clip.duration - 1 / fps) throw new Error("分割点必须位于片段内部。");
  const fadeRegion = clip.fadeRegion ?? { sourceIn: clip.sourceIn, sourceDuration: clip.duration * clip.rate, rate: clip.rate };
  const left = { ...clip, fadeRegion, duration: local };
  const right = { ...clone(clip), fadeRegion, id: crypto.randomUUID(), start: cut, duration: clip.duration - local, sourceIn: clip.sourceIn + local * clip.rate, name: `${clip.name}（2）` };
  return setSequence(project, { ...sequence, tracks: sequence.tracks.map((item) => item.id === trackId ? { ...item, clips: item.clips.flatMap((c) => c.id === clipId ? [left, right] : [c]).sort((a, b) => a.start - b.start) } : item) });
}

/** Keeps source in/out fixed and changes only playback rate and visible duration. */
export function changeClipRate(project: ProjectDocument, sequenceId: string, trackId: string, clipId: string, rate: number, fps = 30): ProjectDocument {
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("速率必须大于 0。");
  const sequence = requireSequence(project, sequenceId);
  const track = requireTrack(sequence, trackId);
  if (track.locked) throw new Error("目标轨道已锁定。");
  const clip = track.clips.find((item) => item.id === clipId);
  if (!clip) throw new Error("片段不存在。");
  const sourceSpan = clip.duration * clip.rate;
  const duration = Math.max(1 / fps, snapFrame(sourceSpan / rate, fps));
  const updated = { ...clip, rate: sourceSpan / duration, duration, fadeRegion: clip.fadeRegion ?? { sourceIn: clip.sourceIn, sourceDuration: sourceSpan, rate: clip.rate } };
  const collision = requireTrack(sequence, trackId).clips.some((item) => item.id !== clipId && overlaps(item, updated));
  if (!collision) return updateClip(project, sequenceId, trackId, clipId, updated, fps);
  const detached = setSequence(project, { ...sequence, tracks: sequence.tracks.map((track) => track.id === trackId ? { ...track, clips: track.clips.filter((item) => item.id !== clipId) } : track) });
  return insertClip(detached, sequenceId, trackId, updated).project;
}

export function deleteClips(project: ProjectDocument, sequenceId: string, clipIds: string[]): ProjectDocument {
  const sequence = requireSequence(project, sequenceId);
  const ids = new Set(clipIds);
  for (const track of sequence.tracks) if (track.locked && track.clips.some((clip) => ids.has(clip.id))) throw new Error(`轨道“${track.name}”已锁定。`);
  return setSequence(project, { ...sequence, tracks: cleanClipLinks(sequence.tracks.map((track) => ({ ...track, clips: track.clips.filter((clip) => !ids.has(clip.id)) }))) });
}

export function duplicateClips(project: ProjectDocument, sequenceId: string, clipIds: string[], timeOffset: number, fps = 30): ProjectDocument {
  const sequence = requireSequence(project, sequenceId);
  const selected = sequence.tracks.flatMap((track) => track.clips.filter((clip) => clipIds.includes(clip.id)).map((clip) => ({ track, clip })));
  if (!selected.length) return project;
  const offset = Math.max(-Math.min(...selected.map(({ clip }) => clip.start)), snapFrame(timeOffset, fps));
  const copied = remapClipLinks(selected.map(({ clip }) => clone(clip)));
  return placeClipGroup(project, sequenceId, selected.map(({ track, clip }, index) => ({ order: track.order, clip: { ...copied[index], id: crypto.randomUUID(), start: clip.start + offset, name: `${clip.name} 副本` } })));
}

export function pasteClips(project: ProjectDocument, sequenceId: string, targetTrackId: string, targetTime: number, items: Array<{ trackOffset: number; timeOffset: number; clip: Clip }>, fps = 30): { project: ProjectDocument; clipIds: string[] } {
  if (!items.length) return { project, clipIds: [] };
  const sequence = requireSequence(project, sequenceId);
  const target = requireTrack(sequence, targetTrackId);
  if (target.locked) throw new Error("目标轨道已锁定。");
  const clipIds: string[] = [];
  const timeOrigin = Math.max(-Math.min(...items.map((item) => item.timeOffset)), snapFrame(targetTime, fps));
  const laneOrigin = Math.max(-Math.min(...items.map((item) => item.trackOffset)), target.order);
  const copied = remapClipLinks(items.map((item) => clone(item.clip)));
  const placements = items.map((item, index) => {
    if (!Number.isInteger(item.trackOffset) || !Number.isFinite(item.timeOffset)) throw new Error("复制的片段位置无效。");
    const id = crypto.randomUUID();
    clipIds.push(id);
    return { order: laneOrigin + item.trackOffset, clip: { ...copied[index], id, start: timeOrigin + item.timeOffset, name: `${item.clip.name} 副本` } };
  });
  return { project: placeClipGroup(project, sequenceId, placements), clipIds };
}

/** A group uses one common lane/time offset; collisions relocate the whole lane block. */
function placeClipGroup(project: ProjectDocument, sequenceId: string, placements: Array<{ order: number; clip: Clip }>): ProjectDocument {
  if (!placements.length) return project;
  const top = Math.min(...placements.map((item) => item.order));
  const bottom = Math.max(...placements.map((item) => item.order));
  let next = project;
  while (requireSequence(next, sequenceId).tracks.length <= bottom) next = addTrack(next, sequenceId);
  let tracks = requireSequence(next, sequenceId).tracks.slice().sort((a, b) => a.order - b.order);
  if (placements.some(({ order }) => tracks[order].locked)) throw new Error("目标轨道已锁定。");
  const collision = placements.some(({ order, clip }) => tracks[order].clips.some((existing) => overlaps(existing, clip)));
  if (collision) {
    for (let index = top; index <= bottom; index++) next = addTrack(next, sequenceId, undefined, index);
    tracks = requireSequence(next, sequenceId).tracks.slice().sort((a, b) => a.order - b.order);
  }
  for (const { order, clip } of placements.slice().sort((a, b) => a.order - b.order || a.clip.start - b.clip.start)) {
    next = insertClip(next, sequenceId, tracks[order].id, clip).project;
  }
  return next;
}

/** Deep-copies a clip's nested sequence tree while continuing to share immutable media assets. */
export function createIndependentClip(project: ProjectDocument, sequenceId: string, trackId: string, clipId: string): { project: ProjectDocument; clipId: string; trackId: string } {
  const parent = requireSequence(project, sequenceId);
  const sourceTrack = requireTrack(parent, trackId);
  if (sourceTrack.locked) throw new Error("目标轨道已锁定。");
  const sourceClip = sourceTrack.clips.find((item) => item.id === clipId);
  if (!sourceClip?.sequenceId) throw new Error("只有 Live2D 或复合片段可以建立独立副本。");
  const copies: Record<string, Sequence> = {};
  const copiedActorIds: Record<string, string> = {};
  const copiedIds = new Map<string, string>();
  const visiting = new Set<string>();
  const cloneSequence = (id: string): string => {
    if (visiting.has(id)) throw new Error("不能复制循环嵌套序列。");
    const existing = copiedIds.get(id);
    if (existing) return existing;
    const source = project.sequences[id];
    if (!source) throw new Error(`缺少嵌套序列：${id}`);
    const newId = crypto.randomUUID();
    copiedIds.set(id, newId);
    visiting.add(id);
    const tracks = source.tracks.map((track) => ({
      ...clone(track), id: crypto.randomUUID(),
      clips: track.clips.map((clip) => {
        const nestedId = clip.sequenceId ? cloneSequence(clip.sequenceId) : undefined;
        return { ...clone(clip), id: crypto.randomUUID(), sequenceId: nestedId };
      }),
    }));
    if (source.kind === "live2d") {
      const actorMap = Object.fromEntries(source.actors.map((actor) => [actor.id, crypto.randomUUID()]));
      Object.assign(copiedActorIds, actorMap);
      // A migrated actor still uses its old character ID until its model is loaded.
      if (source.actors.length === 1) for (const track of source.animation.tracks) actorMap[track.definition.characterId] = actorMap[source.actors[0].id];
      copies[newId] = { ...clone(source), id: newId, actors: source.actors.map((actor) => ({ ...clone(actor), id: actorMap[actor.id] })), animation: remapAnimationCharacters(source.animation, actorMap), tracks };
    } else copies[newId] = { ...clone(source), id: newId, tracks };
    visiting.delete(id);
    return newId;
  };
  const newSequenceId = cloneSequence(sourceClip.sequenceId);
  for (const sequence of Object.values(copies)) for (const track of sequence.tracks) for (const clip of track.clips) {
    if (clip.lipSyncActorId && copiedActorIds[clip.lipSyncActorId]) clip.lipSyncActorId = copiedActorIds[clip.lipSyncActorId];
  }
  const newClip = { ...clone(sourceClip), linkGroupId: undefined, id: crypto.randomUUID(), name: `${sourceClip.name} 独立副本`, sequenceId: newSequenceId, start: endOf(sourceClip) };
  const base = { ...project, sequences: { ...project.sequences, ...copies } };
  const inserted = insertClip(base, sequenceId, trackId, newClip);
  return { project: inserted.project, clipId: newClip.id, trackId: inserted.trackId };
}

export function createCompound(project: ProjectDocument, sequenceId: string, clipIds: string[], name = "复合片段"): { project: ProjectDocument; sequenceId: string; clipId: string; trackId: string } {
  const parent = requireSequence(project, sequenceId);
  if (parent.kind !== "edit") throw new Error("只能在剪辑序列中创建复合片段。");
  const selected = parent.tracks.flatMap((track) => track.clips.filter((clip) => clipIds.includes(clip.id)).map((clip) => ({ track, clip })));
  if (!selected.length) throw new Error("请先选择要组合的片段。");
  if (selected.some(({ track }) => track.locked)) throw new Error("选区中包含已锁定轨道上的片段。");
  const selectedIds = new Set(selected.map(({ clip }) => clip.id));
  const start = Math.min(...selected.map(({ clip }) => clip.start));
  const end = Math.max(...selected.map(({ clip }) => endOf(clip)));
  const orderById = new Map(parent.tracks.map((track) => [track.id, track.order]));
  const visualOrders = selected.filter(({ clip }) => visual(clip)).map(({ track }) => orderById.get(track.id)!);
  if (visualOrders.length > 1) {
    const low = Math.min(...visualOrders), high = Math.max(...visualOrders);
    const blocking = parent.tracks.filter((track) => track.order > low && track.order < high).flatMap((track) => track.clips.filter((clip) => visual(clip) && !selectedIds.has(clip.id) && selected.some((item) => visual(item.clip) && item.track.order > track.order && overlaps(item.clip, clip))).map((clip) => clip.name));
    if (blocking.length) throw new Error(`所选画面层之间有未选片段重叠：${blocking.join("、")}。请一并加入选区。`);
  }

  const childId = crypto.randomUUID();
  const childTracks: Track[] = cleanClipLinks(parent.tracks.slice().sort((a, b) => a.order - b.order).filter((track) => selected.some((item) => item.track.id === track.id)).map((track, order) => ({
    ...clone(track), id: crypto.randomUUID(), order, clips: track.clips.filter((clip) => selectedIds.has(clip.id)).map((clip) => ({ ...clone(clip), id: crypto.randomUUID(), start: clip.start - start })),
  })));
  const child: Sequence = { id: childId, name, kind: "edit", duration: end - start, width: parent.width, height: parent.height, fps: parent.fps, tracks: childTracks };
  const baseTrack = (selected.filter(({ clip }) => visual(clip)).length ? selected.filter(({ clip }) => visual(clip)) : selected).slice().sort((a, b) => a.track.order - b.track.order)[0].track;
  const comp = createClip({ kind: "sequence", sequenceId: childId, name, start, duration: end - start });
  let base = setSequence(project, { ...parent, tracks: cleanClipLinks(parent.tracks.map((track) => ({ ...track, clips: track.clips.filter((clip) => !selectedIds.has(clip.id)) }))) });
  base = { ...base, sequences: { ...base.sequences, [childId]: child } };
  let parentTrackId = baseTrack.id;
  if (baseTrack.hidden || baseTrack.muted) {
    base = addTrack(base, sequenceId, name, baseTrack.order);
    parentTrackId = requireSequence(base, sequenceId).tracks.find((track) => track.order === baseTrack.order)!.id;
  }
  const inserted = insertClip(base, sequenceId, parentTrackId, comp);
  return { project: inserted.project, sequenceId: childId, clipId: comp.id, trackId: inserted.trackId };
}

export function assertNoSequenceCycle(project: ProjectDocument, parentId: string, childId: string): void {
  if (parentId === childId) throw new Error("序列不能引用自身。");
  if (!project.sequences[childId]) throw new Error(`序列不存在：${childId}`);
  const visit = (current: string, path: Set<string>): boolean => {
    if (current === parentId) return true;
    if (path.has(current)) throw new Error("子序列包含循环引用。");
    path.add(current);
    const sequence = project.sequences[current];
    if (!sequence) return false;
    return sequence.tracks.some((track) => track.clips.some((clip) => clip.sequenceId && visit(clip.sequenceId, new Set(path))));
  };
  if (visit(childId, new Set())) throw new Error("不能创建循环嵌套序列。");
}

export function resolveSequenceAt(project: ProjectDocument, sequenceId: string, time: number): ResolvedClip[] {
  const result: ResolvedClip[] = [];
  const walk = (id: string, localTime: number, path: string[], layerOrder: number[], inheritedTransform: Transform, inheritedMuted: boolean, inheritedVisible: boolean, inheritedVolume: number, ancestors: Set<string>) => {
    if (ancestors.has(id)) throw new Error("不能求值循环嵌套序列。");
    const sequence = project.sequences[id];
    if (!sequence) return;
    const nextAncestors = new Set(ancestors).add(id);
    for (const track of sequence.tracks.slice().sort((a, b) => a.order - b.order)) {
      if (localTime < 0) continue;
      for (const clip of track.clips) {
        const end = endOf(clip);
        if (localTime < clip.start || localTime >= end) continue;
        const sourceTime = clip.sourceIn + (localTime - clip.start) * clip.rate;
        const transform = composeTransform(inheritedTransform, evaluateClipTransform(clip, sourceTime));
        const volume = inheritedVolume * clipVolumeAt(clip, sourceTime);
        if (clip.sequenceId) {
          walk(clip.sequenceId, sourceTime, [...path, clip.id], [...layerOrder, track.order], transform, inheritedMuted || track.muted, inheritedVisible && !track.hidden, volume, nextAncestors);
        } else {
          result.push({ clip, sequence, track, sequencePath: path, layerOrder: [...layerOrder, track.order], projectTime: localTime, sourceTime, visible: inheritedVisible && !track.hidden, muted: inheritedMuted || track.muted, transform, volume });
        }
      }
    }
  };
  walk(sequenceId, time, [sequenceId], [], { ...DEFAULT_TRANSFORM }, false, true, 1, new Set());
  return result.sort((a, b) => compareLayerOrder(a.layerOrder, b.layerOrder));
}

export function resolveLive2DActorsAt(project: ProjectDocument, sequenceId: string, time: number): ResolvedActor[] {
  const result: ResolvedActor[] = [];
  const walk = (id: string, localTime: number, path: string[], layerOrder: number[], transform: Transform, visible: boolean, ancestors: Set<string>) => {
    if (ancestors.has(id)) throw new Error("不能求值循环嵌套序列。");
    const sequence = project.sequences[id];
    if (!sequence) return;
    const nextAncestors = new Set(ancestors).add(id);
    if (sequence.kind === "live2d") {
      for (const [index, actor] of sequence.actors.entries()) result.push({ actor, sequence, sequencePath: path, layerOrder: [...layerOrder, sequence.tracks.length, -index], sourceTime: localTime, visible: visible && actor.visible, transform: composeTransform(transform, actor.transform) });
    }
    for (const track of sequence.tracks.slice().sort((a, b) => a.order - b.order)) {
      for (const clip of track.clips) {
        if (localTime < clip.start || localTime >= endOf(clip) || !clip.sequenceId) continue;
        const sourceTime = clip.sourceIn + (localTime - clip.start) * clip.rate;
        walk(clip.sequenceId, sourceTime, [...path, clip.id], [...layerOrder, track.order], composeTransform(transform, evaluateClipTransform(clip, sourceTime)), visible && !track.hidden, nextAncestors);
      }
    }
  };
  walk(sequenceId, time, [sequenceId], [], { ...DEFAULT_TRANSFORM }, true, new Set());
  return result.sort((a, b) => compareLayerOrder(a.layerOrder, b.layerOrder));
}

/** order 0 is the top track. This comparator returns draw order, bottom to top. */
export function compareLayerOrder(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (b[index] ?? Number.MAX_SAFE_INTEGER) - (a[index] ?? Number.MAX_SAFE_INTEGER);
    if (delta) return delta;
  }
  return 0;
}

export function snapFrame(time: number, fps: number): number {
  const safeFps = Number.isFinite(fps) ? Math.max(1, fps) : 30;
  return Math.round(time * safeFps) / safeFps;
}

export class ProjectHistory {
  private past: ProjectDocument[] = [];
  private future: ProjectDocument[] = [];
  private current: ProjectDocument;
  private readonly limit: number;
  constructor(current: ProjectDocument, limit = 100) { this.current = current; this.limit = limit; }
  get value() { return this.current; }
  execute(command: (project: ProjectDocument) => ProjectDocument) {
    const next = command(this.current);
    if (next === this.current) return next;
    this.past.push(this.current);
    if (this.past.length > this.limit) this.past.shift();
    this.current = next;
    this.future = [];
    return next;
  }
  undo() {
    const previous = this.past.pop();
    if (previous) { this.future.push(this.current); this.current = previous; }
    return this.current;
  }
  redo() {
    const next = this.future.pop();
    if (next) { this.past.push(this.current); this.current = next; }
    return this.current;
  }
  replaceCurrent(project: ProjectDocument) { this.current = project; return this.current; }
  reset(project: ProjectDocument) { this.current = project; this.past = []; this.future = []; }
}

export function composeTransform(parent: Transform, child: Transform): Transform {
  const radians = parent.rotation * Math.PI / 180;
  const cosine = Math.cos(radians), sine = Math.sin(radians);
  const offsetX = child.x * parent.scaleX, offsetY = child.y * parent.scaleY;
  return {
    x: parent.x + offsetX * cosine - offsetY * sine,
    y: parent.y + offsetX * sine + offsetY * cosine,
    scaleX: parent.scaleX * child.scaleX,
    scaleY: parent.scaleY * child.scaleY,
    rotation: parent.rotation + child.rotation,
    opacity: parent.opacity * child.opacity,
  };
}

/** Clip property keys use source time, so trim and rate edits do not move the curve. */
export function evaluateClipTransform(clip: Clip, sourceTime: number): Transform {
  const legacy = evaluateLegacyTransform(clip, sourceTime);
  return Object.fromEntries(transformProperties.map(name => [name, propertyValue(clip, name, sourceTime, legacy[name])])) as Transform;
}
function evaluateLegacyTransform(clip: Clip, sourceTime: number): Transform {
  const keys = clip.transformKeys.slice().sort((a, b) => a.time - b.time);
  if (!keys.length || sourceTime < keys[0].time) return { ...clip.transform };
  const rightIndex = keys.findIndex((key) => key.time > sourceTime);
  if (rightIndex < 0) return { ...keys[keys.length - 1] };
  const left = keys[rightIndex - 1], right = keys[rightIndex];
  const amount = (sourceTime - left.time) / (right.time - left.time);
  const mix = (name: keyof Transform) => left[name] + (right[name] - left[name]) * amount;
  return { x: mix("x"), y: mix("y"), scaleX: mix("scaleX"), scaleY: mix("scaleY"), rotation: mix("rotation"), opacity: mix("opacity") };
}

export function clipVolumeAt(clip: Clip, sourceTime: number): number {
  return propertyValue(clip, "volume", sourceTime, Math.max(0, sampleVolumeKeys(clip.volume, clip.volumeKeys, sourceTime)));
}

export function sampleVolumeKeys(base: number, keys: Array<{ time: number; value: number }>, time: number): number {
  const sorted = keys.slice().sort((a, b) => a.time - b.time);
  if (!sorted.length || time < sorted[0].time) return base;
  const rightIndex = sorted.findIndex((key) => key.time > time);
  if (rightIndex < 0) return sorted[sorted.length - 1].value;
  const left = sorted[rightIndex - 1], right = sorted[rightIndex];
  return left.value + (right.value - left.value) * (time - left.time) / (right.time - left.time);
}

/** Re-key every parameter definition and material curve when an actor receives a new ID. */
export function remapAnimationCharacters(document: AnimationDocument, characterIds: Record<string, string>): AnimationDocument {
  const targets = new Map<string, string>();
  const tracks = document.tracks.map((track) => {
    const characterId = characterIds[track.definition.characterId] ?? track.definition.characterId;
    const target = targetId(characterId, track.definition.partId, track.definition.parameterId);
    targets.set(track.definition.target, target);
    return { ...clone(track), definition: { ...track.definition, characterId, target } };
  });
  const remapCurves = (curves: AnimationDocument["groups"][number]["curves"]) => Object.fromEntries(Object.entries(curves).map(([target, keys]) => [targets.get(target) ?? target, clone(keys)]));
  return { ...clone(document), tracks, groups: document.groups.map((group) => ({ ...clone(group), targetMask:group.targetMask?.map(target=>targets.get(target)??target), curves: remapCurves(group.curves), originalCurves: group.originalCurves ? remapCurves(group.originalCurves) : undefined })) };
}

function requireSequence(project: ProjectDocument, id: string): Sequence {
  const sequence = project.sequences[id];
  if (!sequence) throw new Error(`序列不存在：${id}`);
  return sequence;
}
function assertAudioSourceRange(project: ProjectDocument, clip: Clip): void {
  if (clip.kind !== "audio" || !clip.assetId || project.assets[clip.assetId]?.missing) return;
  const duration = project.assets[clip.assetId]?.duration;
  if (duration == null) return;
  if (clip.sourceIn >= duration - EPSILON) throw new Error("音频入点已超出素材范围。");
  if (clip.sourceIn + clip.duration * clip.rate > duration + EPSILON) throw new Error("音频片段不能超出素材实际时长。");
}
function requireTrack(sequence: Sequence, id: string): Track {
  const track = sequence.tracks.find((item) => item.id === id);
  if (!track) throw new Error(`轨道不存在：${id}`);
  return track;
}
