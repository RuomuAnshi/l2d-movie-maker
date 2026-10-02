import type { Clip, Sequence, Track } from "./types";

export function linkedClipIds(sequence: Sequence, ids: string[]): string[] {
  const groups = new Set(sequence.tracks.flatMap((track) => track.clips.filter((clip) => ids.includes(clip.id)).map((clip) => ({ clip }))).map(({ clip }) => clip.linkGroupId).filter(Boolean));
  return sequence.tracks.flatMap((track) => track.clips.filter((clip) => ids.includes(clip.id) || (clip.linkGroupId && groups.has(clip.linkGroupId))).map((clip) => clip.id));
}

export function cleanClipLinks(tracks: Track[]): Track[] {
  const counts = new Map<string, number>();
  for (const track of tracks) for (const clip of track.clips) if (clip.linkGroupId) counts.set(clip.linkGroupId, (counts.get(clip.linkGroupId) ?? 0) + 1);
  return tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => clip.linkGroupId && counts.get(clip.linkGroupId) === 1 ? { ...clip, linkGroupId: undefined } : clip) }));
}

/** A copied association must never select or move the original clips. */
export function remapClipLinks(clips: Clip[]): Clip[] {
  const counts = new Map<string, number>(), groups = new Map<string, string>();
  for (const clip of clips) if (clip.linkGroupId) counts.set(clip.linkGroupId, (counts.get(clip.linkGroupId) ?? 0) + 1);
  return clips.map((clip) => {
    if (!clip.linkGroupId || counts.get(clip.linkGroupId) === 1) return { ...clip, linkGroupId: undefined };
    if (!groups.has(clip.linkGroupId)) groups.set(clip.linkGroupId, crypto.randomUUID());
    return { ...clip, linkGroupId: groups.get(clip.linkGroupId) };
  });
}
