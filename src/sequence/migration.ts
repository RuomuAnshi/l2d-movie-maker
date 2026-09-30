import { emptyAnimation } from "../animation/types";
import type { AnimationDocument } from "../animation/types";
import { createClip, createEditSequence, createTrack, DEFAULT_TRANSFORM } from "./types";
import type { ProjectAsset, ProjectDocument, Sequence, Track } from "./types";

type LegacyMediaClip = {
  id: string;
  name: string;
  start: number;
  duration: number;
  audioPath?: string;
  audioUrl?: string;
  audioSourceDuration?: number;
  sourceIn?: number;
  playbackRate?: number;
  gain?: number;
  fadeIn?: number;
  fadeOut?: number;
  subtitleText?: string;
  speakerName?: string;
  fontFamily?: string;
  fontSize?: number;
  textColor?: string;
};

export type LegacyProjectInput = {
  selectedModel: string | null;
  externalModelPath?: string;
  animation?: AnimationDocument;
  motionClips: LegacyMediaClip[];
  exprClips: LegacyMediaClip[];
  audioClips: LegacyMediaClip[];
  subtitleClips: LegacyMediaClip[];
  showSubtitles?: boolean;
  showSubtitleSpeaker?: boolean;
  subtitleSpeakerAlign?: "left" | "center" | "right";
  playhead: number;
  selectedCharacterId?: string;
  characterVisible?: boolean;
  characterTransform?: { x: number; y: number; scaleX: number; scaleY: number; rotation: number };
  characterTransformMode?: "single-relative" | "composite-container";
  width?: number;
  height?: number;
  fps?: number;
  savedAt?: string;
};

/** Converts the previous global-lane format into an explicit nested model sequence and mixed edit tracks. */
export function migrateLegacyProject(input: LegacyProjectInput): ProjectDocument {
  const width = input.width ?? 1920;
  const height = input.height ?? 1080;
  const fps = input.fps ?? 30;
  const assets: Record<string, ProjectAsset> = {};
  const sequences: Record<string, Sequence> = {};
  const root = createEditSequence("主序列", { width, height, fps });
  root.id = "sequence:main";
  const tracks: Track[] = [createTrack(0, "画面")];

  const mediaEnd = [...input.motionClips, ...input.exprClips, ...input.audioClips, ...input.subtitleClips]
    .reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0);
  let animationEnd = 0;
  for (const track of input.animation?.tracks ?? []) for (const key of track.keys) animationEnd = Math.max(animationEnd, key.time);
  for (const group of input.animation?.groups ?? []) animationEnd = Math.max(animationEnd, group.start + group.duration);
  const modelUri = input.externalModelPath ?? input.selectedModel;
  const sceneEnd = Math.max(mediaEnd, animationEnd, 5);
  const hasPendingAnimation = input.motionClips.length > 0 || input.exprClips.length > 0;

  if (modelUri || hasPendingAnimation || input.animation?.tracks.length) {
    const assetId = "asset:model:main";
    const liveSequenceId = "sequence:live2d:main";
    const transformMode = input.characterTransformMode ?? (/\.jsonl(?:[?#]|$)/i.test(modelUri ?? "") ? "composite-container" : "single-relative");
    const originalTransform = input.characterTransform;
    const actorTransform = { ...DEFAULT_TRANSFORM, ...originalTransform };
    if (originalTransform) {
      actorTransform.x = transformMode === "single-relative" ? originalTransform.x * width / 200 : originalTransform.x - width / 2;
      actorTransform.y = transformMode === "single-relative" ? originalTransform.y * height / 200 : originalTransform.y - height / 2;
    }
    assets[assetId] = {
      id: assetId, kind: "live2d", name: modelUri?.split(/[\\/]/).pop() ?? "待补充模型", uri: modelUri ?? "", missing: !modelUri,
      metadata: {
        ...(hasPendingAnimation ? { legacyMotions: JSON.stringify(input.motionClips), legacyExpressions: JSON.stringify(input.exprClips) } : {}),
        ...(originalTransform ? { legacyTransform: true, legacyTransformMode: transformMode, legacyTransformJson: JSON.stringify(originalTransform) } : {}),
        ...(input.selectedCharacterId ? { legacySelectedCharacterId: input.selectedCharacterId } : {}),
      },
    };
    sequences[liveSequenceId] = {
      id: liveSequenceId,
      name: "角色动画",
      kind: "live2d",
      duration: sceneEnd,
      width,
      height,
      fps,
      actors: [{
        id: "actor:main", assetId, modelPartId: input.selectedCharacterId ?? "main", name: "角色",
        transform: actorTransform, visible: input.characterVisible ?? true,
      }],
      animation: structuredClone(input.animation ?? emptyAnimation()),
      tracks: [],
    };
    tracks[0].clips.push(createClip({
      id: "clip:live2d:main", kind: "sequence", sequenceId: liveSequenceId, name: "Live2D", start: 0, duration: sceneEnd,
      placeholder: hasPendingAnimation ? { reason: "旧动画等待模型转换", original: { motionClips: structuredClone(input.motionClips), exprClips: structuredClone(input.exprClips) } } : undefined,
    }));
  }

  const audioTrack = createTrack(1, "音频");
  for (const legacy of input.audioClips) {
    const assetId = `asset:audio:${legacy.id}`;
    const uri = legacy.audioPath ?? legacy.audioUrl ?? "";
    assets[assetId] = { id: assetId, kind: "audio", name: legacy.name, uri, duration: legacy.audioSourceDuration ?? legacy.duration, missing: !uri || uri.startsWith("bundle:"), metadata: { legacyClipId: legacy.id } };
    audioTrack.clips.push(createClip({ id: legacy.id, kind: "audio", assetId, name: legacy.name, start: legacy.start, duration: legacy.duration, sourceIn: legacy.sourceIn, rate: legacy.playbackRate, volume: legacy.gain, fadeIn: legacy.fadeIn, fadeOut: legacy.fadeOut }));
  }
  if (audioTrack.clips.length) tracks.push(audioTrack);

  const textTrack = createTrack(tracks.length, "文字");
  textTrack.hidden = input.showSubtitles === false;
  for (const legacy of input.subtitleClips) {
    const assetId = `asset:text:${legacy.id}`;
    assets[assetId] = { id: assetId, kind: "text", name: legacy.name, uri: "", metadata: { fontFamily: legacy.fontFamily ?? "", fontSize: legacy.fontSize ?? 34, color: legacy.textColor ?? "#ffffff", speaker: legacy.speakerName ?? "", showSpeaker: input.showSubtitleSpeaker ?? true, speakerAlign: input.subtitleSpeakerAlign ?? "center", legacyClipId: legacy.id } };
    textTrack.clips.push(createClip({ id: legacy.id, kind: "text", assetId, name: legacy.name, start: legacy.start, duration: legacy.duration, text: legacy.subtitleText ?? "", fontFamily: legacy.fontFamily, fontSize: legacy.fontSize ?? 34, textColor: legacy.textColor ?? "#ffffff", transform: { ...DEFAULT_TRANSFORM, y: height / 2 - 60 } }));
  }
  // Legacy subtitles were composited above the model; order 0 is the top lane.
  if (textTrack.clips.length) tracks.unshift(textTrack);
  // Old fixed lanes could contain overlaps; distribute them without dropping data.
  const nonOverlapping: Track[] = [];
  for (const track of tracks) {
    const lanes: Track[] = [{ ...track, clips: [] }];
    for (const clip of track.clips.slice().sort((a, b) => a.start - b.start)) {
      let lane = lanes.find((item) => item.clips.every((other) => clip.start >= other.start + other.duration - 1e-7 || clip.start + clip.duration <= other.start + 1e-7));
      if (!lane) { lane = { ...createTrack(0, track.name), hidden: track.hidden, muted: track.muted, locked: track.locked }; lanes.unshift(lane); }
      lane.clips.push(clip);
    }
    nonOverlapping.push(...lanes);
  }
  root.tracks = nonOverlapping.map((track, order) => ({ ...track, order }));
  root.duration = Math.max(0, ...root.tracks.flatMap((track) => track.clips.map((clip) => clip.start + clip.duration)));
  sequences[root.id] = root;

  return {
    version: 3,
    id: "project:migrated",
    name: "Live2D 工程",
    assets,
    sequences,
    rootSequenceId: root.id,
    width,
    height,
    fps,
    seed: input.animation?.seed ?? 1729,
    savedAt: input.savedAt ?? new Date().toISOString(),
  };
}

/** Updates the migrator's default actor when the user changes the model-library selection. */
export function ensureMainLive2DAsset(project: ProjectDocument, modelUri: string | null, characterId = "main"): ProjectDocument {
  if (!modelUri) return project;
  const assetId = "asset:model:main";
  const sequenceId = "sequence:live2d:main";
  const existing = project.sequences[sequenceId];
  const rootBefore = project.sequences[project.rootSequenceId];
  const hasMainClip = rootBefore?.tracks.some((track) => track.clips.some((clip) => clip.sequenceId === sequenceId));
  if (project.assets[assetId]?.uri === modelUri && existing?.kind === "live2d" && hasMainClip && existing.actors[0]?.modelPartId === characterId) return project;
  const asset: ProjectAsset = { id: assetId, kind: "live2d", name: modelUri.split(/[\\/]/).pop() ?? "Live2D", uri: modelUri };
  const liveSequence: Sequence = existing?.kind === "live2d" ? {
    ...existing,
    actors: existing.actors.length
      ? existing.actors.map((actor, index) => index === 0 ? { ...actor, assetId, modelPartId: characterId, name: asset.name } : actor)
      : [{ id: "actor:main", assetId, modelPartId: characterId, name: asset.name, transform: { ...DEFAULT_TRANSFORM }, visible: true }],
  } : {
    id: sequenceId, name: "角色动画", kind: "live2d", duration: 5, width: project.width, height: project.height, fps: project.fps,
    tracks: [], animation: emptyAnimation(),
    actors: [{ id: "actor:main", assetId, modelPartId: characterId, name: asset.name, transform: { ...DEFAULT_TRANSFORM }, visible: true }],
  };
  const root = project.sequences[project.rootSequenceId];
  if (!root || root.kind !== "edit") return project;
  let tracks = root.tracks;
  const existingClip = tracks.flatMap((track) => track.clips).find((clip) => clip.sequenceId === sequenceId);
  if (!existingClip) {
    const track = createTrack(tracks.length, "画面");
    track.clips.push(createClip({ id: "clip:live2d:main", kind: "sequence", sequenceId, name: asset.name, start: 0, duration: 5 }));
    tracks = [...tracks, track];
  } else {
    tracks = tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => clip.id === existingClip.id ? { ...clip, name: asset.name } : clip) }));
  }
  return {
    ...project,
    assets: { ...project.assets, [assetId]: asset },
    sequences: { ...project.sequences, [sequenceId]: liveSequence, [root.id]: { ...root, tracks, duration: Math.max(root.duration, 5) } },
  };
}
