import type { AnimationDocument } from "../animation/types";
import type { Keyframe } from "../animation/types";

export type AssetKind = "live2d" | "audio" | "image" | "text";

export type ProjectAsset = {
  id: string;
  kind: AssetKind | "sequence" | "motion" | "expression";
  name: string;
  uri: string;
  duration?: number;
  width?: number;
  height?: number;
  missing?: boolean;
  waveformPeaks?: number[];
  /** Baked mouth amplitudes at lipSyncSampleRate (120 Hz by default). */
  lipSync?: number[];
  lipSyncSampleRate?: number;
  metadata?: Record<string, string | number | boolean>;
};

export type Transform = {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  /** Degrees, matching the editor and legacy character transforms. */
  rotation: number;
  opacity: number;
};

export type TransformKeyframe = Transform & { id: string; time: number };
export type PropertyCurve = { enabled: boolean; keys: Keyframe[] };
export type PropertyName = keyof Transform | "volume";

export type Clip = {
  id: string;
  /** Sequence-local association; linked clips retain their relative offsets. */
  linkGroupId?: string;
  kind: AssetKind | "sequence";
  name: string;
  assetId?: string;
  sequenceId?: string;
  start: number;
  duration: number;
  sourceIn: number;
  rate: number;
  transform: Transform;
  transformKeys: TransformKeyframe[];
  propertyCurves?: Partial<Record<PropertyName, PropertyCurve>>;
  volume: number;
  volumeKeys: Array<{ id: string; time: number; value: number }>;
  fadeIn: number;
  fadeOut: number;
  /** Original source range for fade phase preservation after a split or trim. */
  fadeRegion?: { sourceIn: number; sourceDuration: number; rate: number };
  lipSyncActorId?: string;
  lipSyncOffset?: number;
  preservePitch?: boolean;
  text?: string;
  fontFamily?: string;
  fontSize?: number;
  textColor?: string;
  placeholder?: { reason: string; original?: unknown };
};

export type Track = {
  id: string;
  name: string;
  order: number;
  locked: boolean;
  hidden: boolean;
  muted: boolean;
  clips: Clip[];
};

export type SequenceBase = {
  id: string;
  name: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  tracks: Track[];
};

export type EditSequence = SequenceBase & { kind: "edit" };

export type Live2DActor = {
  id: string;
  assetId: string;
  modelPartId: string;
  name: string;
  transform: Transform;
  visible: boolean;
};

export type Live2DSequence = SequenceBase & {
  kind: "live2d";
  actors: Live2DActor[];
  animation: AnimationDocument;
};

export type Sequence = EditSequence | Live2DSequence;

export type ProjectDocument = {
  version: 3;
  id: string;
  name: string;
  assets: Record<string, ProjectAsset>;
  sequences: Record<string, Sequence>;
  rootSequenceId: string;
  width: number;
  height: number;
  fps: number;
  seed: number;
  savedAt: string;
};

export type ResolvedClip = {
  clip: Clip;
  sequence: Sequence;
  track: Track;
  sequencePath: string[];
  layerOrder: number[];
  projectTime: number;
  sourceTime: number;
  visible: boolean;
  muted: boolean;
  transform: Transform;
  volume: number;
};

export type ResolvedActor = {
  actor: Live2DActor;
  sequence: Live2DSequence;
  sequencePath: string[];
  layerOrder: number[];
  sourceTime: number;
  visible: boolean;
  transform: Transform;
};

export const DEFAULT_TRANSFORM: Transform = {
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  opacity: 1,
};

export function createClip(input: Partial<Clip> & Pick<Clip, "kind" | "name" | "start" | "duration">): Clip {
  return {
    id: input.id ?? crypto.randomUUID(),
    kind: input.kind,
    name: input.name,
    assetId: input.assetId,
    sequenceId: input.sequenceId,
    start: input.start,
    duration: input.duration,
    sourceIn: input.sourceIn ?? 0,
    rate: input.rate ?? 1,
    transform: { ...DEFAULT_TRANSFORM, ...input.transform },
    transformKeys: input.transformKeys?.map((key) => ({ ...key })) ?? [],
    propertyCurves: input.propertyCurves ? structuredClone(input.propertyCurves) : undefined,
    volume: input.volume ?? 1,
    volumeKeys: input.volumeKeys?.map((key) => ({ ...key })) ?? [],
    fadeIn: input.fadeIn ?? 0,
    fadeOut: input.fadeOut ?? 0,
    fadeRegion: input.fadeRegion ? { ...input.fadeRegion } : undefined,
    lipSyncActorId: input.lipSyncActorId,
    lipSyncOffset: input.lipSyncOffset,
    preservePitch: input.preservePitch ?? true,
    linkGroupId: input.linkGroupId,
    text: input.text,
    fontFamily: input.fontFamily,
    fontSize: input.fontSize,
    textColor: input.textColor,
    placeholder: input.placeholder,
  };
}

export function createTrack(order: number, name = `轨道 ${order + 1}`): Track {
  return {
    id: crypto.randomUUID(), name, order, locked: false, hidden: false,
    muted: false, clips: [],
  };
}

export function createEditSequence(name = "主序列", options: Partial<Pick<SequenceBase, "width" | "height" | "fps">> = {}): EditSequence {
  return {
    id: crypto.randomUUID(), name, kind: "edit", duration: 0,
    width: options.width ?? 1920, height: options.height ?? 1080,
    fps: options.fps ?? 30, tracks: [createTrack(0)],
  };
}
