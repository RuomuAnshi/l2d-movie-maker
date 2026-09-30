// src/components/Live2DView.tsx
import { startTransition, useEffect, useRef, useState } from "react";
import * as PIXI from "pixi.js";
import { Live2DModel } from "pixi-live2d-display";
import { emptyAnimation } from '../animation/types';
import { animationEnd, combineSourceGroups } from '../animation/engine';
import { migrateLegacyClips } from '../animation/migration';
import { readModelDataFromRuntime } from '../utils/modelData';
import { useTimelineDocument } from '../animation/useTimelineDocument';
import { bakeLipSync, importMaterial } from '../animation/importers';
import { ModelAdapter, TimelineRenderer } from '../animation/runtime';
import Timeline from "./timeline/Timeline";
import type { Clip, SubtitleClip, TrackKind } from "./timeline/clipTypes";
import { parseMotionDurationSeconds } from "../utils/motionDuration";
import "./Live2DView.css";
import "./pixel-theme.css";
import ControlPanel, { type InspectorTab } from "./panel/ControlPanel";
import ModelManager from "./ModelManager";
import type { JsonlLive2DModel } from "./ModelManager";
import AudioManager from "./AudioManager";
import ScreenshotManager from "./ScreenshotManager";
// WebGAL 暂停启用：恢复时取消这些入口与导入流程的注释。
// import WebGALMode from "./WebGALMode";
import AlertModal from "./AlertModal";
// import { convertFileSrc } from "@tauri-apps/api/core";
// import { normalizePath } from "../utils/fs";
import { invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";
import { dirname, join } from "@tauri-apps/api/path";
import { remove, writeFile } from "@tauri-apps/plugin-fs";
import { runVideoExport, type VideoExportFormat, type VideoExportMode } from "../utils/videoExporter";
import {
  buildWebGALExternalAssetUrl as buildExternalAssetUrl,
  // loadWebGALMotionDurations,
  // resolveFigureAbsolutePath,
  // type WebGALImportPlan,
} from "../utils/webgalProject";
import {
  importModelSource,
  loadModelPackages,
  saveModelPackages,
  type ModelPackage,
} from "../utils/modelLibrary";
import {
  createProjectBundle,
  loadAutosaveProject,
  openProjectBundle,
  saveAutosaveProject,
  storeAudioAsset,
  stripRuntimeAudio,
  type ProjectSnapshot,
} from "../utils/projectStorage";

interface Motion { name: string; file: string; }
interface Expression { name: string; file: string; }
interface ModelData {
  motions: { [key: string]: Motion[] };
  expressions: Expression[];
}

type MotionLenMap = Record<string, number>;
type CharacterOption = { id: string; label: string };
type CharacterTransform = { x: number; y: number; scaleX: number; scaleY: number; rotation: number };
type CharacterTransformMode = "single-relative" | "composite-container";
type TransformTarget = Pick<PIXI.Container, "position" | "scale" | "rotation" | "getBounds">;
type RendererWithBackground = PIXI.Renderer & {
  backgroundColor: number;
  backgroundAlpha: number;
  clearBeforeRender: boolean;
  gl?: WebGLRenderingContext | WebGL2RenderingContext | null;
};
type SubtitleSpeakerAlign = "left" | "center" | "right";
const PLAYHEAD_UI_INTERVAL_MS = 1000 / 30;
const EXPORT_PROGRESS_UI_INTERVAL_MS = 100;
const DEFAULT_SUBTITLE_FONT_FAMILY = "Microsoft YaHei";
const DEFAULT_SUBTITLE_FONT_SIZE = 34;
const DEFAULT_SUBTITLE_TEXT_COLOR = "#ffffff";
const AUDIO_WAVEFORM_PEAK_COUNT = 56;
const AUDIO_END_GUARD_SEC = 0.03;

declare global {
  interface Window {
    PIXI?: typeof PIXI;
  }
}


export default function Live2DView() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // ????????????????
  const modelRef = useRef<Live2DModel | Live2DModel[] | null>(null);
  const appRef = useRef<PIXI.Application | null>(null);
  const subtitleContainerRef = useRef<PIXI.Container | null>(null);
  const subtitleSpeakerTextRef = useRef<PIXI.Text | null>(null);
  const subtitleSpeakerUnderlineRef = useRef<PIXI.Graphics | null>(null);
  const subtitleTextRef = useRef<PIXI.Text | null>(null);

  // ????jsonl?????????MTN ??????
  const groupContainerRef = useRef<PIXI.Container | null>(null);
  const isCompositeRef = useRef<boolean>(false);
  const motionBaseRef = useRef<string | null>(null); // ???? mtn ????

  // ??????????
  const [assetBase, setAssetBase] = useState<string | null>(null);

  // ??????? ???//
  const [modelList, setModelList] = useState<string[]>([]);
  const [modelRoot, setModelRoot] = useState<string | null>(null);
  const [modelPackages, setModelPackages] = useState<ModelPackage[]>([]);
  const [isImportingModel, setIsImportingModel] = useState(false);
  const [projectHydrated, setProjectHydrated] = useState(false);
  const [lastAutosaveAt, setLastAutosaveAt] = useState<Date | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null); // ?? "anon/model.json" ??"xxx/model.jsonl"
  const [, setExternalModelDisplayName] = useState<string | null>(null);
  const [externalModelUrl, setExternalModelUrl] = useState<string | null>(null);
  const skipNextModelLoadRef = useRef(false);
  const modelUrl = externalModelUrl ?? (selectedModel && assetBase ? `${assetBase}/${selectedModel}` : null); // ???URL

  // ????????? ???//
  const [modelData, setModelData] = useState<ModelData | null>(null);
  const [currentMotion, setCurrentMotion] = useState<string>("");
  const [currentExpression, setCurrentExpression] = useState<string>("default");
  const [enableDragging, setEnableDragging] = useState<boolean>(true);
  const [isDragging, setIsDragging] = useState<boolean>(false);

  // ??????????//
  const [motionClips, setMotionClips] = useState<Clip[]>([]);
  const [exprClips, setExprClips] = useState<Clip[]>([]);
  const [audioClips, setAudioClips] = useState<Clip[]>([]); // ??????
  const [subtitleClips, setSubtitleClips] = useState<SubtitleClip[]>([]);
  const { animation, animationRef, changeAnimation, beginEdit, endEdit, undo, redo, resetHistory } = useTimelineDocument(audioClips, subtitleClips, setAudioClips, setSubtitleClips);
  const rendererRef = useRef<TimelineRenderer | null>(null);
  const pendingMigrationRef = useRef<{ motions: Clip[]; expressions: Clip[] } | null>(null);
  const migrationFailedRef = useRef(false);
  // const importingTimelineRef = useRef(false);
  const [animationIssue, setAnimationIssue] = useState<string | null>(null);
  const restoringProjectRef = useRef<ProjectSnapshot | null>(null);
  const [projectRevision, setProjectRevision] = useState(0);
  const externalModelPathRef = useRef<string | null>(null);
  const [showSubtitles, setShowSubtitles] = useState(true);
  const [showSubtitleSpeaker, setShowSubtitleSpeaker] = useState(false);
  const [subtitleSpeakerAlign, setSubtitleSpeakerAlign] = useState<SubtitleSpeakerAlign>("center");
  const [playhead, setPlayhead] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const isPlayingRef = useRef(false);
  const [currentAudioLevel, setCurrentAudioLevel] = useState(0); // ??????
  const [currentFps, setCurrentFps] = useState(0);

  const rafRef = useRef<number | null>(null);
  const previewRafRef = useRef<number | null>(null);
  const startTsRef = useRef<number | null>(null);
  const fpsRafRef = useRef<number | null>(null);
  const fpsFrameCountRef = useRef(0);
  const fpsLastTsRef = useRef<number | null>(null);
  const playheadRef = useRef(0);
  const playheadUiLastTsRef = useRef<number | null>(null);
  const activeSubtitleSignatureRef = useRef<string>("");
  const subtitleVisibilityOverrideRef = useRef<boolean | null>(null);

  // ????????
  const [motionDur, setMotionDur] = useState(2);
  const [exprDur, setExprDur] = useState(0.8);

  // ?? motion ??????
  const [motionLen, setMotionLen] = useState<MotionLenMap>({});

  // ????? ???//
  const [exportState, setExportState] = useState<"idle" | "done" | "exporting">("idle");
  const [exportTime, setExportTime] = useState(0);
  const [exportProgress, setExportProgress] = useState(0);
  const [transparentBg, setTransparentBg] = useState(true);
  
  // ????????????????//
  const [customRecordingBounds, setCustomRecordingBounds] = useState({ x: 0, y: 0, width: 800, height: 600 });
   
// ????????? ???//
  const [recordingQuality, setRecordingQuality] = useState<"low" | "medium" | "high">("medium");

  // ??????????????//
  const [alertMessage, setAlertMessage] = useState<string | null>(null);
  const showAlert = (msg: string) => setAlertMessage(msg);

  // ????????????????? ???//
  const useModelFrame = false;
  const [characterOptions, setCharacterOptions] = useState<CharacterOption[]>([]);
  const [selectedCharacterId, setSelectedCharacterId] = useState<string>("main");
  const [isCharacterVisible, setIsCharacterVisible] = useState(true);
  const [characterTransformMode, setCharacterTransformMode] = useState<CharacterTransformMode>("single-relative");
  const [characterTransform, setCharacterTransform] = useState<CharacterTransform>({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 });
  const characterTransformRef = useRef<CharacterTransform>({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 });
  const characterTransformModeRef = useRef<CharacterTransformMode>("single-relative");
  const isDraggingRef = useRef(false);

  const handleDraggingChange = (dragging: boolean) => {
    isDraggingRef.current = dragging;
    setIsDragging(dragging);
  };

  const syncCharacterTransformState = (transform: CharacterTransform) => {
    characterTransformRef.current = transform;
    setCharacterTransform(transform);
  };

  const syncCharacterTransformModeState = (mode: CharacterTransformMode) => {
    characterTransformModeRef.current = mode;
    setCharacterTransformMode(mode);
  };

  const resetSingleCharacterTransformState = () => {
    syncCharacterTransformModeState("single-relative");
    syncCharacterTransformState({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 });
  };

  const syncCharacterTransformFromScene = (transform: CharacterTransform) => {
    if (Array.isArray(modelRef.current)) {
      syncCharacterTransformModeState("composite-container");
      syncCharacterTransformState(transform);
      return;
    }

    syncCharacterTransformModeState("single-relative");
    const relative = toSingleModelRelativePosition({ x: transform.x, y: transform.y });
    syncCharacterTransformState({
      ...transform,
      x: relative.x,
      y: relative.y,
    });
  };

  
  // ???WebGAL?? ???//
  // const [showWebGALMode, setShowWebGALMode] = useState(false);
  const [activeInspectorTab, setActiveInspectorTab] = useState<InspectorTab>("character");

  // ??????
  const modelManager = ModelManager({
    appRef,
    modelRef,
    groupContainerRef,
    isCompositeRef,
    motionBaseRef,
    setModelData,
    setCustomRecordingBounds,
    enableDragging,
    setIsDragging: handleDraggingChange,
    onTransformChange: syncCharacterTransformFromScene,
    onBeforeModelDispose: () => { rendererRef.current = null; stopPlayback(); },
  });

  const audioManager = AudioManager({
    modelRef,
    audioClips,
    setCurrentAudioLevel
  });

  const getPreviewDimensions = () => {
    const fallbackWidth = containerRef.current?.clientWidth ?? 1;
    const fallbackHeight = containerRef.current?.clientHeight ?? 1;
    return {
      width: Math.max(1, appRef.current?.screen.width ?? fallbackWidth),
      height: Math.max(1, appRef.current?.screen.height ?? fallbackHeight),
    };
  };

  const toSingleModelRelativePosition = (position: { x: number; y: number }) => {
    const { width, height } = getPreviewDimensions();
    return {
      x: ((position.x - (width / 2)) / (width / 2)) * 100,
      y: ((position.y - (height / 2)) / (height / 2)) * 100,
    };
  };

  const toSingleModelAbsolutePosition = (position: { x: number; y: number }) => {
    const { width, height } = getPreviewDimensions();
    return {
      x: (width / 2) + ((position.x / 100) * (width / 2)),
      y: (height / 2) + ((position.y / 100) * (height / 2)),
    };
  };

  const readTransformFromTarget = (target: TransformTarget, mode: CharacterTransformMode): CharacterTransform => {
    const position = mode === "single-relative"
      ? toSingleModelRelativePosition({ x: Number(target.position.x), y: Number(target.position.y) })
      : { x: Number(target.position.x), y: Number(target.position.y) };

    return {
      x: position.x,
      y: position.y,
      scaleX: Number(target.scale.x),
      scaleY: Number(target.scale.y),
      rotation: Number(target.rotation * 180 / Math.PI),
    };
  };

  const getTransformTarget = (): TransformTarget | null => {
    const cur = modelRef.current;
    if (!cur) return null;
    if (Array.isArray(cur)) return groupContainerRef.current ?? null;
    return cur;
  };

  const getSelectedCharacterDisplayObjects = (): PIXI.DisplayObject[] => {
    const currentModel = modelRef.current;
    if (!currentModel) return [];

    if (Array.isArray(currentModel)) {
      const matchingModels = currentModel.filter((model) => {
        const taggedModel = model as JsonlLive2DModel;
        return (taggedModel.__characterId ?? "") === selectedCharacterId;
      });

      if (matchingModels.length > 0) {
        return matchingModels as unknown as PIXI.DisplayObject[];
      }

      return groupContainerRef.current ? [groupContainerRef.current] : [];
    }

    return [currentModel as unknown as PIXI.DisplayObject];
  };

  const syncSelectedCharacterVisibilityState = () => {
    const targets = getSelectedCharacterDisplayObjects();
    setIsCharacterVisible(targets.length === 0 ? true : targets.every((target) => target.visible));
  };

  const setSelectedCharacterVisibility = (visible: boolean) => {
    const targets = getSelectedCharacterDisplayObjects();
    targets.forEach((target) => {
      target.visible = visible;
    });
    setIsCharacterVisible(visible);
  };

  const syncRecordingBoundsFromCurrentModel = () => {
    if (Array.isArray(modelRef.current)) {
      if (groupContainerRef.current) {
        const b = groupContainerRef.current.getBounds();
        setCustomRecordingBounds({ x: Math.max(0, b.x), y: Math.max(0, b.y), width: Math.max(100, b.width), height: Math.max(100, b.height) });
      }
      return;
    }
    if (modelRef.current) {
      const b = modelRef.current.getBounds();
      if (b && b.width > 0 && b.height > 0) {
        setCustomRecordingBounds({ x: Math.max(0, b.x), y: Math.max(0, b.y), width: Math.max(100, b.width), height: Math.max(100, b.height) });
      }
    }
  };

  const syncSingleModelAbsoluteTransform = (transform: CharacterTransform = characterTransformRef.current) => {
    const currentModel = modelRef.current;
    if (!currentModel || Array.isArray(currentModel)) return;
    const absolute = toSingleModelAbsolutePosition({ x: transform.x, y: transform.y });
    currentModel.position.set(absolute.x, absolute.y);
    currentModel.scale.set(Math.max(0.01, transform.scaleX), Math.max(0.01, transform.scaleY));
    currentModel.rotation = (transform.rotation * Math.PI) / 180;
  };

  const syncSingleModelTransformState = (positionMode: "center" | "read" | "preserve" = "preserve") => {
    const currentModel = modelRef.current;
    if (!currentModel || Array.isArray(currentModel)) return;

    let nextPosition: { x: number; y: number };
    if (positionMode === "center") {
      nextPosition = { x: 0, y: 0 };
    } else if (positionMode === "read") {
      nextPosition = toSingleModelRelativePosition({
        x: Number(currentModel.position.x),
        y: Number(currentModel.position.y),
      });
    } else {
      nextPosition = {
        x: characterTransformRef.current.x,
        y: characterTransformRef.current.y,
      };
    }

    syncCharacterTransformModeState("single-relative");
    syncCharacterTransformState({
      x: nextPosition.x,
      y: nextPosition.y,
      scaleX: Number(currentModel.scale.x),
      scaleY: Number(currentModel.scale.y),
      rotation: Number(currentModel.rotation * 180 / Math.PI),
    });
  };

  const refreshCharacterEditor = () => {
    const cur = modelRef.current;
    if (!cur) {
      setCharacterOptions([]);
      setSelectedCharacterId("main");
      setIsCharacterVisible(true);
      resetSingleCharacterTransformState();
      return;
    }

    if (Array.isArray(cur)) {
      const options = Array.from(
        new Map(
          cur.map((model, index) => {
            const taggedModel = model as JsonlLive2DModel;
            const id = taggedModel.__characterId || `part${index}`;
            const label = taggedModel.__characterLabel || id;
            return [id, { id, label }];
          })
        ).values()
      );

      setCharacterOptions(options);
      setSelectedCharacterId((prev) => (
        options.some((option) => option.id === prev) ? prev : (options[0]?.id ?? "main")
      ));
      syncCharacterTransformModeState("composite-container");
      const target = groupContainerRef.current;
      if (!target) return;
      syncCharacterTransformState(readTransformFromTarget(target, "composite-container"));
      syncSelectedCharacterVisibilityState();
      return;
    }

    setCharacterOptions([{ id: "main", label: "主角色" }]);
    if (selectedCharacterId !== "main") setSelectedCharacterId("main");
    syncSingleModelTransformState("preserve");
    syncSelectedCharacterVisibilityState();
  };

  const updateSelectedCharacterTransform = (patch: Partial<CharacterTransform>) => {
    const target = getTransformTarget();
    if (!target) return;
    const next: CharacterTransform = { ...characterTransformRef.current, ...patch };
    if (characterTransformModeRef.current === "single-relative") {
      const absolute = toSingleModelAbsolutePosition({ x: next.x, y: next.y });
      target.position.set(absolute.x, absolute.y);
    } else {
      target.position.set(next.x, next.y);
    }
    target.scale.set(Math.max(0.01, next.scaleX), Math.max(0.01, next.scaleY));
    target.rotation = (next.rotation * Math.PI) / 180;
    syncCharacterTransformState(next);
    syncRecordingBoundsFromCurrentModel();
  };

  const updateUniformScale = (multiplier: number) => {
    const current = characterTransformRef.current;
    const uniformScale = Math.max(0.01, (current.scaleX + current.scaleY) / 2);
    const nextScale = Math.max(0.01, Math.min(10, uniformScale * multiplier));
    updateSelectedCharacterTransform({ scaleX: nextScale, scaleY: nextScale });
  };


  // ????????
  const nextEnd = (clips: Clip[]) => clips.reduce((t, c) => Math.max(t, c.start + c.duration), 0);

  const buildSubtitleClipName = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return "新字幕";
    return trimmed.length > 18 ? `${trimmed.slice(0, 18)}...` : trimmed;
  };

  const createSubtitleClip = (
    text: string,
    start: number,
    duration: number,
    options: { linkedAudioClipId?: string; speakerName?: string } = {},
  ): SubtitleClip => ({
    id: crypto.randomUUID(),
    name: buildSubtitleClipName(text),
    start,
    duration,
    subtitleText: text,
    speakerName: options.speakerName?.trim() || undefined,
    fontFamily: DEFAULT_SUBTITLE_FONT_FAMILY,
    fontSize: DEFAULT_SUBTITLE_FONT_SIZE,
    textColor: DEFAULT_SUBTITLE_TEXT_COLOR,
    linkedAudioClipId: options.linkedAudioClipId,
  });

  const getAudioAudibleDuration = (clip: Clip) =>
    Math.min(
      Math.max(0, Number(clip.duration) || 0),
      Math.max(0, Number(clip.audioSourceDuration ?? clip.duration) || 0),
    );

  const buildWaveformPeaks = (buffer: AudioBuffer, peakCount = AUDIO_WAVEFORM_PEAK_COUNT) => {
    const channelData = buffer.getChannelData(0);
    if (channelData.length === 0) return [];

    const blockSize = Math.max(1, Math.floor(channelData.length / peakCount));
    const peaks: number[] = [];
    let maxPeak = 0;

    for (let index = 0; index < peakCount; index += 1) {
      const start = index * blockSize;
      const end = Math.min(channelData.length, start + blockSize);
      let peak = 0;

      for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
        peak = Math.max(peak, Math.abs(channelData[sampleIndex] ?? 0));
      }

      peaks.push(peak);
      maxPeak = Math.max(maxPeak, peak);
    }

    if (maxPeak <= 0) {
      return peaks.map(() => 0.18);
    }

    return peaks.map((peak) => Math.max(0.12, peak / maxPeak));
  };

  const analyzeAudioSource = async (audioUrl: string, fallbackDuration: number) => {
    const context = audioManager.audioContextRef.current;
    if (!context) {
      return { audioSourceDuration: fallbackDuration, waveformPeaks: undefined as number[] | undefined };
    }

    try {
      const response = await fetch(audioUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await context.decodeAudioData(arrayBuffer.slice(0));
      return {
        audioSourceDuration: Number.isFinite(audioBuffer.duration) && audioBuffer.duration > 0
          ? audioBuffer.duration
          : fallbackDuration,
        waveformPeaks: buildWaveformPeaks(audioBuffer),
        lipSync: bakeLipSync(audioBuffer),
      };
    } catch (error) {
      console.warn("音频波形分析失败", error);
      return { audioSourceDuration: fallbackDuration, waveformPeaks: undefined as number[] | undefined };
    }
  };

  const resetTimelineDisplayCache = () => {
    activeSubtitleSignatureRef.current = "";
  };

  const findActiveClip = (clips: Clip[], timeSec: number): Clip | null => {
    for (let i = clips.length - 1; i >= 0; i -= 1) {
      const clip = clips[i];
      if (timeSec >= clip.start && timeSec < clip.start + clip.duration) {
        return clip;
      }
    }
    return null;
  };

  const syncSubtitleDisplayLayout = () => {
    const app = appRef.current;
    const subtitleContainer = subtitleContainerRef.current;
    const subtitleText = subtitleTextRef.current;
    if (!app || !subtitleContainer || !subtitleText) return;

    subtitleContainer.position.set(app.screen.width / 2, app.screen.height - 36);
    subtitleText.style.wordWrap = true;
    subtitleText.style.wordWrapWidth = Math.max(320, app.screen.width - 140);
  };

  const shouldRenderSubtitles = () => subtitleVisibilityOverrideRef.current ?? showSubtitles;

  const setModelVisibility = (visible: boolean) => {
    const currentModel = modelRef.current;
    if (!currentModel) return;

    if (Array.isArray(currentModel)) {
      if (groupContainerRef.current) {
        groupContainerRef.current.visible = visible;
        return;
      }

      currentModel.forEach((model) => {
        (model as unknown as PIXI.DisplayObject).visible = visible;
      });
      return;
    }

    (currentModel as unknown as PIXI.DisplayObject).visible = visible;
  };

  const getModelVisibilitySnapshot = (): boolean[] => {
    const currentModel = modelRef.current;
    if (!currentModel) return [];

    if (Array.isArray(currentModel)) {
      if (groupContainerRef.current) {
        return [groupContainerRef.current.visible];
      }
      return currentModel.map((model) => (model as unknown as PIXI.DisplayObject).visible);
    }

    return [(currentModel as unknown as PIXI.DisplayObject).visible];
  };

  const restoreModelVisibility = (snapshot: boolean[]) => {
    const currentModel = modelRef.current;
    if (!currentModel || snapshot.length === 0) return;

    if (Array.isArray(currentModel)) {
      if (groupContainerRef.current) {
        groupContainerRef.current.visible = snapshot[0];
        return;
      }

      currentModel.forEach((model, index) => {
        (model as unknown as PIXI.DisplayObject).visible = snapshot[index] ?? true;
      });
      return;
    }

    (currentModel as unknown as PIXI.DisplayObject).visible = snapshot[0];
  };

  const renderSubtitleClip = (clip: SubtitleClip | null) => {
    const subtitleContainer = subtitleContainerRef.current;
    const subtitleSpeakerText = subtitleSpeakerTextRef.current;
    const subtitleSpeakerUnderline = subtitleSpeakerUnderlineRef.current;
    const subtitleText = subtitleTextRef.current;
    if (!subtitleContainer || !subtitleSpeakerText || !subtitleSpeakerUnderline || !subtitleText) return;

    if (!shouldRenderSubtitles() || !clip || !clip.subtitleText.trim()) {
      subtitleContainer.visible = false;
      subtitleSpeakerText.text = "";
      subtitleText.text = "";
      subtitleSpeakerUnderline.clear();
      activeSubtitleSignatureRef.current = "";
      return;
    }

    const speakerName = clip.speakerName?.trim() || "";
    const shouldShowSpeaker = showSubtitleSpeaker && !!speakerName;

    const signature = [
      clip.id,
      shouldShowSpeaker ? speakerName : "",
      subtitleSpeakerAlign,
      clip.subtitleText,
      clip.fontFamily,
      clip.fontSize,
      clip.textColor,
    ].join("|");

    if (activeSubtitleSignatureRef.current === signature && subtitleContainer.visible) {
      return;
    }

    subtitleContainer.visible = true;
    subtitleText.text = clip.subtitleText;
    subtitleText.style = new PIXI.TextStyle({
      fontFamily: clip.fontFamily || DEFAULT_SUBTITLE_FONT_FAMILY,
      fontSize: Math.max(12, clip.fontSize || DEFAULT_SUBTITLE_FONT_SIZE),
      fontWeight: "700",
      fill: clip.textColor || DEFAULT_SUBTITLE_TEXT_COLOR,
      align: "center",
      stroke: "#081018",
      strokeThickness: 6,
      lineJoin: "round",
      dropShadow: true,
      dropShadowColor: "#000000",
      dropShadowBlur: 4,
      dropShadowDistance: 2,
      wordWrap: true,
      wordWrapWidth: Math.max(320, (appRef.current?.screen.width ?? 1280) - 140),
      breakWords: true,
    });

    subtitleText.position.set(0, 0);

    subtitleSpeakerText.text = shouldShowSpeaker ? speakerName : "";
    subtitleSpeakerText.style = new PIXI.TextStyle({
      fontFamily: clip.fontFamily || DEFAULT_SUBTITLE_FONT_FAMILY,
      fontSize: Math.max(14, Math.round((clip.fontSize || DEFAULT_SUBTITLE_FONT_SIZE) * 0.78)),
      fontWeight: "700",
      fill: clip.textColor || DEFAULT_SUBTITLE_TEXT_COLOR,
      align: "center",
      stroke: "#081018",
      strokeThickness: 4,
      lineJoin: "round",
      dropShadow: true,
      dropShadowColor: "#000000",
      dropShadowBlur: 3,
      dropShadowDistance: 1,
    });

    const subtitleBodyBounds = subtitleText.getLocalBounds();
    const subtitleBodyHeight = subtitleBodyBounds.height;
    subtitleSpeakerUnderline.clear();
    if (shouldShowSpeaker) {
      const speakerBounds = subtitleSpeakerText.getLocalBounds();
      const wrapWidth = Math.max(320, (appRef.current?.screen.width ?? 1280) - 140);
      const speakerOffset = Math.min(
        wrapWidth * 0.22,
        Math.max(96, (subtitleBodyBounds.width / 2) - 56),
      );
      const speakerX =
        subtitleSpeakerAlign === "left"
          ? -speakerOffset
          : subtitleSpeakerAlign === "right"
            ? speakerOffset
            : 0;
      subtitleSpeakerText.position.set(speakerX, -subtitleBodyHeight - 18);
      const underlineWidth = Math.max(56, speakerBounds.width + 8);
      const underlineY = subtitleSpeakerText.position.y + 8;
      subtitleSpeakerUnderline.lineStyle(2, 0x000000, 1);
      subtitleSpeakerUnderline.moveTo(speakerX - underlineWidth / 2, underlineY);
      subtitleSpeakerUnderline.lineTo(speakerX + underlineWidth / 2, underlineY);
    } else {
      subtitleSpeakerText.position.set(0, -subtitleBodyHeight);
    }

    activeSubtitleSignatureRef.current = signature;
    syncSubtitleDisplayLayout();
  };

  const clearTimeline = () => { 
    changeAnimation({ ...animationRef.current, groups: [], tracks: animationRef.current.tracks.map(t => ({...t, keys: [], animated: false})) });
    setMotionClips([]); 
    setExprClips([]); 
    setAudioClips([]); 
    setSubtitleClips([]);
    playheadRef.current = 0;
    playheadUiLastTsRef.current = null;
    setPlayhead(0); 
    resetTimelineDisplayCache();
    renderSubtitleClip(null);
    
    // ??????
    audioManager.cleanupAudio();
  };

  const changeClip = (track: TrackKind, id: string, patch: Partial<Pick<Clip, "start" | "duration">>) => {
    if (track === "motion") setMotionClips(prev => prev.map(c => (c.id === id ? { ...c, ...patch } : c)));
    else if (track === "expr") setExprClips(prev => prev.map(c => (c.id === id ? { ...c, ...patch } : c)));
    else if (track === "audio") {
      setAudioClips(prev => prev.map(c => (c.id === id ? { ...c, ...patch } : c)));
      setSubtitleClips(prev =>
        prev.map((clip) => (
          clip.linkedAudioClipId === id
            ? {
                ...clip,
                ...patch,
              }
            : clip
        )),
      );
    }
    else if (track === "subtitle") setSubtitleClips(prev => prev.map(c => (c.id === id ? { ...c, ...patch } : c)));
  };

  const addSubtitleClip = () => {
    const start = Math.max(timelineLength, nextEnd(subtitleClips));
    const duration = Math.max(0.5, exprDur || motionDur || 2);
    beginEdit();
    setSubtitleClips((prev) => [...prev, createSubtitleClip("新字幕", start, duration)]);
    endEdit(true);
  };

  const updateSubtitleClip = (
    id: string,
    patch: Partial<Pick<SubtitleClip, "subtitleText" | "speakerName" | "fontFamily" | "fontSize" | "textColor" | "start" | "duration">>,
  ) => {
    beginEdit();
    setSubtitleClips((prev) =>
      prev.map((clip) => {
        if (clip.id !== id) return clip;
        const nextText = typeof patch.subtitleText === "string" ? patch.subtitleText : clip.subtitleText;
        return {
          ...clip,
          ...patch,
          subtitleText: nextText,
          speakerName: typeof patch.speakerName === "string" ? patch.speakerName : clip.speakerName,
          name: buildSubtitleClipName(nextText),
          fontSize: Math.max(12, Number(patch.fontSize ?? clip.fontSize) || DEFAULT_SUBTITLE_FONT_SIZE),
          duration: Math.max(0.1, Number(patch.duration ?? clip.duration) || clip.duration),
          start: Math.max(0, Number(patch.start ?? clip.start) || 0),
        };
      }),
    );
    endEdit(true);
  };

  const removeSubtitleClip = (id: string) => {
    beginEdit();
    setSubtitleClips((prev) => prev.filter((clip) => clip.id !== id));
    endEdit(true);
  };

  const setPlayheadSec = (sec: number) => {
    playheadRef.current = sec;
    playheadUiLastTsRef.current = null;
    resetTimelineDisplayCache();
    setPlayhead(sec);
    applyTimelineAtTime(sec);
    if (appRef.current) appRef.current.renderer.render(appRef.current.stage);
  };

  // ????????????????????//
  const importAnimationClips = async (motions: Clip[], expressions: Clip[], base = animationRef.current) => {
    const adapters = rendererRef.current?.adapters ?? [];
    if (!adapters.length) throw new Error("请先加载模型，等待参数读取完成");
    return migrateLegacyClips(base, motions, expressions, async (name, kind) => {
      const matching = adapters.filter(adapter => {
        const data = readModelDataFromRuntime(adapter.model);
        return kind === 'motion' ? !!data?.motions[name] : data?.expressions.some(e => e.name === name);
      });
      return Promise.all(matching.map(async adapter => ({text: await adapter.material(name, kind), targets: adapter.tracks.map(t => t.definition.target)})));
    });
  };

  const prepareMaterial = async (name: string, kind: 'motion' | 'expression', start: number) => {
    const renderer = rendererRef.current;
    const adapters = renderer?.adapters.filter(a => {
      if (String(a.model.__characterId ?? 'main') !== selectedCharacterId) return false;
      const data = readModelDataFromRuntime(a.model);
      return kind === 'motion' ? !!data?.motions[name] : data?.expressions.some(e => e.name === name);
    }) ?? [];
    if (!adapters.length) throw new Error('当前角色中没有对应素材，请先加载模型');
    const materials = await Promise.all(adapters.map(async adapter => ({ adapter, text: await adapter.material(name, kind) })));
    if (rendererRef.current !== renderer) throw new Error('模型已改变，请重新导入素材');
    let next = animationRef.current;
    const oldIds = new Set(next.groups.map(g => g.id));
    for (const {adapter, text} of materials) next = importMaterial(next, next.tracks.filter(t => adapter.tracks.some(a => a.definition.target === t.definition.target)), text, kind, name, start);
    return combineSourceGroups(next, next.groups.filter(g => !oldIds.has(g.id)).map(g => g.id));
  };
  const addMaterial = async (name: string, kind: 'motion' | 'expression', start = playheadRef.current) => {
    if (!name) return;
    try {
      const next = await prepareMaterial(name, kind, start);
      stopPlayback();
      beginEdit(); changeAnimation(next); endEdit();
      if (kind === 'motion') setCurrentMotion(name); else setCurrentExpression(name);
    } catch (error) { showAlert(`导入失败：${error instanceof Error ? error.message : String(error)}`); }
  };
  const previewMaterial = async (name: string, kind: 'motion' | 'expression') => {
    try {
      stopPlayback();
      const start = playheadRef.current;
      const document = await prepareMaterial(name, kind, start);
      const duration = Math.max(0.1, ...document.groups.filter(g => !animationRef.current.groups.some(old => old.id === g.id)).map(g => g.duration));
      const started = performance.now();
      const frame = (now: number) => {
        const offset = Math.min(duration, (now-started)/1000);
        rendererRef.current?.seek(document, start+offset);
        if (appRef.current) appRef.current.renderer.render(appRef.current.stage);
        if (offset < duration) previewRafRef.current=requestAnimationFrame(frame);
        else { previewRafRef.current=null; applyTimelineAtTime(playheadRef.current); }
      };
      previewRafRef.current = requestAnimationFrame(frame);
    } catch (error) { showAlert(`预览失败：${error instanceof Error ? error.message : String(error)}`); }
  };
  const addMotionClip = (name: string) => addMaterial(name, 'motion');
  const addExprClip = (name: string) => addMaterial(name, 'expression');

  useEffect(() => {
    let cancelled = false;
    if (!modelData || !modelRef.current) return;
    const models = Array.isArray(modelRef.current) ? modelRef.current : [modelRef.current];
    void (async () => {
      try {
        const adapters = models.map((model, index) => new ModelAdapter(model, index));
        await Promise.all(adapters.map(adapter => adapter.metadata().catch(error => console.warn('参数名称读取失败', error))));
        if (cancelled) return;
        rendererRef.current = new TimelineRenderer(adapters);
        const current = animationRef.current;
        const tracks = adapters.flatMap(a => a.tracks).map(track => {
          const saved = current.tracks.find(t => t.definition.target === track.definition.target);
          return saved ? { ...saved, definition: track.definition } : track;
        });
        const targets = new Set(tracks.map(track => track.definition.target));
        const missing = current.tracks.filter(track => !targets.has(track.definition.target));
        // Keep unavailable channels in the project so a replacement model can repair them.
        let next = { ...current, tracks: [...tracks, ...missing] };
        setAnimationIssue(missing.length ? `当前模型缺少 ${missing.length} 个工程参数。关键帧已保留，请补充正确模型后重试。` : null);
        const migration = pendingMigrationRef.current;
        if (migration) {
          next = await importAnimationClips(migration.motions, migration.expressions, next);
          pendingMigrationRef.current = null;
          migrationFailedRef.current = false;
          setAnimationIssue(null);
          setMotionClips([]); setExprClips([]);
        }
        if (!cancelled) {
          changeAnimation(next);
          const restored = restoringProjectRef.current;
          if (restored) {
            characterTransformModeRef.current = restored.characterTransformMode;
            updateSelectedCharacterTransform(restored.characterTransform);
            setCustomRecordingBounds(restored.customRecordingBounds);
            setModelVisibility(restored.characterVisible);
            restoringProjectRef.current = null;
          }
        }
      } catch (error) {
        migrationFailedRef.current = true;
        setAnimationIssue(error instanceof Error ? error.message : String(error));
        showAlert(`参数时间线加载失败：${error instanceof Error ? error.message : String(error)}。旧片段已保留；重新选择模型可重试。`);
      }
    })();
    return () => { cancelled = true; };
  }, [modelData, projectRevision]);

  const registerAudioElement = (clipId: string, audioUrl: string) => {
    return audioManager.registerAudioElement(clipId, audioUrl);
  };

  const syncPreviewAudioAtTime = (timeSec: number) => {
    audioClips.forEach((clip) => {
      const audioElement = audioManager.audioRefs.current.get(clip.id);
      if (!audioElement) return;

      const audibleDuration = getAudioAudibleDuration(clip);
      const playbackCeiling = Math.max(0, audibleDuration - AUDIO_END_GUARD_SEC);
      if (audibleDuration <= 0) {
        if (!audioElement.paused) {
          audioElement.pause();
        }
        audioElement.currentTime = 0;
        return;
      }

      const clipOffset = timeSec - clip.start;
      if (!isPlayingRef.current) {
        audioElement.pause();
        audioElement.currentTime = Math.max(0, Math.min(clipOffset, playbackCeiling));
        return;
      }
      if (clipOffset >= 0 && clipOffset < playbackCeiling) {
        const playbackTime = Math.max(0, Math.min(clipOffset, playbackCeiling));
        if (audioElement.paused) {
          audioElement.currentTime = playbackTime;
          audioElement.play().catch((error) => {
            console.warn("音频播放失败", error);
          });
        } else if (Math.abs(audioElement.currentTime - playbackTime) > 0.25) {
          audioElement.currentTime = playbackTime;
        }
        return;
      }

      if (!audioElement.paused) {
        audioElement.pause();
      }
      audioElement.currentTime = 0;
    });
  };

  // ????????
  const addAudioClip = async () => {
    try {
      audioManager.initAudioContext();

      const picked = await open({
        multiple: false,
        filters: [{ name: "Audio", extensions: ["wav", "mp3", "ogg", "m4a"] }]
      });
      if (!picked) return;
      const audioPath = Array.isArray(picked) ? picked[0] : picked;
      if (!audioPath) return;

      const managedAudioPath = await storeAudioAsset(audioPath);
      const audioUrl = await buildExternalAssetUrl(await dirname(managedAudioPath), managedAudioPath);
      const audio = new Audio(audioUrl);
      audio.crossOrigin = "anonymous";
      await new Promise((resolve, reject) => {
        audio.onloadedmetadata = resolve;
        audio.onerror = reject;
        audio.load();
      });

      const duration = audio.duration;
      if (duration <= 0) {
        showAlert("音频加载失败");
        return;
      }

      const fileName = audioPath.split(/[\\/]/).pop() ?? "audio";
      const clipName = fileName.replace(/\.[^/.]+$/, '');

      const audioClip: Clip = {
        id: crypto.randomUUID(),
        name: clipName,
        start: nextEnd(audioClips),
        duration,
        audioSourceDuration: duration,
        audioUrl,
        audioPath: managedAudioPath
      };

      const audioMeta = await analyzeAudioSource(audioUrl, duration);
      audioClip.audioSourceDuration = audioMeta.audioSourceDuration;
      audioClip.waveformPeaks = audioMeta.waveformPeaks;
      audioClip.lipSync = audioMeta.lipSync;

      registerAudioElement(audioClip.id, audioUrl);

      beginEdit();
      setAudioClips(prev => [...prev, audioClip]);
      endEdit(true);
    } catch (error) {
      console.error('音频加载失败:', error);
      showAlert("音频加载失败: " + String(error));
    }
  };

  const timelineLength = Math.max(nextEnd(motionClips), nextEnd(exprClips), nextEnd(audioClips), nextEnd(subtitleClips), animationEnd(animation), 0);

  useEffect(() => {
    if (!projectHydrated) return;
    for (const clip of audioClips) {
      if (clip.audioUrl && !audioManager.audioRefs.current.has(clip.id)) {
        registerAudioElement(clip.id, clip.audioUrl);
      }
    }
  }, [projectHydrated, audioClips]);

  const applyTimelineAtTime = (t: number, offline: boolean = false, document = animationRef.current) => {
    const lipAt = (time: number) => Math.max(0, ...audioClips.map(clip => {
      const offset = time - clip.start;
      return offset >= 0 && offset < getAudioAudibleDuration(clip) ? (clip.lipSync?.[Math.floor(offset * 120)] ?? 0) : 0;
    }));
    rendererRef.current?.seek(document, t, lipAt, audioClips);
    setCurrentAudioLevel(lipAt(t) * 100);
    renderSubtitleClip(findActiveClip(subtitleClips, t) as SubtitleClip | null);

    if (!offline) {
      syncPreviewAudioAtTime(t);

    }
  };

  useEffect(() => {
    if (!isPlaying && rendererRef.current) {
      applyTimelineAtTime(playheadRef.current);
      if (appRef.current) appRef.current.renderer.render(appRef.current.stage);
    }
  }, [animation, audioClips]);

  const setRendererBackgroundMode = (renderer: RendererWithBackground, transparent: boolean) => {
    if (transparent) {
      renderer.backgroundColor = 0x00000000;
      renderer.backgroundAlpha = 0;
      renderer.clearBeforeRender = true;
      renderer.gl?.clearColor(0, 0, 0, 0);
      return;
    }

    renderer.backgroundColor = 0xf0f0f0;
    renderer.backgroundAlpha = 1;
    renderer.clearBeforeRender = false;
  };

  const syncPlayheadUi = (nextPlayhead: number, ts: number, force: boolean = false) => {
    playheadRef.current = nextPlayhead;

    if (!force) {
      const lastUiTs = playheadUiLastTsRef.current;
      if (lastUiTs != null && ts - lastUiTs < PLAYHEAD_UI_INTERVAL_MS) {
        return;
      }
    }

    playheadUiLastTsRef.current = ts;
    startTransition(() => {
      setPlayhead(nextPlayhead);
    });
  };

  const tick = (ts: number) => {
    if (startTsRef.current == null) startTsRef.current = ts;
    const t = Math.min(timelineLength, (ts - startTsRef.current) / 1000);
    syncPlayheadUi(t, ts);

    applyTimelineAtTime(t);

    if (t >= timelineLength) {
      syncPlayheadUi(timelineLength, ts, true);
      stopPlayback();
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
  };

  const startPlayback = () => {
    if (isPlaying || timelineLength <= 0) return;
    if (previewRafRef.current != null) cancelAnimationFrame(previewRafRef.current);
    previewRafRef.current = null;
    if (playheadRef.current >= timelineLength) playheadRef.current = 0;
    playheadUiLastTsRef.current = null;
    isPlayingRef.current = true;
    setIsPlaying(true);
    startTsRef.current = performance.now() - playheadRef.current * 1000;
    rafRef.current = requestAnimationFrame(tick);
  };

  const stopPlayback = () => {
    if (previewRafRef.current != null) cancelAnimationFrame(previewRafRef.current);
    previewRafRef.current = null;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    startTsRef.current = null;
    playheadUiLastTsRef.current = null;
    resetTimelineDisplayCache();
    isPlayingRef.current = false;
    setIsPlaying(false);
    setPlayhead(playheadRef.current);

    // Stop audio
    audioManager.stopAllAudio();
  };

  // ???????? FPS????????????????????? Live2D Control
  useEffect(() => {
    let disposed = false;

    const fpsTick = (ts: number) => {
      if (disposed) return;
      if (fpsLastTsRef.current == null) fpsLastTsRef.current = ts;

      fpsFrameCountRef.current += 1;
      const elapsed = ts - fpsLastTsRef.current;

      if (elapsed >= 500) {
        const fps = (fpsFrameCountRef.current * 1000) / elapsed;
        setCurrentFps(Math.max(0, Math.min(240, fps)));
        fpsFrameCountRef.current = 0;
        fpsLastTsRef.current = ts;
      }

      fpsRafRef.current = requestAnimationFrame(fpsTick);
    };

    fpsRafRef.current = requestAnimationFrame(fpsTick);
    return () => {
      disposed = true;
      if (fpsRafRef.current) cancelAnimationFrame(fpsRafRef.current);
      fpsRafRef.current = null;
      fpsFrameCountRef.current = 0;
      fpsLastTsRef.current = null;
      setCurrentFps(0);
    };
  }, []);

  const formatSrtTimestamp = (timeSec: number) => {
    const totalMs = Math.max(0, Math.round(timeSec * 1000));
    const hours = Math.floor(totalMs / 3_600_000);
    const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
    const seconds = Math.floor((totalMs % 60_000) / 1000);
    const millis = totalMs % 1000;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
  };

  const exportSubtitlesSrt = async () => {
    const entries = [...subtitleClips]
      .filter((clip) => clip.subtitleText.trim())
      .sort((left, right) => left.start - right.start);

    if (entries.length === 0) {
      showAlert("当前没有可导出的字幕");
      return;
    }

    const out = await save({
      defaultPath: "subtitles.srt",
      filters: [{ name: "SRT", extensions: ["srt"] }],
    });
    if (!out) return;

    const content = entries
      .map((clip, index) => [
        String(index + 1),
        `${formatSrtTimestamp(clip.start)} --> ${formatSrtTimestamp(clip.start + clip.duration)}`,
        clip.subtitleText.trim(),
        "",
      ].join("\n"))
      .join("\n");

    await writeFile(out, new TextEncoder().encode(content));
  };

  const exportVideo = async (
    format: VideoExportFormat,
    mode: VideoExportMode,
    includeAudio: boolean,
  ) => {
    if (!canvasRef.current || !appRef.current) return;
    if (exportState === "exporting") return;

    if (mode === "subtitle-only" && subtitleClips.length === 0) {
      showAlert("当前没有可导出的字幕轨内容");
      return;
    }

    const totalDuration = Math.max(
      timelineLength,
      motionClips.reduce((t, c) => Math.max(t, c.start + c.duration), 0),
      exprClips.reduce((t, c) => Math.max(t, c.start + c.duration), 0),
      audioClips.reduce((t, c) => Math.max(t, c.start + c.duration), 0),
      subtitleClips.reduce((t, c) => Math.max(t, c.start + c.duration), 0),
      0
    );

    if (totalDuration <= 0) {
      showAlert("时间线为空，无法导出");
      return;
    }

    const qualitySettings = {
      low: { fps: 24 },
      medium: { fps: 30 },
      high: { fps: 60 }
    };
    const settings = qualitySettings[recordingQuality];
    const targetFrames = Math.max(1, Math.ceil(totalDuration * settings.fps));

    const blobOnlyAudio = includeAudio
      ? audioClips.filter(c => c.audioUrl && !c.audioPath && /^blob:/i.test(c.audioUrl))
      : [];
    if (blobOnlyAudio.length > 0) {
      showAlert(`有 ${blobOnlyAudio.length} 条临时音频无法导出，请重新导入音频文件`);
      return;
    }

    const baseName = mode === "subtitle-only" ? "subtitles-only" : mode === "live2d-only" ? "live2d-only" : "export";
    let selectedPath: string | null;
    try {
      selectedPath = await save({
        defaultPath: `${baseName}.${format}`,
        filters: [{ name: format === "webm" ? "WebM" : "MOV", extensions: [format] }],
      });
    } catch (error) {
      showAlert("无法选择导出位置: " + String(error));
      return;
    }
    if (!selectedPath) return;
    const hasExtension = /\.[^./\\]+$/.test(selectedPath);
    const outputPath = hasExtension
      ? selectedPath.replace(/\.[^./\\]+$/, `.${format}`)
      : `${selectedPath}.${format}`;

    const hasValidBounds = customRecordingBounds && customRecordingBounds.width > 0 && customRecordingBounds.height > 0;
    const shouldUseModelFrame = hasValidBounds && useModelFrame;
    let exportCanvas: HTMLCanvasElement = canvasRef.current;
    let exportCtx: CanvasRenderingContext2D | null = null;
    if (shouldUseModelFrame) {
      exportCanvas = document.createElement('canvas');
      exportCanvas.width = customRecordingBounds.width;
      exportCanvas.height = customRecordingBounds.height;
      exportCtx = exportCanvas.getContext('2d');
    }

    const exportAnimation = structuredClone(animationRef.current);
    setExportState('exporting');
    setExportTime(0);
    setExportProgress(0);
    stopPlayback();

    const app = appRef.current;
    const wasTickerStarted = app.ticker.started;
    app.ticker.stop();
    let prepInterval: number | null = null;
    let firstFrame = false;
    const prepStart = Date.now();

    let lastExportProgressUiTs = 0;
    const previousModelVisibility = getModelVisibilitySnapshot();
    const previousSubtitleOverride = subtitleVisibilityOverrideRef.current;

    if (mode === "subtitle-only") {
      setModelVisibility(false);
      subtitleVisibilityOverrideRef.current = true;
    } else if (mode === "live2d-only") {
      setModelVisibility(true);
      subtitleVisibilityOverrideRef.current = false;
    } else {
      setModelVisibility(true);
      subtitleVisibilityOverrideRef.current = null;
    }
    renderSubtitleClip(findActiveClip(subtitleClips, playheadRef.current) as SubtitleClip | null);

    const updateExportUi = (timeSec: number, progressPct: number, force: boolean = false) => {
      const now = performance.now();
      if (!force && now - lastExportProgressUiTs < EXPORT_PROGRESS_UI_INTERVAL_MS) {
        return;
      }
      lastExportProgressUiTs = now;
      startTransition(() => {
        setExportTime(timeSec);
        setExportProgress(progressPct);
      });
    };

    try {
      prepInterval = window.setInterval(() => {
        if (firstFrame) return;
        const elapsed = (Date.now() - prepStart) / 1000;
        const pct = Math.min(0.05, elapsed * 0.2);
        updateExportUi(elapsed, pct * 100);
      }, 100);
      await runVideoExport({
        canvas: exportCanvas,
        outputPath,
        format,
        fps: settings.fps,
        targetFrameCount: targetFrames,
        applyTimelineAtTime: (timeSec) => applyTimelineAtTime(timeSec, true, exportAnimation),
        renderFrame: () => {
          app.renderer.render(app.stage);
          if (exportCtx) {
            if (transparentBg) {
              exportCtx.clearRect(0, 0, exportCanvas.width, exportCanvas.height);
            }
            exportCtx.drawImage(
              canvasRef.current!,
              customRecordingBounds.x,
              customRecordingBounds.y,
              customRecordingBounds.width,
              customRecordingBounds.height,
              0,
              0,
              exportCanvas.width,
              exportCanvas.height
            );
          }
        },
        audioTracks: audioClips.map(c => ({
          id: c.id,
          start: c.start,
          duration: c.duration,
          sourceDuration: c.audioSourceDuration,
          audioUrl: c.audioUrl,
          audioPath: c.audioPath
        })),
        includeAudio,
        onProgress: ({ frameIndex, totalFrames, timeSec }) => {
          if (!firstFrame) {
            firstFrame = true;
            if (prepInterval) { clearInterval(prepInterval); prepInterval = null; }
          }
          updateExportUi(
            timeSec,
            Math.min(85, (frameIndex / totalFrames) * 85),
            frameIndex >= totalFrames,
          );
        }
      });

      setExportState('done');
      setExportTime(0);
      setExportProgress(0);
    } catch (error) {
      console.error('视频导出失败:', error);
      showAlert("视频导出失败: " + String(error));
      setExportState('idle');
      setExportTime(0);
      setExportProgress(0);
    } finally {
      restoreModelVisibility(previousModelVisibility);
      subtitleVisibilityOverrideRef.current = previousSubtitleOverride;
      renderSubtitleClip(findActiveClip(subtitleClips, playheadRef.current) as SubtitleClip | null);
      if (prepInterval) { clearInterval(prepInterval); prepInterval = null; }
      applyTimelineAtTime(playheadRef.current, true);
      app.renderer.render(app.stage);
      if (wasTickerStarted) app.ticker.start();
    }
  };

  const screenshotManager = ScreenshotManager({ canvasRef, modelRef, showAlert });

  // WebGAL 导入流程暂时停用，保留代码便于恢复。
  //   // ??WebGAL??????
  //   const exitWebGALMode = () => {
  //     try {
  //
  //       // ??WebGAL??????
  //       if (modelManager) {
  //         modelManager.cleanupCurrentModel();
  //       }
  //
  //
  //       // ??????
  //       clearTimeline();
  //       setExternalModelDisplayName(null);
  //
  //
  //     } catch (error) {
  //       console.warn('?? ??WebGAL????????', error);
  //     }
  //   };
  //
  //   const createImportedAudioElement = (clipId: string, audioUrl: string) => registerAudioElement(clipId, audioUrl);
  //
  //   const buildImportedAudioName = (speaker?: string, text?: string) => {
  //     const trimmedText = (text ?? "").trim();
  //     if (!trimmedText) {
  //       return speaker ? `${speaker} 语音` : "WebGAL 语音";
  //     }
  //     const previewText = trimmedText.length > 18 ? `${trimmedText.slice(0, 18)}...` : trimmedText;
  //     return speaker ? `${speaker}: ${previewText}` : previewText;
  //   };
  //
  //   // ??WebGAL????
  //   const importWebGALTimeline = async (plan: WebGALImportPlan) => {
  //     try {
  //       if (!appRef.current) {
  //         throw new Error("PIXI 预览器尚未初始化");
  //       }
  //
  //       stopPlayback();
  //       importingTimelineRef.current = true;
  //       audioManager.initAudioContext();
  //
  //       const absoluteFigurePath = await resolveFigureAbsolutePath(plan.projectRoot, plan.selectedFigurePath);
  //       const figureUrl = await buildWebGALExternalAssetUrl(plan.projectRoot, absoluteFigurePath);
  //
  //       if (modelManager) {
  //         modelManager.cleanupCurrentModel();
  //       }
  //
  //       setModelData(null);
  //       setMotionLen({});
  //       setCurrentMotion("");
  //       setCurrentExpression("default");
  //       setCustomRecordingBounds({ x: 0, y: 0, width: 0, height: 0 });
  //
  //       externalModelPathRef.current = absoluteFigurePath;
  //       skipNextModelLoadRef.current = figureUrl !== modelUrl;
  //       setExternalModelUrl(figureUrl);
  //       await modelManager.loadAnyModel(appRef.current, figureUrl);
  //
  //       const importedMotionDurations: MotionLenMap = await loadWebGALMotionDurations(absoluteFigurePath).catch(
  //         () => ({} as MotionLenMap),
  //       );
  //       setMotionLen(importedMotionDurations);
  //
  //       const nextMotionClips: Clip[] = [];
  //       const nextExprClips: Clip[] = [];
  //       const nextAudioClips: Clip[] = [];
  //       const nextSubtitleClips: SubtitleClip[] = [];
  //       let timelineCursor = 0;
  //
  //       for (const group of plan.groups) {
  //         const baseDuration =
  //           group.audioDurationSec ??
  //           (group.motion ? importedMotionDurations[group.motion] : undefined) ??
  //           (group.motion ? motionLen[group.motion] : undefined) ??
  //           motionDur ??
  //           exprDur;
  //         const duration = plan.extendClipToSpokenSpan
  //           ? (group.durationHintSec ?? baseDuration)
  //           : baseDuration;
  //         const subtitleDuration =
  //           group.audioDurationSec ??
  //           baseDuration;
  //
  //         if (group.motion) {
  //           nextMotionClips.push({
  //             id: crypto.randomUUID(),
  //             name: group.motion,
  //             start: timelineCursor,
  //             duration,
  //           });
  //         }
  //
  //         if (group.expression) {
  //           nextExprClips.push({
  //             id: crypto.randomUUID(),
  //             name: group.expression,
  //             start: timelineCursor,
  //             duration,
  //           });
  //         }
  //
  //         let linkedAudioClipId: string | undefined;
  //
  //         if (group.audioAbsolutePath) {
  //           const clipId = crypto.randomUUID();
  //           const managedAudioPath = await storeAudioAsset(group.audioAbsolutePath);
  //           const audioUrl = await buildWebGALExternalAssetUrl(await dirname(managedAudioPath), managedAudioPath);
  //           createImportedAudioElement(clipId, audioUrl);
  //           const audioMeta = await analyzeAudioSource(audioUrl, group.audioDurationSec ?? duration);
  //           nextAudioClips.push({
  //             id: clipId,
  //             name: buildImportedAudioName(group.speaker, group.text),
  //             start: timelineCursor,
  //             duration,
  //             audioSourceDuration: audioMeta.audioSourceDuration,
  //             audioUrl,
  //             audioPath: managedAudioPath,
  //             waveformPeaks: audioMeta.waveformPeaks,
  //             lipSync: audioMeta.lipSync,
  //           });
  //           linkedAudioClipId = clipId;
  //         }
  //
  //         if (plan.includeSubtitles && group.text?.trim()) {
  //           nextSubtitleClips.push(
  //             createSubtitleClip(group.text.trim(), timelineCursor, subtitleDuration, {
  //               linkedAudioClipId,
  //               speakerName: group.speaker,
  //             }),
  //           );
  //         }
  //
  //         timelineCursor += duration;
  //       }
  //
  //       const adapters = (Array.isArray(modelRef.current) ? modelRef.current : [modelRef.current]).filter(Boolean).map((model, index) => new ModelAdapter(model, index));
  //       rendererRef.current = new TimelineRenderer(adapters);
  //       const converted = await importAnimationClips(nextMotionClips, nextExprClips, { ...emptyAnimation(), tracks: adapters.flatMap(a => a.tracks) });
  //       beginEdit();
  //       changeAnimation(converted);
  //       setMotionClips([]);
  //       setExprClips([]);
  //       setAudioClips(nextAudioClips);
  //       setSubtitleClips(nextSubtitleClips);
  //       endEdit(true);
  //       setExternalModelDisplayName(`${plan.selectedRoleLabel} · ${plan.selectedFigurePath}`);
  //       playheadRef.current = 0;
  //       playheadUiLastTsRef.current = null;
  //       setPlayhead(0);
  //       resetTimelineDisplayCache();
  //       requestAnimationFrame(() => {
  //         if (modelRef.current && !Array.isArray(modelRef.current)) {
  //           syncSingleModelTransformState("center");
  //         } else {
  //           refreshCharacterEditor();
  //         }
  //       });
  //     } catch (error) {
  //       console.error("WebGAL 导入失败", error);
  //       showAlert(`导入失败: ${error instanceof Error ? error.message : String(error)}`);
  //     } finally {
  //       importingTimelineRef.current = false;
  //       setProjectRevision(revision => revision + 1);
  //     }
  //   };
  //
  //
  useEffect(() => {
    (async () => {
      try {
        // ??Rust????http://127.0.0.1:PORT/model
        const { base_url, models_dir } = await invoke<{base_url: string, models_dir: string}>("get_model_server_info");
        setAssetBase(base_url);
        setModelRoot(models_dir);
        setModelPackages(await loadModelPackages());
      } catch (e) {
        console.error("????????????", e);
        setAssetBase(null);
      }
    })();
  }, []);

  // ??????
  const loadModelList = async () => {
    if (!assetBase) return;
    try {
      const res = await fetch(`${assetBase}/models.json`, { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const arr = (await res.json()) as string[];
      setModelList(arr);
      setSelectedModel(prev => prev ?? (externalModelPathRef.current ? null : arr[0] ?? null));
    } catch (e) {
      console.warn("读取模型库索引失败", e);
      setModelList([]);
      setSelectedModel(null);
    }
  };

  useEffect(() => {
    loadModelList();
  }, [assetBase]);

  useEffect(() => {
    if (!projectHydrated || modelList.length === 0 || externalModelPathRef.current) return;

    if (!selectedModel) {
      setSelectedModel(modelList[0]);
    }
  }, [projectHydrated, modelList, selectedModel]);

  // ??????
  const refreshModels = async () => {
    try {
      const newModelList = await invoke<string[]>("refresh_model_index");
      setModelList(newModelList);

    } catch (e) {
      console.error("????????:", e);
    }
  };

  const importModel = async (pickFolder = false) => {
    if (!modelRoot) {
      showAlert("模型库尚未初始化，请稍后再试。");
      return;
    }
    setIsImportingModel(true);
    try {
      const selectedPath = await invoke<string | null>("pick_model_source", { directory: pickFolder });
      if (typeof selectedPath !== "string") return;
      const imported = await importModelSource(selectedPath, modelRoot);
      const nextModelList = await invoke<string[]>("refresh_model_index");
      const importedPaths = nextModelList.filter((path) => path.startsWith(`${imported.id}/`));
      if (importedPaths.length === 0) {
        await remove(await join(modelRoot, imported.id), { recursive: true });
        throw new Error("未在所选资源中发现有效的 Live2D 模型配置文件。请导入包含 .model.json、.model3.json 或 .jsonl 的文件夹/压缩包。");
      }
      const nextPackages = [...modelPackages, { ...imported, modelPaths: importedPaths }];
      await saveModelPackages(nextPackages);
      setModelPackages(nextPackages);
      setModelList(nextModelList);
      setSelectedModel(importedPaths[0]);
    } catch (error) {
      console.error("导入模型失败", error);
      showAlert(`导入失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsImportingModel(false);
    }
  };

  const deleteModelPackage = async (id: string) => {
    const target = modelPackages.find((item) => item.id === id);
    if (!target || !modelRoot) return;
    if (!window.confirm(`确定从模型库移除“${target.name}”及其资源吗？`)) return;
    try {
      await remove(await join(modelRoot, id), { recursive: true });
      const nextPackages = modelPackages.filter((item) => item.id !== id);
      await saveModelPackages(nextPackages);
      setModelPackages(nextPackages);
      const nextModelList = await invoke<string[]>("refresh_model_index");
      setModelList(nextModelList);
      if (selectedModel && target.modelPaths.includes(selectedModel)) {
        setSelectedModel(nextModelList[0] ?? null);
      }
    } catch (error) {
      showAlert(`移除模型失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const makeProjectSnapshot = (): ProjectSnapshot => ({
    version: migrationFailedRef.current || pendingMigrationRef.current ? 1 : 2,
    animation: animationRef.current,
    savedAt: new Date().toISOString(),
    selectedModel,
    externalModelPath: externalModelPathRef.current ?? undefined,
    selectedCharacterId,
    motionClips,
    exprClips,
    audioClips: audioClips.map(stripRuntimeAudio),
    subtitleClips: subtitleClips.map(stripRuntimeAudio),
    showSubtitles,
    showSubtitleSpeaker,
    subtitleSpeakerAlign,
    playhead: playheadRef.current,
    motionDur,
    exprDur,
    characterVisible: isCharacterVisible,
    characterTransformMode,
    characterTransform,
    recordingQuality,
    transparentBg,
    customRecordingBounds,
  });

  const applyProjectSnapshot = async (snapshot: ProjectSnapshot) => {
    audioManager.initAudioContext();
    const restoredAudio = await Promise.all(snapshot.audioClips.map(async (clip) => {
      let audioUrl: string | undefined;
      if (clip.audioPath) {
        try {
          audioUrl = await buildExternalAssetUrl(await dirname(clip.audioPath), clip.audioPath);
        } catch (error) {
          console.warn(`恢复音频“${clip.name}”失败`, error);
        }
      }
      const analysis = audioUrl && !clip.lipSync ? await analyzeAudioSource(audioUrl, clip.duration) : {};
      return { ...clip, ...analysis, audioUrl };
    }));
    restoringProjectRef.current = snapshot;
    externalModelPathRef.current = snapshot.externalModelPath ?? null;
    pendingMigrationRef.current = snapshot.version === 1 ? { motions: snapshot.motionClips, expressions: snapshot.exprClips } : null;
    migrationFailedRef.current = false;
    changeAnimation(snapshot.animation ?? emptyAnimation());
    rendererRef.current?.invalidate();
    resetHistory();
    if (snapshot.externalModelPath) {
      try { setExternalModelUrl(await buildExternalAssetUrl(await dirname(snapshot.externalModelPath), snapshot.externalModelPath)); }
      catch (error) { showAlert(`缺失工程模型：${snapshot.externalModelPath}。请从模型库重新导入。${String(error)}`); }
    } else setExternalModelUrl(null);
    setSelectedModel(snapshot.selectedModel);
    if (snapshot.selectedModel === selectedModel && !snapshot.externalModelPath) setProjectRevision(revision => revision + 1);
    setSelectedCharacterId(snapshot.selectedCharacterId);
    setMotionClips(snapshot.motionClips);
    setExprClips(snapshot.exprClips);
    setAudioClips(restoredAudio);
    setSubtitleClips(snapshot.subtitleClips);
    setShowSubtitles(snapshot.showSubtitles);
    setShowSubtitleSpeaker(snapshot.showSubtitleSpeaker);
    setSubtitleSpeakerAlign(snapshot.subtitleSpeakerAlign);
    setMotionDur(snapshot.motionDur);
    setExprDur(snapshot.exprDur);
    setIsCharacterVisible(snapshot.characterVisible);
    characterTransformModeRef.current = snapshot.characterTransformMode;
    setCharacterTransformMode(snapshot.characterTransformMode);
    characterTransformRef.current = snapshot.characterTransform;
    setCharacterTransform(snapshot.characterTransform);
    setRecordingQuality(snapshot.recordingQuality);
    setTransparentBg(snapshot.transparentBg);
    setCustomRecordingBounds(snapshot.customRecordingBounds);
    setPlayheadSec(snapshot.playhead);
    setCurrentMotion("");
    setCurrentExpression("default");
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const snapshot = await loadAutosaveProject();
        if (snapshot && !cancelled) {
          await applyProjectSnapshot(snapshot);
          if (snapshot.savedAt) setLastAutosaveAt(new Date(snapshot.savedAt));
        }
      } catch (error) {
        console.warn("恢复自动保存工程失败", error);
      } finally {
        if (!cancelled) setProjectHydrated(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!projectHydrated) return;
    const snapshot = makeProjectSnapshot();
    const timer = window.setTimeout(() => {
      void saveAutosaveProject(snapshot)
        .then(() => setLastAutosaveAt(new Date()))
        .catch((error) => console.warn("自动保存工程失败", error));
    }, 900);
    return () => window.clearTimeout(timer);
  }, [
    projectHydrated,
    animation,
    selectedModel,
    selectedCharacterId,
    motionClips,
    exprClips,
    audioClips,
    subtitleClips,
    showSubtitles,
    showSubtitleSpeaker,
    subtitleSpeakerAlign,
    motionDur,
    exprDur,
    isCharacterVisible,
    characterTransformMode,
    characterTransform,
    recordingQuality,
    transparentBg,
    customRecordingBounds,
    isPlaying,
  ]);

  const saveWorkspaceProject = async () => {
    try {
      const path = await save({
        title: "保存 Live2D 工程",
        defaultPath: "Live2D 工程.l2dproject",
        filters: [{ name: "Live2D 工程", extensions: ["l2dproject"] }],
      });
      if (!path) return;
      await writeFile(path, await createProjectBundle(makeProjectSnapshot()));
      showAlert("工程已保存。工程包包含时间线和音频，模型仍引用本机模型库中的资源。");
    } catch (error) {
      showAlert(`保存工程失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const openWorkspaceProject = async () => {
    try {
      const path = await open({
        multiple: false,
        title: "打开 Live2D 工程",
        filters: [{ name: "Live2D 工程", extensions: ["l2dproject"] }],
      });
      if (typeof path !== "string") return;
      const snapshot = await openProjectBundle(path);
      await applyProjectSnapshot(snapshot);
      await saveAutosaveProject(snapshot);
      setLastAutosaveAt(new Date());

    } catch (error) {
      showAlert(`打开工程失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // ????PIXI?????
  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;

    const run = async () => {
      if (!containerRef.current) return;
      const host = containerRef.current;
      const initialWidth = Math.max(1, host.clientWidth);
      const initialHeight = Math.max(1, host.clientHeight);

      window.PIXI = PIXI;
      // ??? view?? PixiJS ?????? canvas??????? canvas ?? WebGL ???
      // ?? 0?? MAX_TEXTURE_IMAGE_UNITS????? checkMaxIfStatementsInShader ??
      const app = new PIXI.Application({
        backgroundAlpha: 0,
        preserveDrawingBuffer: true,
        antialias: true,
        width: initialWidth,
        height: initialHeight,
      });
      host.appendChild(app.view);
      (app.view as HTMLCanvasElement).className = "live2d-canvas";
      canvasRef.current = app.view as HTMLCanvasElement;
      appRef.current = app;
      app.stage.sortableChildren = true;

      const subtitleContainer = new PIXI.Container();
      subtitleContainer.visible = false;
      subtitleContainer.zIndex = 10_000;

      const subtitleSpeakerText = new PIXI.Text("", {
        fontFamily: DEFAULT_SUBTITLE_FONT_FAMILY,
        fontSize: Math.round(DEFAULT_SUBTITLE_FONT_SIZE * 0.78),
        fontWeight: "700",
        fill: DEFAULT_SUBTITLE_TEXT_COLOR,
        align: "center",
        stroke: "#081018",
        strokeThickness: 4,
        lineJoin: "round",
      });
      subtitleSpeakerText.anchor.set(0.5, 1);

      const subtitleSpeakerUnderline = new PIXI.Graphics();

      const subtitleText = new PIXI.Text("", {
        fontFamily: DEFAULT_SUBTITLE_FONT_FAMILY,
        fontSize: DEFAULT_SUBTITLE_FONT_SIZE,
        fontWeight: "700",
        fill: DEFAULT_SUBTITLE_TEXT_COLOR,
        align: "center",
        stroke: "#081018",
        strokeThickness: 6,
        lineJoin: "round",
        wordWrap: true,
        wordWrapWidth: Math.max(320, app.screen.width - 140),
      });
      subtitleText.anchor.set(0.5, 1);
      subtitleContainer.addChild(subtitleSpeakerText);
      subtitleContainer.addChild(subtitleSpeakerUnderline);
      subtitleContainer.addChild(subtitleText);
      app.stage.addChild(subtitleContainer);
      subtitleContainerRef.current = subtitleContainer;
      subtitleSpeakerTextRef.current = subtitleSpeakerText;
      subtitleSpeakerUnderlineRef.current = subtitleSpeakerUnderline;
      subtitleTextRef.current = subtitleText;
      syncSubtitleDisplayLayout();

      setRendererBackgroundMode(app.renderer as RendererWithBackground, transparentBg);

      // ????????????
      if (modelUrl) {
        try { await modelManager.loadAnyModel(app, modelUrl); }
        catch (error) { setAnimationIssue(`模型加载失败：${String(error)}。请补充模型后重试。`); }
        if (disposed) return;
        if (modelRef.current && !Array.isArray(modelRef.current)) {
          syncSingleModelTransformState("center");
        } else {
          refreshCharacterEditor();
        }
      }

      resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry || !appRef.current) return;
        const width = Math.max(1, Math.round(entry.contentRect.width));
        const height = Math.max(1, Math.round(entry.contentRect.height));
        appRef.current.renderer.resize(width, height);
        if (modelRef.current && !Array.isArray(modelRef.current)) {
          syncSingleModelAbsoluteTransform();
          syncSingleModelTransformState("preserve");
        } else {
          requestAnimationFrame(() => refreshCharacterEditor());
        }
        syncSubtitleDisplayLayout();
        syncRecordingBoundsFromCurrentModel();
      });
      resizeObserver.observe(host);

      requestAnimationFrame(() => {
        if (disposed) return;
        if (modelRef.current && !Array.isArray(modelRef.current)) {
          syncSingleModelTransformState("center");
        } else {
          refreshCharacterEditor();
        }
        syncSubtitleDisplayLayout();
        syncRecordingBoundsFromCurrentModel();
      });
    };

    run();

    return () => {
      disposed = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (previewRafRef.current != null) cancelAnimationFrame(previewRafRef.current);
      rendererRef.current = null;
      resizeObserver?.disconnect();
      canvasRef.current = null;
      if (appRef.current) {
        try {
          appRef.current.destroy(true, { children: true, texture: true, baseTexture: true });
        } catch { /* 应用销毁失败不阻断清理 */ }
        appRef.current = null;
      }
      subtitleContainerRef.current = null;
      subtitleSpeakerTextRef.current = null;
      subtitleSpeakerUnderlineRef.current = null;
      subtitleTextRef.current = null;
      modelRef.current = null;
      groupContainerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // ???????

  // ??????????renderer
  useEffect(() => {
    if (appRef.current) {
      setRendererBackgroundMode(appRef.current.renderer as RendererWithBackground, transparentBg);
    }
  }, [transparentBg]);

  useEffect(() => {
    if (isPlaying) return;
    renderSubtitleClip(findActiveClip(subtitleClips, playhead) as SubtitleClip | null);
  }, [subtitleClips, playhead, isPlaying, showSubtitles, showSubtitleSpeaker, subtitleSpeakerAlign]);

  // ??????????
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // ????????????????
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      
      if (e.code === 'Space') {
        e.preventDefault(); // ??????
        if (isPlaying) {
          stopPlayback();
        } else {
          startPlayback();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPlaying]);

  useEffect(() => {
    characterTransformRef.current = characterTransform;
  }, [characterTransform]);

  useEffect(() => {
    refreshCharacterEditor();
  }, [selectedModel, selectedCharacterId, isDragging]);

  useEffect(() => {
    const handleWheelTransform = (event: WheelEvent) => {
      if (!enableDragging || !isDraggingRef.current) return;
      if (!event.ctrlKey && !event.altKey) return;
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement
      ) {
        return;
      }

      if (event.ctrlKey) {
        event.preventDefault();
        event.stopPropagation();
        updateUniformScale(event.deltaY > 0 ? 0.96 : 1.04);
        return;
      }

      if (event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        const current = characterTransformRef.current;
        updateSelectedCharacterTransform({ rotation: current.rotation + (event.deltaY > 0 ? 4 : -4) });
      }
    };

    const canvas = canvasRef.current;
    if (!canvas) return;
    const wheelListenerOptions: AddEventListenerOptions = { passive: false, capture: true };

    canvas.addEventListener("wheel", handleWheelTransform, wheelListenerOptions);
    return () => {
      canvas.removeEventListener("wheel", handleWheelTransform, wheelListenerOptions);
    };
  }, [enableDragging, modelUrl]);


  // ?????????????????
  useEffect(() => {
    (async () => {
      if (!appRef.current || !projectHydrated) return;
      if (skipNextModelLoadRef.current) { skipNextModelLoadRef.current = false; return; }
      if (!modelUrl) {
        setCharacterOptions([]);
        setSelectedCharacterId("main");
        setIsCharacterVisible(true);
        resetSingleCharacterTransformState();
        return;
      }

      // ??????????
      stopPlayback();
      const restoredProject = restoringProjectRef.current;
      if (!restoredProject && !animationIssue) { clearTimeline(); changeAnimation(emptyAnimation()); resetHistory(); }

      // ????????
        modelManager.cleanupCurrentModel();

      try { await modelManager.loadAnyModel(appRef.current, modelUrl); }
      catch (error) { setAnimationIssue(`模型加载失败：${String(error)}。请补充模型后重试。`); return; }
      requestAnimationFrame(() => {
        if (restoredProject) { updateSelectedCharacterTransform(restoredProject.characterTransform); return; }
        if (modelRef.current && !Array.isArray(modelRef.current)) {
          syncSingleModelTransformState("center");
        } else {
          refreshCharacterEditor();
        }
      });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelUrl, projectHydrated]);

  // ?? .mtn???????????????? & ?? URL ????????
  useEffect(() => {
    if (!modelData || (!modelUrl && !motionBaseRef.current)) return;
    let aborted = false;

    const baseFromUrl = (u: string) => u.slice(0, u.lastIndexOf("/") + 1);
    const base = motionBaseRef.current ?? (modelUrl ? baseFromUrl(modelUrl) : "");

    const resolveUrl = (rel: string) => {
      if (/^https?:\/\//i.test(rel)) return rel;
      if (rel.startsWith("/")) return rel;
      if (rel.startsWith("./")) rel = rel.slice(2);
      return base + rel;
    };

    (async () => {
      const entries = Object.entries(modelData.motions || {});
      const results = await Promise.all(
        entries.map(async ([group, arr]) => {
          const first = arr?.[0]?.file;
          if (!first || !/\.(?:mtn|motion3\.json)$/i.test(first)) return [group, undefined] as const;
          try {
            const txt = await (await fetch(resolveUrl(first))).text();
            return [group, parseMotionDurationSeconds(first, txt)] as const;
          } catch {
            return [group, undefined] as const;
          }
        })
      );
      if (aborted) return;
      setMotionLen(Object.fromEntries(results.filter(([, s]) => s != null) as [string, number][]));
    })();

    return () => { aborted = true; };
  }, [modelData, modelUrl]);

  const panelProps = {
    // onToggleWebGALMode: () => setShowWebGALMode(true),
    modelList,
    selectedModel,
    onSelectModel: (rel: string | null) => {
      setExternalModelDisplayName(null);
      externalModelPathRef.current = null;
      setExternalModelUrl(null);
      if (rel === selectedModel && pendingMigrationRef.current) setProjectRevision(revision => revision + 1);
      setSelectedModel(rel || null);
    },
    onRefreshModels: refreshModels,
    modelPackages,
    isImportingModel,
    onImportModel: () => void importModel(false),
    onImportModelFolder: () => void importModel(true),
    onDeleteModelPackage: (id: string) => void deleteModelPackage(id),
    onSaveProject: () => void saveWorkspaceProject(),
    onOpenProject: () => void openWorkspaceProject(),
    autosaveStatus: !projectHydrated
      ? "正在读取工程…"
      : lastAutosaveAt
        ? `已保存 ${lastAutosaveAt.toLocaleTimeString()}`
        : "自动恢复已启用",
    modelData,
    motionLen,
    currentMotion,
    currentExpression,
    motionDur,
    exprDur,
    setMotionDur,
    setExprDur,
    chooseMotion: (name: string) => {
      void previewMaterial(name, 'motion');
      setCurrentMotion(name);
    },
    chooseExpression: (name: string) => {
      void previewMaterial(name, 'expression');
      setCurrentExpression(name);
    },
    addMotionClip,
    addExprClip,
    addAudioClip,
    subtitleClips,
    showSubtitles,
    setShowSubtitles,
    showSubtitleSpeaker,
    setShowSubtitleSpeaker,
    subtitleSpeakerAlign,
    setSubtitleSpeakerAlign,
    onAddSubtitleClip: addSubtitleClip,
    onUpdateSubtitleClip: updateSubtitleClip,
    onRemoveSubtitleClip: removeSubtitleClip,
    characterOptions,
    selectedCharacterId,
    onSelectCharacter: setSelectedCharacterId,
    isCharacterVisible,
    onToggleCharacterVisibility: setSelectedCharacterVisibility,
    characterTransform,
    characterTransformMode,
    onUpdateCharacterTransform: updateSelectedCharacterTransform,
    enableDragging,
    setEnableDragging,
    isDragging,
    timelineLength,
    playhead,
    isPlaying,
    startPlayback,
    stopPlayback,
    clearTimeline,
    currentAudioLevel,
    currentFps,
    recordingQuality,
    setRecordingQuality,
    transparentBg,
    setTransparentBg,
    exportState,
    exportTime,
    exportProgress,
    onExportVideo: (format: VideoExportFormat, mode: VideoExportMode, includeAudio: boolean) => {
      void exportVideo(format, mode, includeAudio);
    },
    onExportSubtitlesSrt: exportSubtitlesSrt,
    onTakeScreenshot: () => screenshotManager.takeScreenshot(),
    onTakePartsScreenshots: () => screenshotManager.takePartsScreenshots(),
  };

  return (
    <div className="editor-shell">
      <header className="editor-topbar" inert={exportState === "exporting"}>
        <div className="editor-topbar-brand">
          <div className="editor-topbar-kicker">像素工坊 · LIVE2D MOVIE MAKER</div>
          <h1>Live2D 工作台</h1>
        </div>

        <div className="editor-topbar-main">
          <div className="topbar-select-group">
            <label className="topbar-label" htmlFor="topbar-model-select">
              模型
            </label>
            <select
              id="topbar-model-select"
              className="input input--topbar"
              value={selectedModel ?? ""}
              onChange={(event) => setSelectedModel(event.target.value || null)}
            >
              {modelList.length === 0 ? <option value="">未发现模型</option> : null}
              {selectedModel && !modelList.includes(selectedModel) && <option value={selectedModel}>{selectedModel.split('/').pop()}</option>}
              {modelList.map((rel) => (
                <option key={rel} value={rel}>
                  {rel}
                </option>
              ))}
            </select>
          </div>

          <div className="topbar-button-group">
            <button className="btn btn--quiet" onClick={refreshModels}>
              刷新
            </button>
            <button className="btn btn--accent" onClick={() => void importModel(false)} disabled={isImportingModel}>
              {isImportingModel ? "导入中…" : "＋ 导入模型"}
            </button>
            <button className={`btn ${isPlaying ? "btn--accent" : "btn--primary"}`} onClick={isPlaying ? stopPlayback : startPlayback} disabled={!timelineLength && !isPlaying}>
              {isPlaying ? "停止播放" : "开始播放"}
            </button>
            <button className="btn btn--quiet" onClick={addAudioClip}>
              导入音频
            </button>
            {/* WebGAL 入口暂时停用
            <button className="btn btn--quiet" onClick={() => setShowWebGALMode(true)}>
              WebGAL 工具
            </button>
            */}
          </div>
        </div>

      </header>

      <div className="editor-workspace">
        <aside className="workspace-dock workspace-dock--left" inert={exportState === "exporting"}>
          <ControlPanel
            {...panelProps}
            mode="resources"
          />
        </aside>

        <main className="editor-main" inert={exportState === "exporting"}>
          <section className="monitor-shell">
            <div className="monitor-stage">
              <div
                ref={containerRef}
                className={`monitor-canvas-host ${transparentBg ? "is-transparent" : "is-solid"}`}
                data-transparent={transparentBg}
              />

              {!selectedModel ? (
                <div className="monitor-empty">
                  <span className="monitor-empty-mark" aria-hidden="true">✦</span>
                  <strong>准备好你的第一个角色</strong>
                  <span>导入模型文件夹、ZIP 压缩包或模型配置文件，即可开始编排。</span>
                  <div className="monitor-empty-actions">
                    <button className="btn btn--accent" onClick={() => void importModel(false)} disabled={isImportingModel}>
                      选择模型文件 / ZIP
                    </button>
                    <button className="btn btn--quiet" onClick={() => void importModel(true)} disabled={isImportingModel}>
                      选择模型文件夹
                    </button>
                  </div>
                </div>
              ) : null}

              <div className="monitor-overlay monitor-overlay--top">
                <span>预览器</span>
              </div>

              <div className="monitor-overlay monitor-overlay--bottom">
                <span>FPS {currentFps.toFixed(1)}</span>
                <span>播放头 {playhead.toFixed(2)} 秒</span>
                <span>{enableDragging ? "允许拖拽" : "拖拽关闭"}</span>
              </div>
            </div>
          </section>
        </main>

        <aside className="workspace-dock workspace-dock--right">
          <ControlPanel
            {...panelProps}
            mode="inspector"
            activeInspectorTab={activeInspectorTab}
            onChangeInspectorTab={setActiveInspectorTab}
          />
        </aside>
      </div>

      <section className="timeline-shell" inert={exportState === "exporting"}>
        {animationIssue && <div className="timeline-repair"><span>{animationIssue}</span><button className="btn btn--quiet" onClick={() => {
          if (modelData) setProjectRevision(revision => revision + 1);
          else if (appRef.current && modelUrl) void modelManager.loadAnyModel(appRef.current, modelUrl).catch(error => setAnimationIssue(`模型加载失败：${String(error)}`));
        }}>重试加载</button><button className="btn btn--quiet" onClick={() => void importModel(false)}>补充模型</button></div>}
        <Timeline
          onImportMaterial={(name, kind, start) => void addMaterial(name, kind, start)}
          animation={animation}
          onAnimationChange={changeAnimation}
          onBeginEdit={() => { stopPlayback(); beginEdit(); }}
          onEndEdit={endEdit}
          onUndo={undo}
          onRedo={redo}
          motionClips={motionClips}
          exprClips={exprClips}
          audioClips={audioClips}
          subtitleClips={subtitleClips}
          playheadSec={playhead}
          playheadSourceRef={playheadRef}
          onChangeClip={changeClip}
          onRemoveClip={(track, id) => {
            if (track === "motion") setMotionClips(prev => prev.filter(c => c.id !== id));
            else if (track === "expr") setExprClips(prev => prev.filter(c => c.id !== id));
            else if (track === "audio") {
              setAudioClips(prev => prev.filter(c => c.id !== id));
              setSubtitleClips(prev => prev.map((clip) => (
                clip.linkedAudioClipId === id
                  ? { ...clip, linkedAudioClipId: undefined }
                  : clip
              )));
              audioManager.unregisterAudioElement(id);
            } else if (track === "subtitle") {
              removeSubtitleClip(id);
            }
          }}
          onSetPlayhead={setPlayheadSec}
          onStartPlayback={startPlayback}
          onStopPlayback={stopPlayback}
          isPlaying={isPlaying}
        />
      </section>

      {/* WebGAL 导入窗口暂时停用
      {showWebGALMode && (
        <div className="editor-overlay">
          <WebGALMode
            onClose={() => setShowWebGALMode(false)}
            onImportTimeline={importWebGALTimeline}
            onExitWebGALMode={exitWebGALMode}
            defaultMotionDuration={motionDur}
            defaultExpressionDuration={exprDur}
          />
        </div>
      )}

      */}

      {alertMessage && (
        <AlertModal message={alertMessage} onClose={() => setAlertMessage(null)} />
      )}
    </div>
  );
}
