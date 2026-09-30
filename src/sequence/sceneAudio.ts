import { audioGainAt, resolveAudioSchedule } from "./audio";
import type { Clip, ProjectDocument } from "./types";

export type SceneLipSampler = (sequenceId: string, actorId: string, sourceTime: number, instancePath: string[]) => number;

/** One sampler is shared by preview, seek reconstruction and frame export. */
export function getSceneLipAt(project: ProjectDocument, renderSequenceId = project.rootSequenceId): SceneLipSampler {
  const schedule = resolveAudioSchedule(project, renderSequenceId);
  const localSchedules = new Map<string, ReturnType<typeof resolveAudioSchedule>>();
  return (sequenceId, actorId, sourceTime, path) => {
    if (!Number.isFinite(sourceTime) || path[0] !== renderSequenceId) return 0;
    let sequence = project.sequences[renderSequenceId];
    const clips: Clip[] = [];
    for (const id of path.slice(1)) {
      const clip = sequence?.tracks.flatMap((track) => track.clips).find((clip) => clip.id === id);
      if (!clip?.sequenceId) return 0;
      clips.push(clip);
      sequence = project.sequences[clip.sequenceId];
    }
    if (!sequence || sequence.id !== sequenceId) return 0;
    let outputTime = sourceTime;
    for (let index = clips.length - 1; index >= 0; index--) {
      const clip = clips[index];
      outputTime = clip.start + (outputTime - clip.sourceIn) / clip.rate;
    }
    // Internal animation/physics must reconstruct its complete source history even
    // when a parent clip's in-point hides the beginning or mutes its outer audio.
    let localSchedule = localSchedules.get(sequenceId);
    if (!localSchedule) { localSchedule = resolveAudioSchedule(project, sequenceId); localSchedules.set(sequenceId, localSchedule); }
    let value = sampleSchedule(project, localSchedule, actorId, sourceTime);
    for (const audio of schedule) {
      if (audio.lipSyncActorId !== actorId || audio.muted || !compatiblePaths(audio.sequencePath ?? [renderSequenceId], path)) continue;
      // Descendant audio was already sampled above in the actor's untrimmed source.
      if (path.every((id, index) => audio.sequencePath?.[index] === id)) continue;
      value = Math.max(value, sampleSchedule(project, [audio], actorId, outputTime));
    }
    return Math.max(0, Math.min(1, value));
  };
}

function sampleSchedule(project: ProjectDocument, schedule: ReturnType<typeof resolveAudioSchedule>, actorId: string, time: number): number {
  let value = 0;
  for (const audio of schedule) {
    if (audio.lipSyncActorId !== actorId || audio.muted) continue;
    const elapsed = time - audio.start;
    if (elapsed < 0 || elapsed >= audio.duration) continue;
    const asset = project.assets[audio.assetId], samples = asset?.lipSync;
    if (!samples?.length) continue;
    const sampleTime = (audio.sourceIn + elapsed * audio.rate) * (asset.lipSyncSampleRate ?? 120);
    if (sampleTime < 0 || sampleTime >= samples.length) continue;
    const index = Math.floor(sampleTime), blend = sampleTime - index;
    const amplitude = samples[index] * (1 - blend) + (samples[index + 1] ?? samples[index]) * blend;
    value = Math.max(value, amplitude * audioGainAt(audio, elapsed));
  }
  return value;
}

function compatiblePaths(a: string[], b: string[]): boolean {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) if (a[index] !== b[index]) return false;
  return true;
}
