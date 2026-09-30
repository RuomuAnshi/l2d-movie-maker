import { addTrack, insertClip, setSequence } from "./engine";
import { createClip } from "./types";
import type { ProjectAsset, ProjectDocument } from "./types";

type LegacyAudio = { id: string; name: string; start: number; duration: number; audioPath?: string; audioUrl?: string; audioSourceDuration?: number; sourceIn?: number; playbackRate?: number; gain?: number; fadeIn?: number; fadeOut?: number };
type LegacyText = { id: string; name: string; start: number; duration: number; subtitleText: string; speakerName?: string; fontFamily: string; fontSize: number; textColor: string };
type LegacySyncOptions = { previousAudioIds?: string[]; previousSubtitleIds?: string[] };

/** Bridges the still-supported V1/V2 audio and subtitle controls into V3 root-sequence clips. */
export function syncLegacyMedia(project: ProjectDocument, audio: LegacyAudio[], subtitles: LegacyText[], options: LegacySyncOptions = {}): ProjectDocument {
  let next = project;
  const rootId = project.rootSequenceId;
  const root = next.sequences[rootId];
  if (!root || root.kind !== "edit") return project;
  // Absence from an asynchronous legacy view is not a delete command.
  if (options.previousAudioIds) next = pruneKinds(next, new Set(audio.map((clip) => clip.id)), new Set(options.previousAudioIds), "audio");
  if (options.previousSubtitleIds) next = pruneKinds(next, new Set(subtitles.map((clip) => clip.id)), new Set(options.previousSubtitleIds), "text");
  next = syncItems(next, audio.map((clip) => ({
    id: clip.id, name: clip.name, kind: "audio" as const, start: clip.start, duration: clip.duration,
    sourceIn: clip.sourceIn, rate: clip.playbackRate, volume: clip.gain, fadeIn: clip.fadeIn, fadeOut: clip.fadeOut,
    asset: { id: `asset:audio:${clip.id}`, kind: "audio" as const, name: clip.name, uri: clip.audioPath ?? clip.audioUrl ?? "", duration: clip.audioSourceDuration ?? clip.duration, missing: !(clip.audioPath ?? clip.audioUrl), metadata: { legacyClipId: clip.id } },
  })), "音频");
  next = syncItems(next, subtitles.map((clip) => ({
    id: clip.id, name: clip.name, kind: "text" as const, start: clip.start, duration: clip.duration, text: clip.subtitleText, fontFamily: clip.fontFamily, fontSize: clip.fontSize, textColor: clip.textColor,
    asset: { id: `asset:text:${clip.id}`, kind: "text" as const, name: clip.name, uri: "", metadata: { fontFamily: clip.fontFamily, fontSize: clip.fontSize, color: clip.textColor, speaker: clip.speakerName ?? "", legacyClipId: clip.id } },
  })), "文字");
  return next;
}

function pruneKinds(project: ProjectDocument, keepIds: Set<string>, previousIds: Set<string>, kind: "audio" | "text"): ProjectDocument {
  const sequence = project.sequences[project.rootSequenceId];
  if (!sequence || sequence.kind !== "edit") return project;
  let changed = false;
  const tracks = sequence.tracks.map((track) => {
    const clips = track.clips.filter((clip) => {
      const remove = clip.kind === kind && previousIds.has(clip.id) && !keepIds.has(clip.id) && clip.assetId === `asset:${kind}:${clip.id}`;
      if (remove && track.locked) throw new Error(`轨道“${track.name}”已锁定。`);
      changed ||= remove;
      return !remove;
    });
    return clips.length === track.clips.length ? track : { ...track, clips };
  });
  return changed ? setSequence(project, { ...sequence, tracks }) : project;
}

function syncItems(project: ProjectDocument, items: Array<{ id: string; name: string; kind: "audio" | "text"; start: number; duration: number; text?: string; fontFamily?: string; fontSize?: number; textColor?: string; sourceIn?: number; rate?: number; volume?: number; fadeIn?: number; fadeOut?: number; asset: ProjectAsset }>, laneName: string): ProjectDocument {
  for (const item of items) {
    const sequence = project.sequences[project.rootSequenceId];
    if (!sequence || sequence.kind !== "edit") break;
    const existing = sequence.tracks.flatMap((track) => track.clips.map((clip) => ({ track, clip }))).find(({ clip }) => clip.id === item.id);
    // Native V3 clips own their assets, keys, styling and track placement.
    if (existing && existing.clip.assetId !== item.asset.id) continue;
    const oldAsset = project.assets[item.asset.id];
    const asset = { ...item.asset, metadata: { ...oldAsset?.metadata, ...item.asset.metadata } };
    const assetChanged = !oldAsset || oldAsset.uri !== asset.uri || oldAsset.duration !== asset.duration || oldAsset.name !== asset.name || oldAsset.missing !== asset.missing || JSON.stringify(oldAsset.metadata) !== JSON.stringify(asset.metadata);
    let next = assetChanged ? { ...project, assets: { ...project.assets, [item.asset.id]: { ...oldAsset, ...asset } } } : project;
    if (existing && existing.clip.kind === item.kind && existing.clip.start === item.start && existing.clip.duration === item.duration &&
        existing.clip.sourceIn === (item.sourceIn ?? 0) && existing.clip.rate === (item.rate ?? 1) &&
        existing.clip.volume === (item.volume ?? 1) && existing.clip.fadeIn === (item.fadeIn ?? 0) && existing.clip.fadeOut === (item.fadeOut ?? 0) &&
        (item.kind !== "text" || (existing.clip.text === item.text && existing.clip.fontFamily === item.fontFamily && existing.clip.fontSize === item.fontSize && existing.clip.textColor === item.textColor)) && existing.clip.name === item.name) {
      project = next;
      continue;
    }
    if (existing) {
      if (existing.track.locked) throw new Error(`轨道“${existing.track.name}”已锁定。`);
      const current = next.sequences[project.rootSequenceId];
      if (current?.kind === "edit") next = setSequence(next, { ...current, tracks: current.tracks.map((track) => ({ ...track, clips: track.clips.filter((clip) => clip.id !== item.id) })) });
    }
    let target = existing ? next.sequences[next.rootSequenceId]!.tracks.find((track) => track.id === existing.track.id) : next.sequences[next.rootSequenceId]!.tracks.find((track) => track.name === laneName && !track.locked);
    if (!target) {
      next = addTrack(next, next.rootSequenceId, laneName);
      target = next.sequences[next.rootSequenceId]!.tracks.slice().sort((a, b) => b.order - a.order)[0];
    }
    const clip = createClip({
      ...existing?.clip,
      id: item.id, name: item.name, kind: item.kind, assetId: item.asset.id,
      start: Math.max(0, item.start), duration: Math.max(1 / next.fps, item.duration), text: item.text,
      fontFamily: item.fontFamily, fontSize: item.fontSize, textColor: item.textColor,
      sourceIn: item.sourceIn, rate: item.rate, volume: item.volume, fadeIn: item.fadeIn, fadeOut: item.fadeOut,
      fadeRegion: existing && ((item.fadeIn ?? 0) !== existing.clip.fadeIn || (item.fadeOut ?? 0) !== existing.clip.fadeOut) ? undefined : existing?.clip.fadeRegion,
    });
    project = insertClip(next, next.rootSequenceId, target.id, clip).project;
  }
  return project;
}
