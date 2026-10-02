import { isAnimationDocument } from "../animation/validation";
import type { Clip, ProjectDocument, Sequence, Transform } from "./types";
import { materialSourceFromAsset } from "./materials";

const finite = (values: number[]) => values.every(Number.isFinite);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const validTransform = (value: Transform) => value && finite([value.x, value.y, value.scaleX, value.scaleY, value.rotation, value.opacity]) && value.opacity >= 0 && value.opacity <= 1;
const kinds = ["live2d", "audio", "image", "text", "sequence"];
const assetKinds = [...kinds, "motion", "expression"];

export function isProjectDocument(value: unknown): value is ProjectDocument {
  if (!record(value)) return false;
  const project = value as Partial<ProjectDocument>;
  if (project.version !== 3 || typeof project.id !== "string" || !project.id || typeof project.name !== "string" ||
      typeof project.rootSequenceId !== "string" || !record(project.assets) || !record(project.sequences) ||
      !finite([project.width ?? NaN, project.height ?? NaN, project.fps ?? NaN, project.seed ?? NaN]) ||
      project.width! <= 0 || project.height! <= 0 || project.fps! <= 0 || typeof project.savedAt !== "string") return false;
  const assets = project.assets!;
  const sequences = project.sequences!;
  for (const [id, asset] of Object.entries(assets)) {
    if (!asset || asset.id !== id || !id || typeof asset.name !== "string" || typeof asset.uri !== "string" || !assetKinds.includes(asset.kind) ||
        (asset.duration != null && (!Number.isFinite(asset.duration) || asset.duration < 0)) ||
        (asset.width != null && (!Number.isFinite(asset.width) || asset.width <= 0)) ||
        (asset.height != null && (!Number.isFinite(asset.height) || asset.height <= 0)) ||
        (asset.missing != null && typeof asset.missing !== "boolean") ||
        (asset.waveformPeaks != null && (!Array.isArray(asset.waveformPeaks) || !finite(asset.waveformPeaks) || asset.waveformPeaks.some((value) => value < 0 || value > 1))) ||
        (asset.lipSync != null && (!Array.isArray(asset.lipSync) || !finite(asset.lipSync) || asset.lipSync.some((value) => value < 0 || value > 1))) ||
        (asset.lipSyncSampleRate != null && (!Number.isFinite(asset.lipSyncSampleRate) || asset.lipSyncSampleRate <= 0)) ||
        (asset.metadata != null && (!record(asset.metadata) || Object.values(asset.metadata).some((entry) => !["string", "number", "boolean"].includes(typeof entry) || (typeof entry === "number" && !Number.isFinite(entry)))))) return false;
    if (asset.kind === "sequence" && (typeof asset.metadata?.sequenceId !== "string" || !sequences[asset.metadata.sequenceId])) return false;
    if (asset.kind === "motion" || asset.kind === "expression") {
      try { if (!materialSourceFromAsset(asset)) return false; }
      catch { return false; }
    }
  }
  const actorIds = new Set<string>();
  const validClip = (clip: Clip, ids: Set<string>): boolean => {
    if (!clip || typeof clip.id !== "string" || !clip.id || ids.has(clip.id) || typeof clip.name !== "string" || !kinds.includes(clip.kind) ||
        !finite([clip.start, clip.duration, clip.sourceIn, clip.rate, clip.volume, clip.fadeIn, clip.fadeOut]) ||
        clip.start < 0 || clip.duration <= 0 || clip.sourceIn < 0 || clip.rate <= 0 || clip.volume < 0 || clip.fadeIn < 0 || clip.fadeOut < 0 ||
        !validTransform(clip.transform) || !Array.isArray(clip.transformKeys) || !Array.isArray(clip.volumeKeys)) return false;
    ids.add(clip.id);
    if (clip.sequenceId != null) {
      if (typeof clip.sequenceId !== "string" || !sequences[clip.sequenceId]) return false;
    } else if (clip.kind === "sequence") return false;
    else if (!clip.assetId || !assets[clip.assetId] || assets[clip.assetId].kind !== clip.kind) return false;
    if (clip.assetId != null && (!assets[clip.assetId] || (clip.sequenceId == null && assets[clip.assetId].kind !== clip.kind))) return false;
    if (clip.text != null && typeof clip.text !== "string") return false;
    if (clip.fontFamily != null && typeof clip.fontFamily !== "string") return false;
    if (clip.textColor != null && typeof clip.textColor !== "string") return false;
    if (clip.fontSize != null && (!Number.isFinite(clip.fontSize) || clip.fontSize <= 0)) return false;
    if (clip.lipSyncActorId != null && typeof clip.lipSyncActorId !== "string") return false;
    if (clip.lipSyncOffset != null && !Number.isFinite(clip.lipSyncOffset)) return false;
    if (clip.preservePitch != null && typeof clip.preservePitch !== "boolean") return false;
    if (clip.propertyCurves != null) {
      if (!record(clip.propertyCurves)) return false;
      for (const [name, curve] of Object.entries(clip.propertyCurves)) {
        if (!["x","y","scaleX","scaleY","rotation","opacity","volume"].includes(name) || !curve || typeof curve.enabled !== "boolean" || !Array.isArray(curve.keys)) return false;
        const ids = new Set<string>();
        for (const key of curve.keys) {
          if (!key || typeof key.id !== "string" || !key.id || ids.has(key.id) || !finite([key.time,key.value]) || key.time < 0 || !["linear","hold","inverse-hold","bezier"].includes(key.interpolation) || (key.inHandle && !finite([key.inHandle.time,key.inHandle.value])) || (key.outHandle && !finite([key.outHandle.time,key.outHandle.value]))) return false;
          ids.add(key.id);
        }
        if (curve.keys.some((key,index)=>index>0&&curve.keys[index-1].time>key.time)) return false;
      }
    }
    if (clip.linkGroupId != null && (typeof clip.linkGroupId !== "string" || !clip.linkGroupId)) return false;
    if (clip.fadeRegion && (!finite([clip.fadeRegion.sourceIn, clip.fadeRegion.sourceDuration, clip.fadeRegion.rate]) || clip.fadeRegion.sourceIn < 0 || clip.fadeRegion.sourceDuration <= 0 || clip.fadeRegion.rate <= 0)) return false;
    const transformIds = new Set<string>(), volumeIds = new Set<string>();
    for (const key of clip.transformKeys) {
      if (!key || typeof key.id !== "string" || !key.id || transformIds.has(key.id) || !Number.isFinite(key.time) || key.time < 0 || !validTransform(key)) return false;
      transformIds.add(key.id);
    }
    for (const key of clip.volumeKeys) {
      if (!key || typeof key.id !== "string" || !key.id || volumeIds.has(key.id) || !finite([key.time, key.value]) || key.time < 0 || key.value < 0) return false;
      volumeIds.add(key.id);
    }
    return true;
  };
  const validSequence = (sequence: Sequence, id: string): boolean => {
    if (!sequence || sequence.id !== id || !id || typeof sequence.name !== "string" || !["edit", "live2d"].includes(sequence.kind) ||
        !finite([sequence.duration, sequence.width, sequence.height, sequence.fps]) || sequence.duration < 0 ||
        sequence.width <= 0 || sequence.height <= 0 || sequence.fps <= 0 || !Array.isArray(sequence.tracks)) return false;
    const trackIds = new Set<string>(), clipIds = new Set<string>(), orders = new Set<number>();
    for (const track of sequence.tracks) {
      if (!track || typeof track.id !== "string" || !track.id || trackIds.has(track.id) || typeof track.name !== "string" ||
          !Number.isInteger(track.order) || track.order < 0 || track.order >= sequence.tracks.length || orders.has(track.order) ||
          typeof track.locked !== "boolean" || typeof track.hidden !== "boolean" || typeof track.muted !== "boolean" || !Array.isArray(track.clips)) return false;
      trackIds.add(track.id); orders.add(track.order);
      if (track.clips.some((clip) => !validClip(clip, clipIds))) return false;
      const ordered = track.clips.slice().sort((a, b) => a.start - b.start);
      for (let index = 1; index < ordered.length; index++) if (ordered[index - 1].start + ordered[index - 1].duration > ordered[index].start + 1e-7) return false;
    }
    if (sequence.kind === "live2d") {
      if (!Array.isArray(sequence.actors) || !isAnimationDocument(sequence.animation)) return false;
      for (const actor of sequence.actors) {
        if (!actor || typeof actor.id !== "string" || !actor.id || actorIds.has(actor.id) || assets[actor.assetId]?.kind !== "live2d" ||
            typeof actor.modelPartId !== "string" || typeof actor.name !== "string" || !validTransform(actor.transform) || typeof actor.visible !== "boolean") return false;
        actorIds.add(actor.id);
      }
    }
    return true;
  };
  if (!Object.keys(sequences).length || Object.entries(sequences).some(([id, sequence]) => !validSequence(sequence, id))) return false;
  if (!sequences[project.rootSequenceId] || sequences[project.rootSequenceId].kind !== "edit") return false;
  const active = new Set<string>(), done = new Set<string>();
  const visit = (id: string): boolean => {
    if (active.has(id)) return false;
    if (done.has(id)) return true;
    const sequence = sequences[id];
    if (!sequence) return false;
    active.add(id);
    for (const track of sequence.tracks) for (const clip of track.clips) if (clip.sequenceId && !visit(clip.sequenceId)) return false;
    active.delete(id); done.add(id);
    return true;
  };
  return Object.keys(sequences).every(visit);
}
