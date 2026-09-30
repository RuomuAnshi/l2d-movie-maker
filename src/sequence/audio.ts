import { sampleVolumeKeys } from "./engine";
import type { Clip, ProjectDocument } from "./types";

/** Times are output seconds relative to the flattened audio item's start. */
export type AudioGainEnvelope = {
  gain: number;
  keys: Array<{ time: number; value: number }>;
  fadeInStart: number;
  fadeInDuration: number;
  fadeOutStart: number;
  fadeOutDuration: number;
};

export type ScheduledAudio = {
  id: string;
  clipId: string;
  assetId: string;
  start: number;
  duration: number;
  sourceIn: number;
  rate: number;
  gain: number;
  fadeIn: number;
  fadeOut: number;
  muted: boolean;
  gainEnvelopes?: AudioGainEnvelope[];
  lipSyncActorId?: string;
  sequencePath?: string[];
};

/** Flatten nesting and clipping while keeping every envelope in its original phase. */
export function resolveAudioSchedule(project: ProjectDocument, sequenceId = project.rootSequenceId): ScheduledAudio[] {
  const result: ScheduledAudio[] = [];
  const envelopeFor = (clip: Clip, localOffset: number, localRate: number): AudioGainEnvelope => {
    const sourceRate = localRate * clip.rate;
    const atSource = (sourceTime: number) => ((sourceTime - clip.sourceIn) / clip.rate + clip.start - localOffset) / localRate;
    const region = clip.fadeRegion ?? { sourceIn: clip.sourceIn, sourceDuration: clip.duration * clip.rate, rate: clip.rate };
    const fadeInStart = atSource(region.sourceIn);
    const fadeOutEnd = atSource(region.sourceIn + region.sourceDuration);
    const fadeInDuration = clip.fadeIn * region.rate / sourceRate;
    const fadeOutDuration = clip.fadeOut * region.rate / sourceRate;
    return {
      gain: clip.volume,
      keys: clip.volumeKeys.map((key) => ({ time: atSource(key.time), value: key.value })),
      fadeInStart, fadeInDuration,
      fadeOutStart: fadeOutEnd - fadeOutDuration, fadeOutDuration,
    };
  };
  const walk = (
    id: string,
    localOffset: number,
    localRate: number,
    rootStart: number,
    rootEnd: number,
    path: string[],
    inheritedMuted: boolean,
    envelopes: AudioGainEnvelope[],
    ancestors: Set<string>,
  ) => {
    if (ancestors.has(id)) throw new Error("不能解析循环嵌套序列的音频。");
    const sequence = project.sequences[id];
    if (!sequence) return;
    const nextAncestors = new Set(ancestors).add(id);
    for (const track of sequence.tracks) {
      for (const clip of track.clips) {
        const clipRootStart = Math.max(rootStart, (clip.start - localOffset) / localRate);
        const clipRootEnd = Math.min(rootEnd, (clip.start + clip.duration - localOffset) / localRate);
        if (clipRootEnd <= clipRootStart) continue;
        const muted = inheritedMuted || track.muted;
        const clipEnvelopes = [...envelopes, envelopeFor(clip, localOffset, localRate)];
        if (clip.sequenceId) {
          const childOffset = clip.sourceIn + (localOffset - clip.start) * clip.rate;
          walk(clip.sequenceId, childOffset, localRate * clip.rate, clipRootStart, clipRootEnd, [...path, clip.id], muted, clipEnvelopes, nextAncestors);
          continue;
        }
        if (clip.kind !== "audio" || !clip.assetId) continue;
        const rate = localRate * clip.rate;
        const sourceIn = clip.sourceIn + (localOffset + clipRootStart * localRate - clip.start) * clip.rate;
        const sourceDuration = project.assets[clip.assetId]?.duration;
        const availableDuration = sourceDuration == null ? Infinity : Math.max(0, (sourceDuration - sourceIn) / rate);
        const duration = Math.min(clipRootEnd - clipRootStart, availableDuration);
        if (duration <= 0) continue;
        result.push({
          id: path.length === 1 ? clip.id : [...path, clip.id].join("/"), clipId: clip.id, assetId: clip.assetId,
          start: clipRootStart, duration, sourceIn, rate, gain: clip.volume,
          fadeIn: clip.fadeIn / localRate, fadeOut: clip.fadeOut / localRate, muted,
          lipSyncActorId: clip.lipSyncActorId, sequencePath: [...path],
          gainEnvelopes: clipEnvelopes.map((envelope) => ({
            ...envelope,
            keys: envelope.keys.map((key) => ({ ...key, time: key.time - clipRootStart })),
            fadeInStart: envelope.fadeInStart - clipRootStart,
            fadeOutStart: envelope.fadeOutStart - clipRootStart,
          })),
        });
      }
    }
  };
  walk(sequenceId, 0, 1, 0, Infinity, [sequenceId], false, [], new Set());
  return result.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

export function envelopeGainAt(envelope: AudioGainEnvelope, elapsed: number): number {
  let gain = sampleVolumeKeys(envelope.gain, envelope.keys, elapsed);
  if (envelope.fadeInDuration > 0) gain *= clamp((elapsed - envelope.fadeInStart) / envelope.fadeInDuration);
  if (envelope.fadeOutDuration > 0) gain *= clamp(1 - (elapsed - envelope.fadeOutStart) / envelope.fadeOutDuration);
  return Math.max(0, gain);
}

export function audioGainAt(track: Pick<ScheduledAudio, "gain" | "fadeIn" | "fadeOut" | "duration" | "gainEnvelopes">, elapsed: number): number {
  if (elapsed < 0 || elapsed > track.duration) return 0;
  if (track.gainEnvelopes?.length) return track.gainEnvelopes.reduce((gain, envelope) => gain * envelopeGainAt(envelope, elapsed), 1);
  return envelopeGainAt({ gain: track.gain, keys: [], fadeInStart: 0, fadeInDuration: track.fadeIn, fadeOutStart: track.duration - track.fadeOut, fadeOutDuration: track.fadeOut }, elapsed);
}

function clamp(value: number): number { return Math.max(0, Math.min(1, value)); }
