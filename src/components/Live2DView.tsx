// src/components/Live2DView.tsx
import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import * as PIXI from "pixi.js";
import { Live2DModel } from "pixi-live2d-display";
import { emptyAnimation } from '../animation/types';
import { combineSourceGroups, reconcileSourceEdits } from '../animation/engine';
import { exportAnimation, type AnimationExportOptions } from '../animation/exporters';
import { migrateLegacyClips } from '../animation/migration';
import { migrateLegacyProject } from '../sequence/migration';
import { ProjectHistory, sequenceDuration, updateClip, evaluateClipTransform } from '../sequence/engine';
import { SceneRuntime } from '../sequence/sceneRuntime';
import { getSceneLipAt } from '../sequence/sceneAudio';
import { resolveTextSchedule } from '../sequence/text';
import { materialSourceFromAsset, materialSourceToAsset, mergeMaterialAssets, parseMaterialSource, type MaterialSource } from '../sequence/materials';
import type { ProjectDocument } from '../sequence/types';
import type { ProjectAsset } from '../sequence/types';
import { syncLegacyMedia } from '../sequence/syncLegacy';
import { audioGainAt, resolveAudioSchedule } from '../sequence/audio';
import { readModelDataFromRuntime } from '../utils/modelData';
import { useTimelineDocument } from '../animation/useTimelineDocument';
import { bakeLipSync, importMaterial } from '../animation/importers';
import { ModelAdapter, TimelineRenderer } from '../animation/runtime';
import Timeline from "./timeline/Timeline";
import type { Clip, SubtitleClip } from "./timeline/clipTypes";
import { parseMotionDurationSeconds } from "../utils/motionDuration";
import "./Live2DView.css";
import "./pixel-theme.css";
import ControlPanel, { type InspectorTab } from "./panel/ControlPanel";
import AudioMeter from "./panel/AudioMeter";
import { editPropertiesAt } from "../sequence/properties";
import { sliceExportAudio, estimateFrameStorage } from "../utils/exportRange";
import RecoveryDialog from "./panel/RecoveryDialog";
import { projectSignature, saveRecovery } from "../utils/projectRecovery";
import SourceMonitor from "./panel/SourceMonitor";
import { sourcePreviewProject } from "../sequence/sourcePreview";
import SequenceInspector from "./panel/SequenceInspector";
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
import { copyFile, exists, rename, remove, writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import {
  resolveExportPipeline,
  runVideoExport,
  type VideoExportFormat,
  type VideoExportMethod,
  type VideoExportMode,
  type VideoExportPhase,
} from "../utils/videoExporter";
import { createCanvasStreamRecorder, estimateRecordingVideoBitrate, getWebmRecordingSupport } from "../utils/canvasRecorder";
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
  storeImageAsset,
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
type PanelResizeDrag = { side: "left" | "right"; startX: number; startWidth: number };
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
  const sceneRuntimeRef = useRef<SceneRuntime | null>(null);
  const assetBaseRef = useRef<string | null>(null);

  // ????jsonl?????????MTN ??????
  const groupContainerRef = useRef<PIXI.Container | null>(null);
  const isCompositeRef = useRef<boolean>(false);
  const motionBaseRef = useRef<string | null>(null); // ???? mtn ????

  // ??????????
  const [assetBase, setAssetBase] = useState<string | null>(null);
  assetBaseRef.current = assetBase;

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
  const registeredAudioUrlsRef = useRef(new Map<string, string>());
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
  const exportAbortRef=useRef<AbortController|null>(null);
  const [exportIssue,setExportIssue]=useState("");
  const retryExportRef=useRef<(()=>void)|null>(null);
  const [markedExportRange,setMarkedExportRange]=useState<{sequenceId:string;start:number;end:number}>();
  const [useMarkedExportRange,setUseMarkedExportRange]=useState(false);
  const [audioPreparing,setAudioPreparing]=useState(false);
  const audioStartRevision=useRef(0);
  const pitchBuffers=useRef(new Map<string,{uri:string;key:string}>());
  const [exportPhase, setExportPhase] = useState<VideoExportPhase>("render");
  const exportInProgressRef = useRef(false);
  const [exportTime, setExportTime] = useState(0);
  const [exportProgress, setExportProgress] = useState(0);
  // 实时录制：取消标记 + 录制循环的 rAF 句柄。
  const recordingCancelRef = useRef(false);
  const recordingRafRef = useRef<number | null>(null);
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

  const initialSequenceProject = migrateLegacyProject({
    selectedModel, selectedCharacterId, characterVisible: isCharacterVisible, characterTransform,
    animation, motionClips, exprClips, audioClips, subtitleClips, playhead: 0,
    showSubtitles, showSubtitleSpeaker, subtitleSpeakerAlign,
  });
  const [sequenceProject, setSequenceProject] = useState<ProjectDocument>(initialSequenceProject);
  const sequenceProjectRef = useRef(sequenceProject);
  sequenceProjectRef.current = sequenceProject;
  const previewContextRef = useRef<{ sequenceId: string; time: number; rootTime?: number; finalComposition?: boolean; instancePath?: string[] }>({ sequenceId: sequenceProject.rootSequenceId, time: 0 });
  const [previewQuality,setPreviewQuality]=useState(1);
  const [cacheBudget,setCacheBudget]=useState(256);
  const [showPreviewInfo,setShowPreviewInfo]=useState(false);
  const [previewSequenceId, setPreviewSequenceId] = useState(sequenceProject.rootSequenceId);
  const [previewSequenceTime, setPreviewSequenceTime] = useState(0);
  const [previewFinalComposition, setPreviewFinalComposition] = useState(false);
  const [navigationResetKey, setNavigationResetKey] = useState(0);
  const [sequenceSelection, setSequenceSelection] = useState<{ sequenceId: string; clipIds: string[]; actorId?: string; trackId?: string }>({ sequenceId: sequenceProject.rootSequenceId, clipIds: [] });
  const [linkedClipSelection, setLinkedClipSelection] = useState(true);
  const sequenceSelectionRef = useRef(sequenceSelection);
  sequenceSelectionRef.current = sequenceSelection;
  const rootPlayheadRef = useRef(0);
  const libraryPreviewRef = useRef(false);
  const [selectedProjectAssetId, setSelectedProjectAssetId] = useState<string>();
  const [projectPath,setProjectPath]=useState<string>();
  const [savedSignature,setSavedSignature]=useState("");
  const savingRef=useRef(false);
  const [saveBusy,setSaveBusy]=useState(false);
  const [saveIssue,setSaveIssue]=useState("");
  const [showRecovery,setShowRecovery]=useState(false);
  const [assetInsertRequest,setAssetInsertRequest]=useState<{assetId:string;serial:number}>();
  const sourcePreviewRevision=useRef(0);
  const [projectAssetThumbnails, setProjectAssetThumbnails] = useState<Record<string, string>>({});
  const previewSeekRevisionRef = useRef(0);
  const sceneAudioCacheRef = useRef(new WeakMap<ProjectDocument, Map<string, { signature: string; sample: ReturnType<typeof getSceneLipAt> }>>());
  const audioPreviewSequenceId = previewFinalComposition ? sequenceProject.rootSequenceId : previewSequenceId;
  const audioSchedule = useMemo(() => resolveAudioSchedule(sequenceProject, audioPreviewSequenceId), [sequenceProject, audioPreviewSequenceId]);
  const projectGestureRef = useRef<ProjectDocument | null>(null);
  const canvasEditCancelRef = useRef<(() => void) | null>(null);
  const legacyMediaSignatureRef = useRef("");
  const sequenceHistoryRef = useRef<ProjectHistory | null>(null);
  if (!sequenceHistoryRef.current) sequenceHistoryRef.current = new ProjectHistory(initialSequenceProject);
  const legacyMediaIdsRef = useRef<{ audio: string[]; subtitles: string[] }>({ audio: [], subtitles: [] });
  function syncLegacyMediaFromSequence(document: ProjectDocument) {
    const root = document.sequences[document.rootSequenceId];
    if (!root) return;
    const rootClips = root.tracks.flatMap((track) => track.clips);
    setAudioClips((previous) => {
      const nextAudio = rootClips.filter((clip) => clip.kind === "audio" && clip.assetId === `asset:audio:${clip.id}`).map((clip) => {
      const old = previous.find((item) => item.id === clip.id);
      const asset = clip.assetId ? document.assets[clip.assetId] : undefined;
      return { ...(old ?? {}), id: clip.id, name: clip.name, start: clip.start, duration: clip.duration, audioPath: asset?.uri || old?.audioPath, audioSourceDuration: asset?.duration ?? old?.audioSourceDuration, sourceIn: clip.sourceIn, playbackRate: clip.rate, gain: clip.volume, fadeIn: clip.fadeIn, fadeOut: clip.fadeOut } as Clip;
      });
      return previous.length === nextAudio.length && previous.every((item, index) => item.id === nextAudio[index].id && item.name === nextAudio[index].name && item.start === nextAudio[index].start && item.duration === nextAudio[index].duration && item.audioPath === nextAudio[index].audioPath && item.sourceIn === nextAudio[index].sourceIn && item.playbackRate === nextAudio[index].playbackRate && item.gain === nextAudio[index].gain && item.fadeIn === nextAudio[index].fadeIn && item.fadeOut === nextAudio[index].fadeOut) ? previous : nextAudio;
    });
    setSubtitleClips((previous) => {
      const nextSubtitles = rootClips.filter((clip) => clip.kind === "text" && clip.assetId === `asset:text:${clip.id}`).map((clip) => {
      const old = previous.find((item) => item.id === clip.id);
      const asset = clip.assetId ? document.assets[clip.assetId] : undefined;
      return {
        ...(old ?? {}), id: clip.id, name: clip.name, start: clip.start, duration: clip.duration,
        subtitleText: clip.text ?? old?.subtitleText ?? "", fontFamily: String(asset?.metadata?.fontFamily ?? old?.fontFamily ?? DEFAULT_SUBTITLE_FONT_FAMILY),
        fontSize: Number(asset?.metadata?.fontSize ?? old?.fontSize ?? DEFAULT_SUBTITLE_FONT_SIZE), textColor: String(asset?.metadata?.color ?? old?.textColor ?? DEFAULT_SUBTITLE_TEXT_COLOR),
      } as SubtitleClip;
      });
      return previous.length === nextSubtitles.length && previous.every((item, index) => item.id === nextSubtitles[index].id && item.start === nextSubtitles[index].start && item.duration === nextSubtitles[index].duration && item.subtitleText === nextSubtitles[index].subtitleText) ? previous : nextSubtitles;
    });
  }
  const reconcilePreviewContext = (document: ProjectDocument) => {
    if (document.sequences[previewContextRef.current.sequenceId]) return;
    const time = Math.min(rootPlayheadRef.current, sequenceDuration(document.sequences[document.rootSequenceId]));
    previewContextRef.current = { sequenceId: document.rootSequenceId, time };
    playheadRef.current = time;
    rootPlayheadRef.current = time;
    setPlayhead(time);
    setPreviewSequenceId(document.rootSequenceId);
    setPreviewSequenceTime(time);
    setPreviewFinalComposition(false);
    setSequenceSelection({ sequenceId: document.rootSequenceId, clipIds: [] });
  };
  const changeSequenceProject = (next: ProjectDocument) => {
    const committed = projectGestureRef.current ? next : sequenceHistoryRef.current!.execute(() => next);
    sequenceProjectRef.current = committed;
    reconcilePreviewContext(committed);
    if(!libraryPreviewRef.current)sceneRuntimeRef.current?.setProject(committed);
    setSequenceProject(committed);
    syncLegacyMediaFromSequence(committed);
  };
  const beginProjectEdit = () => { if (!projectGestureRef.current) projectGestureRef.current = sequenceProjectRef.current; };
  const endProjectEdit = () => {
    if (!projectGestureRef.current) return;
    const final = sequenceProjectRef.current;
    const before = projectGestureRef.current;
    projectGestureRef.current = null;
    sequenceHistoryRef.current!.replaceCurrent(before);
    sequenceHistoryRef.current!.execute(() => final);
  };
  const undoSequenceProject = () => {
    canvasEditCancelRef.current?.();
    endProjectEdit();
    const next = sequenceHistoryRef.current!.undo();
    sequenceProjectRef.current = next;
    reconcilePreviewContext(next);
    sceneRuntimeRef.current?.setProject(next);
    setSequenceProject(next);
    syncLegacyMediaFromSequence(next);
  };
  const redoSequenceProject = () => {
    canvasEditCancelRef.current?.();
    endProjectEdit();
    const next = sequenceHistoryRef.current!.redo();
    sequenceProjectRef.current = next;
    reconcilePreviewContext(next);
    sceneRuntimeRef.current?.setProject(next);
    setSequenceProject(next);
    syncLegacyMediaFromSequence(next);
  };

  useEffect(() => {
    if (!projectHydrated) return;
    const signature = JSON.stringify({ audio: audioClips.map(stripRuntimeAudio), subtitles: subtitleClips.map(stripRuntimeAudio) });
    if (signature === legacyMediaSignatureRef.current) return;
    legacyMediaSignatureRef.current = signature;
    const current = sequenceProjectRef.current;
    const ids = legacyMediaIdsRef.current;
    const next = syncLegacyMedia(current, audioClips, subtitleClips, { previousAudioIds: ids.audio, previousSubtitleIds: ids.subtitles });
    legacyMediaIdsRef.current = { audio: audioClips.map((clip) => clip.id), subtitles: subtitleClips.map((clip) => clip.id) };
    if (next !== current) changeSequenceProject(next);
  }, [audioClips, subtitleClips, projectHydrated]);

  useEffect(()=>{sceneRuntimeRef.current?.setPreviewQuality(previewQuality);sceneRuntimeRef.current?.setCacheBudget(cacheBudget);sceneRuntimeRef.current?.refreshPreview();},[previewQuality,cacheBudget]);
  useEffect(() => {
    if(libraryPreviewRef.current)return;
    sceneRuntimeRef.current?.setProject(sequenceProject);
    if (!isPlayingRef.current) void applyTimelineAtTime(previewContextRef.current.time);
  }, [sequenceProject]);

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
  const [resourcePaneWidth, setResourcePaneWidth] = useState(280);
  const [inspectorPaneWidth, setInspectorPaneWidth] = useState(320);
  const [timelinePaneHeight, setTimelinePaneHeight] = useState(() => Math.max(210, Math.min(300, window.innerHeight * 0.25)));
  const panelResizeDragRef = useRef<PanelResizeDrag | null>(null);

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

  const paneWidthLimits = (side: PanelResizeDrag["side"]) => {
    const min = side === "left" ? 220 : 240;
    return { min, max: Math.max(min, Math.min(600, window.innerWidth * 0.36)) };
  };

  const beginPanelResize = (
    side: PanelResizeDrag["side"],
    event: React.MouseEvent<HTMLDivElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    panelResizeDragRef.current = {
      side,
      startX: event.clientX,
      startWidth: side === "left" ? resourcePaneWidth : inspectorPaneWidth,
    };
    const move = (moveEvent: MouseEvent) => {
      const drag = panelResizeDragRef.current;
      if (!drag) return;
      const delta = (moveEvent.clientX - drag.startX) * (drag.side === "left" ? 1 : -1);
      const limits = paneWidthLimits(drag.side);
      const width = Math.max(limits.min, Math.min(limits.max, drag.startWidth + delta));
      if (drag.side === "left") setResourcePaneWidth(width);
      else setInspectorPaneWidth(width);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      panelResizeDragRef.current = null;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const resizePaneWithKeyboard = (
    side: PanelResizeDrag["side"],
    event: React.KeyboardEvent<HTMLDivElement>,
  ) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const amount = direction * (event.shiftKey ? 32 : 12) * (side === "left" ? 1 : -1);
    const limits = paneWidthLimits(side);
    const next = Math.max(
      limits.min,
      Math.min(
        limits.max,
        (side === "left" ? resourcePaneWidth : inspectorPaneWidth) + amount,
      ),
    );
    if (side === "left") setResourcePaneWidth(next);
    else setInspectorPaneWidth(next);
  };

  const beginTimelineResize = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const startY = event.clientY;
    const startHeight = timelinePaneHeight;
    const move = (moveEvent: MouseEvent) => {
      const maxHeight = Math.max(150, Math.min(640, window.innerHeight * 0.72));
      const height = Math.max(
        150,
        Math.min(maxHeight, startHeight + startY - moveEvent.clientY),
      );
      setTimelinePaneHeight(height);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const resizeTimelineWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const amount = (event.key === "ArrowUp" ? 1 : -1) * (event.shiftKey ? 32 : 12);
    const maxHeight = Math.max(150, Math.min(640, window.innerHeight * 0.72));
    setTimelinePaneHeight((height) => Math.max(150, Math.min(maxHeight, height + amount)));
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
    previewContextRef.current = { sequenceId: sequenceProjectRef.current.rootSequenceId, time: sec };
    rootPlayheadRef.current = sec;
    libraryPreviewRef.current = false;
    setPreviewSequenceId(sequenceProjectRef.current.rootSequenceId);
    setPreviewSequenceTime(sec);
    setPreviewFinalComposition(false);
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

  const materialModelOrigin = () => externalModelPathRef.current ?? selectedModel ?? modelUrl ?? "";
  const makeMaterialSource = (name: string, kind: 'motion' | 'expression', adapters: ModelAdapter[], characterId = selectedCharacterId): MaterialSource | undefined => {
    const sourceModel = materialModelOrigin();
    const id = `asset:material:${encodeURIComponent(sourceModel)}:${encodeURIComponent(characterId)}:${kind}:${encodeURIComponent(name)}`;
    const asset = sequenceProjectRef.current.assets[id];
    const saved = asset ? materialSourceFromAsset(asset) : null;
    if (saved) return saved;
    const parts = adapters.filter((adapter) => String(adapter.model.__characterId ?? "main") === characterId).flatMap((adapter) => {
      const data = readModelDataFromRuntime(adapter.model);
      const present = kind === "motion" ? !!data?.motions[name] : data?.expressions.some((item) => item.name === name);
      return present ? [adapter.materialReference(name, kind)] : [];
    });
    return parts.length ? { id, name, kind, sourceModel, parts } : undefined;
  };
  const getMaterialSource = (name: string, kind: 'motion' | 'expression') => makeMaterialSource(name, kind, rendererRef.current?.adapters ?? []);
  const loadMaterialSource = async (source: MaterialSource): Promise<MaterialSource> => {
    const checked = parseMaterialSource(source);
    if (!checked) throw new Error("动作或表情的来源无效，请重新拖入素材。");
    return { ...checked, parts: await Promise.all(checked.parts.map(async (part) => {
      if (part.text !== undefined) return part;
      const response = await fetch(part.uri);
      if (!response.ok) throw new Error(`素材读取失败：${checked.name} (${response.status})`);
      return { ...part, text: await response.text() };
    })) };
  };
  const cacheLibraryMaterials = async (adapters: ModelAdapter[]) => {
    const projectId = sequenceProjectRef.current.id;
    const characters = [...new Set(adapters.map((adapter) => String(adapter.model.__characterId ?? "main")))];
    const sources = characters.flatMap((character) => {
      const matching = adapters.filter((adapter) => String(adapter.model.__characterId ?? "main") === character);
      const motionNames = new Set(matching.flatMap((adapter) => Object.keys(readModelDataFromRuntime(adapter.model)?.motions ?? {})));
      const expressionNames = new Set(matching.flatMap((adapter) => readModelDataFromRuntime(adapter.model)?.expressions.map((item) => item.name) ?? []));
      return [...[...motionNames].map((name) => makeMaterialSource(name, "motion", adapters, character)), ...[...expressionNames].map((name) => makeMaterialSource(name, "expression", adapters, character))].filter((source): source is MaterialSource => !!source && !sequenceProjectRef.current.assets[source.id]);
    });
    const results = await Promise.allSettled(sources.map(loadMaterialSource));
    const current = sequenceProjectRef.current;
    if (current.id !== projectId) return;
    const loaded:MaterialSource[]=[];
    for(const result of results) {
      if(result.status==="fulfilled")loaded.push(result.value);
      else console.warn("读取素材来源失败",result.reason);
    }
    const assets=mergeMaterialAssets(current.assets,loaded);
    if(assets===current.assets)return;
    const next = { ...current, assets };
    sequenceProjectRef.current = next;
    sequenceHistoryRef.current?.replaceCurrent(next);
    setSequenceProject(next);
  };
  const prepareMaterial = async (name: string, kind: 'motion' | 'expression', start: number, base = animationRef.current, targetAdapters?: ModelAdapter[], source?: MaterialSource) => {
    const renderer = rendererRef.current;
    const adapters = targetAdapters ?? renderer?.adapters.filter(a => {
      if (String(a.model.__characterId ?? 'main') !== selectedCharacterId) return false;
      if (source) return true;
      const data = readModelDataFromRuntime(a.model);
      return kind === 'motion' ? !!data?.motions[name] : data?.expressions.some(e => e.name === name);
    }) ?? [];
    if (!adapters.length) throw new Error('当前角色中没有对应素材，请先加载模型');
    const selectedSource = source ?? getMaterialSource(name, kind);
    if (!selectedSource) throw new Error("没有可读取的素材来源，请先在素材库选择模型。");
    const resolved = await loadMaterialSource(selectedSource);
    if (resolved.name !== name || resolved.kind !== kind) throw new Error("素材名称或类型与来源不一致，请重新拖入。");
    const materials = resolved.parts.map((part) => {
      const adapter = adapters.find((item) => item.tracks[0]?.definition.partId === part.partId || String(item.model.__jsonlRoleMeta?.index ?? item.index) === part.partId)
        ?? (resolved.parts.length === 1 && adapters.length === 1 ? adapters[0] : undefined);
      if (!adapter) throw new Error(`目标模型缺少素材部件：${part.partId}`);
      return { adapter, text: part.text! };
    });
    if (!targetAdapters && rendererRef.current !== renderer) throw new Error('模型已改变，请重新导入素材');
    let next = base;
    const oldIds = new Set(next.groups.map(g => g.id));
    for (const {adapter, text} of materials) {
      const known = new Set(next.tracks.map((track) => track.definition.target));
      const missingTracks = adapter.tracks.filter((track) => !known.has(track.definition.target));
      const importTracks = [...next.tracks.filter((track) => adapter.tracks.some((item) => item.definition.target === track.definition.target)), ...missingTracks];
      next = { ...next, tracks: [...next.tracks, ...missingTracks] };
      next = importMaterial(next, importTracks, text, kind, name, start);
    }
    next = combineSourceGroups(next, next.groups.filter(g => !oldIds.has(g.id)).map(g => g.id));
    return { ...next, groups: next.groups.map((group) => oldIds.has(group.id) ? group : { ...group, sourceAssetId: resolved.id }) };
  };
  const addMaterial = async (name: string, kind: 'motion' | 'expression', start = playheadRef.current, source?: MaterialSource) => {
    if (!name) return;
    const project = sequenceProjectRef.current;
    const active = project.sequences[previewContextRef.current.sequenceId];
    if (active?.kind === "live2d") { await importMaterialIntoSequence(active.id, name, kind, start, source); return; }
    const selected = active?.tracks.flatMap((track) => track.clips).find((clip) => sequenceSelection.clipIds.includes(clip.id) && clip.sequenceId && project.sequences[clip.sequenceId]?.kind === "live2d");
    if (!selected?.sequenceId) { showAlert("请选中 Live2D 片段，或进入内部编辑。"); return; }
    await importMaterialIntoSequence(selected.sequenceId, name, kind, selected.sourceIn + Math.max(0, start - selected.start) * selected.rate, source);
  };
  const previewMaterial = async (name: string, kind: 'motion' | 'expression', source?: MaterialSource) => {
    try {
      stopPlayback();
      libraryPreviewRef.current = true;
      if (!source) setSelectedProjectAssetId(undefined);
      sceneRuntimeRef.current?.setVisible(false);
      setModelVisibility(true);
      const start = playheadRef.current;
      const document = await prepareMaterial(name, kind, start, animationRef.current, undefined, source);
      const duration = Math.max(0.1, ...document.groups.filter(g => !animationRef.current.groups.some(old => old.id === g.id)).map(g => g.duration));
      const started = performance.now();
      const frame = (now: number) => {
        const offset = Math.min(duration, (now-started)/1000);
        rendererRef.current?.seek(document, start+offset);
        if (appRef.current) appRef.current.renderer.render(appRef.current.stage);
        if (offset < duration) previewRafRef.current=requestAnimationFrame(frame);
        else { previewRafRef.current=null; }
      };
      previewRafRef.current = requestAnimationFrame(frame);
    } catch (error) { showAlert(`预览失败：${error instanceof Error ? error.message : String(error)}`); }
  };
  const previewMaterialSource = (source: MaterialSource) => previewMaterial(source.name, source.kind, source);
  const addMotionClip = (name: string) => addMaterial(name, 'motion');
  const addExprClip = (name: string) => addMaterial(name, 'expression');

  const importMaterialIntoSequence = async (sequenceId: string, name: string, kind: "motion" | "expression", start: number, source?: MaterialSource) => {
    let project = sequenceProjectRef.current;
    let target = project.sequences[sequenceId];
    if (!target || target.kind !== "live2d") return;
    try {
      await sceneRuntimeRef.current?.prepareSequence(sequenceId, false, start);
      project = sequenceProjectRef.current;
      target = project.sequences[sequenceId];
      if (target?.kind !== "live2d") return;
      const selectedSource = source ?? getMaterialSource(name, kind);
      if (!selectedSource) throw new Error("没有可读取的素材来源，请从素材库重新拖入。");
      const resolvedSource = await loadMaterialSource(selectedSource);
      const adapters = sceneRuntimeRef.current?.getAdapters(sequenceId) ?? [];
      const sourceAnimation = target.animation;
      const nextAnimation = await prepareMaterial(name, kind, start, sourceAnimation, adapters, resolvedSource);
      project = sequenceProjectRef.current;
      target = project.sequences[sequenceId];
      if (target?.kind !== "live2d" || target.animation !== sourceAnimation) throw new Error("动画已改变，请重新拖入素材。");
      const nextProject = { ...project, assets: { ...project.assets, [resolvedSource.id]: materialSourceToAsset(resolvedSource) }, sequences: { ...project.sequences, [sequenceId]: { ...target, animation: nextAnimation } } };
      stopPlayback();
      changeSequenceProject(nextProject);
      if (kind === "motion") setCurrentMotion(name); else setCurrentExpression(name);
    } catch (error) { showAlert(`导入失败：${error instanceof Error ? error.message : String(error)}`); }
  };

  const exportSequenceAnimation = async (sequenceId: string, options: AnimationExportOptions): Promise<string | undefined> => {
    stopPlayback();
    const projectId = sequenceProjectRef.current.id;
    await sceneRuntimeRef.current?.prepareSequence(sequenceId, false, options.kind === "motion" ? options.start : options.time);
    const project = sequenceProjectRef.current;
    const sequence = project.sequences[sequenceId];
    if (project.id !== projectId || sequence?.kind !== "live2d") throw new Error("序列已改变，请重新导出。");
    const adapter = sceneRuntimeRef.current?.getAdapters(sequenceId).find(item => item.tracks.some(track =>
      track.definition.characterId === options.characterId && track.definition.partId === options.partId));
    if (!adapter) throw new Error("所选模型部件未加载，请先修复模型素材。");
    const reference = adapter.modelReference();
    const file = exportAnimation(sequence.animation, options, reference.cubism);
    let outputName = options.name, outputPath: string;
    if (options.destination === "model") {
      const result = await invoke<{ name: string; filePath: string; relativeFile: string }>("export_animation_to_model", {
        modelUrl: reference.url, kind: options.kind, name: options.name, text: file.text,
      });
      outputName = result.name; outputPath = result.filePath;
      const adapters = [...(sceneRuntimeRef.current?.getAdapters(sequenceId) ?? []), ...(rendererRef.current?.adapters ?? [])];
      for (const item of new Set(adapters)) {
        if (item.modelReference().url === reference.url) item.registerExport(result.name, options.kind, result.relativeFile);
      }
      if (rendererRef.current?.adapters.some(item => item.modelReference().url === reference.url) && modelRef.current) {
        const models = Array.isArray(modelRef.current) ? modelRef.current : [modelRef.current];
        const data = models.map(readModelDataFromRuntime).filter((item): item is NonNullable<typeof item> => !!item);
        setModelData({ motions: Object.assign({}, ...data.map(item => item.motions)), expressions: data.flatMap(item => item.expressions) });
      }
    } else if(options.destination === "library") {
      outputPath="项目素材库";
    } else {
      const selectedPath = await save({ defaultPath: `${options.name}.${file.extension}`, filters: [{ name: `${options.kind === "motion" ? "Live2D 动作" : "Live2D 表情"} (.${file.extension})`, extensions: [file.extension === "mtn" ? "mtn" : "json"] }] });
      if (!selectedPath) return undefined;
      outputPath = selectedPath.toLowerCase().endsWith(`.${file.extension}`) ? selectedPath
        : file.extension.endsWith(".json") && /\.json$/i.test(selectedPath) ? selectedPath.replace(/\.json$/i, `.${file.extension}`)
        : `${selectedPath}.${file.extension}`;
      await writeTextFile(outputPath, file.text);
    }
    const source: MaterialSource = {
      id: `asset:animation-export:${crypto.randomUUID()}`, name: outputName, kind: options.kind,
      sourceModel: sequence.actors.find(actor => actor.id === options.characterId)?.assetId ?? reference.url,
      parts: [{ partId: String(adapter.model.__jsonlRoleMeta?.index ?? adapter.index), uri: "", text: file.text }],
    };
    const current = sequenceProjectRef.current;
    if (current.id === projectId) {
      const asset = materialSourceToAsset(source);
      changeSequenceProject({ ...current, assets: { ...current.assets, [asset.id]: { ...asset, metadata: { ...asset.metadata, exported: true } } } });
    }
    return `已导出 ${file.parameterCount} 个参数\n${outputPath}`;
  };

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
        const current = pendingMigrationRef.current ? animationRef.current : emptyAnimation();
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
          const project = sequenceProjectRef.current;
          const main = project.sequences["sequence:live2d:main"];
          if (main?.kind === "live2d") {
            const modelAsset = project.assets["asset:model:main"];
            const metadata = { ...modelAsset?.metadata };
            delete metadata.legacyMotions; delete metadata.legacyExpressions;
            changeSequenceProject({ ...project, assets: { ...project.assets, ["asset:model:main"]: { ...modelAsset, metadata } }, sequences: Object.fromEntries(Object.entries(project.sequences).map(([id, sequence]) => [id, id === main.id ? { ...main, animation: next } : { ...sequence, tracks: sequence.tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => clip.sequenceId === main.id ? { ...clip, placeholder: undefined } : clip) })) }])) });
          }
        }
        if (!cancelled) {
          changeAnimation(next);
          void cacheLibraryMaterials(adapters).catch((error) => console.warn("整理模型素材失败", error));
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

  const playbackAudioItem=(clip:ReturnType<typeof resolveAudioSchedule>[number],time:number)=>{
    const elapsed=time-clip.start,sourceTime=clip.sourceIn+Math.max(0,elapsed)*clip.rate;
    const key=`pitch:${clip.assetId}:${clip.rate}`;
    const pitched=clip.preservePitch!==false&&Math.abs(clip.rate-1)>1e-8;
    const ready=pitchBuffers.current.get(key)?.uri===sequenceProjectRef.current.assets[clip.assetId]?.uri;
    return {id:clip.id,assetId:pitched?key:clip.assetId,sourceTime:pitched?sourceTime/clip.rate:sourceTime,rate:pitched?1:clip.rate,gain:clip.muted?0:audioGainAt(clip,elapsed),active:(!pitched||ready)&&!clip.muted&&elapsed>=0&&elapsed<clip.duration,remainingDuration:clip.duration-elapsed};
  };
  const syncPreviewAudioAtTime=(timeSec:number)=>audioManager.syncBufferAudio(audioSchedule.map(clip=>playbackAudioItem(clip,timeSec)),isPlayingRef.current);

  const prepareSequenceAudio = async (sequenceId: string, strict = false) => {
    const project = sequenceProjectRef.current;
    const schedule = resolveAudioSchedule(project, sequenceId);
    await Promise.all([...new Set(schedule.map((item) => item.assetId))].map(async (assetId) => {
      const asset = project.assets[assetId];
      if (!asset?.uri || asset.missing || asset.uri.startsWith("bundle:")) {
        if (strict) throw new Error(`缺少音频素材：${asset?.name ?? assetId}`);
        setAnimationIssue(`缺少音频素材：${asset?.name ?? assetId}，请在素材库替换。`);
        return;
      }
      const url = /^(?:https?:|blob:|data:)/.test(asset.uri) ? asset.uri : await buildExternalAssetUrl(await dirname(asset.uri), asset.uri);
      const buffer = await audioManager.prepareAudioBuffer(assetId, url);
      if (asset.lipSync && asset.waveformPeaks) return;
      const analysis = { lipSync: bakeLipSync(buffer), lipSyncSampleRate: 120, waveformPeaks: buildWaveformPeaks(buffer), duration: buffer.duration };
      const current = sequenceProjectRef.current;
      if (current.assets[assetId]?.uri !== asset.uri) return;
      const next = { ...current, assets: { ...current.assets, [assetId]: { ...current.assets[assetId], ...analysis } } };
      sequenceProjectRef.current = next;
      sequenceHistoryRef.current?.replaceCurrent(next);
      setSequenceProject(next);
    }));
    const retained=new Set(schedule.map(item=>item.assetId));
    const rates = [...new Map(schedule.filter(item=>!item.muted&&item.preservePitch&&Math.abs(item.rate-1)>1e-8).map(item=>[`${item.assetId}:${item.rate}`,item])).values()];
    await Promise.all(rates.map(async item=>{
      const asset=project.assets[item.assetId];if(!asset?.uri||asset.missing)return;
      const key=`pitch:${item.assetId}:${item.rate}`;retained.add(key);
      if(pitchBuffers.current.get(key)?.uri===asset.uri&&audioManager.getDecodedAudioBuffer(key))return;
      const path=await invoke<string>("render_audio_rate",{path:asset.uri,rate:item.rate});
      await audioManager.prepareAudioBuffer(key,await buildExternalAssetUrl(await dirname(path),path));
      pitchBuffers.current.set(key,{uri:asset.uri,key});
    }));
    audioManager.pruneDecodedAudio(retained);
  };

  // ????????
  const importProjectAudioAsset = async () => {
    try {
      const picked = await open({ multiple: false, filters: [{ name: "音频", extensions: ["wav", "mp3", "ogg", "m4a"] }] });
      if (typeof picked !== "string") return;
      const managedPath = await storeAudioAsset(picked);
      const audioUrl = await buildExternalAssetUrl(await dirname(managedPath), managedPath);
      const name = picked.split(/[\\/]/).pop()?.replace(/\.[^/.]+$/, "") || "音频";
      const id = `asset:audio:${crypto.randomUUID()}`;
      const buffer=await audioManager.prepareAudioBuffer(id,audioUrl);
      const project = sequenceProjectRef.current;
      changeSequenceProject({ ...project, assets: { ...project.assets, [id]: { id, kind: "audio", name, uri: managedPath, duration: buffer.duration, lipSync:bakeLipSync(buffer),lipSyncSampleRate:120,waveformPeaks:buildWaveformPeaks(buffer) } } });
    } catch (error) { showAlert(`导入音频失败：${error instanceof Error ? error.message : String(error)}`); }
  };

  const importProjectImageAsset = async () => {
    try {
      const picked = await open({ multiple: false, filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }] });
      if (typeof picked !== "string") return;
      const managedPath = await storeImageAsset(picked);
      const imageUrl = await buildExternalAssetUrl(await dirname(managedPath), managedPath);
      const image = new Image();
      image.src = imageUrl;
      await image.decode();
      const name = picked.split(/[\\/]/).pop()?.replace(/\.[^/.]+$/, "") || "图片";
      const id = `asset:image:${crypto.randomUUID()}`;
      const project = sequenceProjectRef.current;
      changeSequenceProject({ ...project, assets: { ...project.assets, [id]: { id, kind: "image", name, uri: managedPath, width: image.naturalWidth, height: image.naturalHeight } } });
    } catch (error) { showAlert(`导入图片失败：${error instanceof Error ? error.message : String(error)}`); }
  };

  useEffect(() => {
    let cancelled = false;
    void Promise.all(Object.values(sequenceProject.assets).filter((asset) => (asset.kind === "image" || asset.kind === "audio") && asset.uri && !asset.missing && !asset.uri.startsWith("bundle:")).map(async (asset) => {
      try { return [asset.id, /^(?:https?:|blob:|data:)/.test(asset.uri) ? asset.uri : await buildExternalAssetUrl(await dirname(asset.uri), asset.uri)] as const; }
      catch { return null; }
    })).then((entries) => { if (!cancelled) setProjectAssetThumbnails(Object.fromEntries(entries.filter((entry) => entry !== null))); });
    return () => { cancelled = true; };
  }, [sequenceProject.assets]);

  const previewProjectAsset = async (asset: ProjectAsset) => {
    stopPlayback(); libraryPreviewRef.current = true; setSelectedProjectAssetId(asset.id); setModelVisibility(false);
    try {
      if (asset.missing) { showAlert("素材缺失，请点击替换。"); return; }
      const runtime = sceneRuntimeRef.current;
      if (!runtime) return;
      if (asset.kind === "motion" || asset.kind === "expression") {
        const source = materialSourceFromAsset(asset);
        if (!source) throw new Error("该素材的来源数据无效。");
        sceneRuntimeRef.current?.setVisible(false);
        await previewMaterialSource(source);
        return;
      }
      if (asset.kind === "audio") { runtime.setVisible(false); return; }
      await seekSourceAsset(asset,0);
    } catch (error) { showAlert(`素材预览失败：${String(error)}`); }
  };

  const sourceAudioRevision=useRef(0);
  const playSourceAudio=async (asset:ProjectAsset,time:number,playing:boolean)=>{
    const revision=++sourceAudioRevision.current;
    if(!playing){audioManager.syncBufferAudio([],false);return;}
    const url=projectAssetThumbnails[asset.id];if(!url)return;
    await audioManager.resumeAudioContext();
    const buffer=await audioManager.prepareAudioBuffer(asset.id,url);
    if(revision!==sourceAudioRevision.current||!libraryPreviewRef.current)return;
    audioManager.syncBufferAudio([{id:`source:${asset.id}`,assetId:asset.id,sourceTime:time,rate:1,gain:1,active:true,remainingDuration:Math.max(0,buffer.duration-time)}],true);
  };
  const sourcePreviewCache=useRef<{project:ProjectDocument;asset:ProjectAsset;preview:ReturnType<typeof sourcePreviewProject>}|undefined>(undefined);
  const seekSourceAsset = async (asset:ProjectAsset,time:number) => {
    const revision=++sourcePreviewRevision.current;
    const runtime=sceneRuntimeRef.current;if(!runtime||!libraryPreviewRef.current)return;
    const project=sequenceProjectRef.current;
    if(sourcePreviewCache.current?.project!==project||sourcePreviewCache.current.asset!==asset)sourcePreviewCache.current={project,asset,preview:sourcePreviewProject(project,asset)};
    const preview=sourcePreviewCache.current.preview;
    runtime.setProject(preview.project);
    await runtime.seekSceneAt(preview.sequenceId,time,{lipAt:getSceneLipAt(preview.project,preview.sequenceId)});
    if(revision!==sourcePreviewRevision.current)return;
  };
  const changeSourceRange=(asset:ProjectAsset,start:number,end:number)=>{const current=sequenceProjectRef.current;changeSequenceProject({...current,assets:{...current.assets,[asset.id]:{...asset,metadata:{...asset.metadata,sourceIn:start,sourceOut:end}}}});};
  const closeSourcePreview=()=>{libraryPreviewRef.current=false;setSelectedProjectAssetId(undefined);sceneRuntimeRef.current?.setProject(sequenceProjectRef.current);void applyTimelineAtTime(previewContextRef.current.time);};
  const repairProjectAsset = async (assetId: string) => {
    const sourceProject = sequenceProjectRef.current;
    const asset = sourceProject.assets[assetId];
    if (!asset) return;
    try {
      const picked = await open({ multiple: false, title: `替换 ${asset.name}`, filters: [{ name: "素材", extensions: asset.kind === "live2d" ? ["json", "jsonl", "zip"] : asset.kind === "audio" ? ["wav", "mp3", "ogg", "m4a"] : ["png", "jpg", "jpeg", "webp", "gif"] }] });
      if (typeof picked !== "string") return;
      let uri: string, duration = asset.duration;
      if (asset.kind === "live2d") {
        if (!modelRoot) throw new Error("模型库尚未就绪。");
        const imported = await importModelSource(picked, modelRoot);
        const models = await invoke<string[]>("refresh_model_index");
        const paths = models.filter((path) => path.startsWith(`${imported.id}/`));
        const preferred = picked.split(/[\\/]/).pop();
        const relative = paths.find((path) => path.endsWith(`/${preferred}`)) ?? paths[0];
        if (!relative) throw new Error("没有找到模型配置。");
        uri = await join(modelRoot, relative);
        const packages = [...modelPackages, { ...imported, modelPaths: paths }];
        await saveModelPackages(packages); setModelPackages(packages); setModelList(models);
      } else if (asset.kind === "audio") {
        uri = await storeAudioAsset(picked);
        const url = await buildExternalAssetUrl(await dirname(uri), uri);
        duration = (await audioManager.prepareAudioBuffer(assetId, url)).duration;
      } else uri = await storeImageAsset(picked);
      const project = sequenceProjectRef.current;
      if (project.id !== sourceProject.id || project.assets[assetId]?.uri !== asset.uri) return;
      const assets = { ...project.assets, [assetId]: { ...project.assets[assetId], uri, duration, missing: false, lipSync: undefined, waveformPeaks: undefined } };
      const sequences = Object.fromEntries(Object.entries(project.sequences).map(([id, sequence]) => [id, { ...sequence, tracks: sequence.tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => {
        const child = clip.sequenceId ? project.sequences[clip.sequenceId] : undefined;
        const repairedChild = child?.kind === "live2d" && child.actors.some((actor) => actor.assetId === assetId) && child.actors.every((actor) => {
          const model = assets[actor.assetId];
          return model && !model.missing && !!model.uri && !model.metadata?.legacyMotions;
        });
        return clip.assetId === assetId || repairedChild ? { ...clip, placeholder: undefined } : clip;
      }) })) }]));
      changeSequenceProject({ ...project, sequences, assets });
      if (assetId === "asset:model:main" && pendingMigrationRef.current) {
        externalModelPathRef.current = uri;
        setExternalModelUrl(await buildExternalAssetUrl(await dirname(uri), uri));
        setProjectRevision((revision) => revision + 1);
      }
      setAnimationIssue(null);
    } catch (error) { showAlert(`替换素材失败：${String(error)}`); }
  };

  const timelineLength = sequenceDuration(sequenceProject.sequences[sequenceProject.rootSequenceId]);

  const mapSequenceTimeToRoot = (time: number, sequenceId: string, instancePath?: string[]) => {
    const project = sequenceProjectRef.current;
    if (sequenceId === project.rootSequenceId) return time;
    let sequence = project.sequences[project.rootSequenceId];
    const clips: import("../sequence/types").Clip[] = [];
    for (const id of instancePath ?? []) {
      const clip = sequence?.tracks.flatMap((track) => track.clips).find((clip) => clip.id === id);
      if (!clip?.sequenceId) return undefined;
      clips.push(clip); sequence = project.sequences[clip.sequenceId];
    }
    if (sequence?.id !== sequenceId) return undefined;
    let result = time;
    for (const clip of clips.reverse()) {
      if (result < clip.sourceIn || result >= clip.sourceIn + clip.duration * clip.rate) return undefined;
      result = clip.start + (result - clip.sourceIn) / clip.rate;
    }
    return result;
  };

  const seekSequence = (sequenceId: string, time: number, context: { rootTime?: number; finalComposition?: boolean; instancePath?: string[] } = {}) => {
    if (sequenceId !== previewContextRef.current.sequenceId) canvasEditCancelRef.current?.();
    previewContextRef.current = { sequenceId, time, ...context };
    libraryPreviewRef.current = false;
    setPreviewSequenceId(sequenceId);
    setPreviewSequenceTime(time);
    setPreviewFinalComposition(!!context.finalComposition);
    playheadRef.current = time;
    if (sequenceId === sequenceProjectRef.current.rootSequenceId) { rootPlayheadRef.current = time; setPlayhead(time); }
    void applyTimelineAtTime(time);
  };

  useEffect(() => {
    if (!projectHydrated) return;
    let cancelled = false;
    const wanted = new Set(audioSchedule.map((item) => item.id));
    for (const registeredId of registeredAudioUrlsRef.current.keys()) {
      if (!wanted.has(registeredId)) {
        audioManager.unregisterAudioElement(registeredId);
        registeredAudioUrlsRef.current.delete(registeredId);
      }
    }
    void Promise.all(audioSchedule.map(async (item) => {
      const asset = sequenceProject.assets[item.assetId];
      if (!asset?.uri || asset.uri.startsWith("bundle:") || asset.missing) return;
      try {
        const audioUrl = await buildExternalAssetUrl(await dirname(asset.uri), asset.uri);
        if (cancelled || registeredAudioUrlsRef.current.get(item.id) === audioUrl) return;
        registerAudioElement(item.id, audioUrl);
        registeredAudioUrlsRef.current.set(item.id, audioUrl);
      } catch (error) { console.warn(`音频素材“${asset.name}”无法加载`, error); }
    })).then(() => {
      if (cancelled) return;
      syncPreviewAudioAtTime(playheadRef.current);
      if (appRef.current) appRef.current.renderer.render(appRef.current.stage);
    });
    return () => { cancelled = true; };
  }, [projectHydrated, audioSchedule, sequenceProject.assets]);

  useEffect(() => {
    if (!projectHydrated) return;
    void prepareSequenceAudio(audioPreviewSequenceId).catch((error) => setAnimationIssue(String(error)));
  }, [projectHydrated, audioSchedule, audioPreviewSequenceId]);

  const applyTimelineAtTime = async (t: number, offline = false, mode: VideoExportMode = "all") => {
    if (!offline && exportInProgressRef.current) return;
    const seekRevision = ++previewSeekRevisionRef.current;
    const project = sequenceProjectRef.current;
    const context = previewContextRef.current;
    const sequenceId = offline ? previewSequenceId : context.sequenceId;
    const renderSequenceId = !offline && context.finalComposition && context.rootTime != null ? project.rootSequenceId : sequenceId;
    const renderTime = !offline && context.finalComposition && context.rootTime != null ? context.rootTime : t;
    const runtime = sceneRuntimeRef.current;
    if (!runtime) return;
    if (!offline && libraryPreviewRef.current) return;
    runtime.setProject(project);
    setModelVisibility(false);
    renderSubtitleClip(null);
    try {
      let cache = sceneAudioCacheRef.current.get(project);
      if (!cache) { cache = new Map(); sceneAudioCacheRef.current.set(project, cache); }
      let audio = cache.get(renderSequenceId);
      if (!audio) {
        audio = { signature: JSON.stringify({ schedule: resolveAudioSchedule(project, renderSequenceId), samples: Object.values(project.assets).filter((asset) => asset.lipSync).map((asset) => [asset.id, asset.uri, asset.lipSync]) }), sample: getSceneLipAt(project, renderSequenceId) };
        cache.set(renderSequenceId, audio);
      }
      await runtime.seekSceneAt(renderSequenceId, renderTime, {
        offline, audioVersion: audio.signature, mode: mode === "all" ? "composite" : mode,
        lipAt: audio.sample,
      });
      if (!offline && seekRevision === previewSeekRevisionRef.current) syncPreviewAudioAtTime(renderTime);
    } catch (error) {
      if (offline) throw error;
      setAnimationIssue(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    if (!isPlaying) void applyTimelineAtTime(previewContextRef.current.time);
  }, [animation, sequenceProject, isCharacterVisible, selectedModel, previewSequenceId]);

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
    const context = previewContextRef.current;
    previewContextRef.current = { ...context, time: nextPlayhead, rootTime: mapSequenceTimeToRoot(nextPlayhead, context.sequenceId, context.instancePath) };

    if (!force) {
      const lastUiTs = playheadUiLastTsRef.current;
      if (lastUiTs != null && ts - lastUiTs < PLAYHEAD_UI_INTERVAL_MS) {
        return;
      }
    }

    playheadUiLastTsRef.current = ts;
    startTransition(() => {
      setPreviewSequenceTime(nextPlayhead);
      if (context.sequenceId === sequenceProjectRef.current.rootSequenceId) { rootPlayheadRef.current = nextPlayhead; setPlayhead(nextPlayhead); }
    });
  };

  const tick = (ts: number) => {
    if (startTsRef.current == null) startTsRef.current = ts;
    const activeDuration = sequenceDuration(sequenceProjectRef.current.sequences[previewContextRef.current.sequenceId]);
    const t = Math.min(activeDuration, (ts - startTsRef.current) / 1000);
    syncPlayheadUi(t, ts);

    applyTimelineAtTime(t);

    if (t >= activeDuration) {
      syncPlayheadUi(activeDuration, ts, true);
      stopPlayback();
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
  };

  const startPlayback = async () => {
    if(exportInProgressRef.current||isPlayingRef.current||audioPreparing)return;
    const active=previewContextRef.current.sequenceId;if(sequenceDuration(sequenceProjectRef.current.sequences[active])<=0)return;
    const revision=++audioStartRevision.current;setAudioPreparing(true);canvasEditCancelRef.current?.();libraryPreviewRef.current=false;
    try{await audioManager.resumeAudioContext();await prepareSequenceAudio(audioPreviewSequenceId,true);if(revision!==audioStartRevision.current||previewContextRef.current.sequenceId!==active)return;
      if(previewRafRef.current!=null)cancelAnimationFrame(previewRafRef.current);previewRafRef.current=null;
      const activeDuration=sequenceDuration(sequenceProjectRef.current.sequences[active]);if(playheadRef.current>=activeDuration)playheadRef.current=0;
      playheadUiLastTsRef.current=null;isPlayingRef.current=true;setIsPlaying(true);startTsRef.current=performance.now()-playheadRef.current*1000;rafRef.current=requestAnimationFrame(tick);
    }catch(error){setAnimationIssue(`播放准备失败：${String(error)}`);}finally{if(revision===audioStartRevision.current)setAudioPreparing(false);}
  };

  const stopPlayback = () => {
    audioStartRevision.current++;setAudioPreparing(false);
    canvasEditCancelRef.current?.();
    if (previewRafRef.current != null) cancelAnimationFrame(previewRafRef.current);
    previewRafRef.current = null;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    startTsRef.current = null;
    playheadUiLastTsRef.current = null;
    resetTimelineDisplayCache();
    isPlayingRef.current = false;
    setIsPlaying(false);
    setPreviewSequenceTime(playheadRef.current);
    if (previewContextRef.current.sequenceId === sequenceProjectRef.current.rootSequenceId) setPlayhead(playheadRef.current);

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
    const entries = resolveTextSchedule(sequenceProjectRef.current, previewSequenceId);

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
        clip.speakerName ? `${clip.speakerName}：${clip.text.trim()}` : clip.text.trim(),
        "",
      ].join("\n"))
      .join("\n");

    await writeFile(out, new TextEncoder().encode(content));
  };

  const exportVideo = async (
    format: VideoExportFormat,
    mode: VideoExportMode,
    includeAudio: boolean,
    method: VideoExportMethod,
  ) => {
    if (!canvasRef.current || !appRef.current) return;
    if (exportState === "exporting" || exportInProgressRef.current) return;

    const exportSequence = sequenceProjectRef.current.sequences[previewSequenceId];
    const sequenceEnd=sequenceDuration(exportSequence);
    const range=useMarkedExportRange&&markedExportRange?.sequenceId===previewSequenceId?markedExportRange:undefined;
    const exportStart=range?Math.min(sequenceEnd,range.start):0;
    const totalDuration=Math.max(0,(range?Math.min(sequenceEnd,range.end):sequenceEnd)-exportStart);

    if (totalDuration <= 0) {
      showAlert("时间线为空，无法导出");
      return;
    }

    const settings = { fps: exportSequence.fps };
    const targetFrames = Math.max(1, Math.ceil(totalDuration * settings.fps));

    const blobOnlyAudio = includeAudio
      ? audioClips.filter(c => c.audioUrl && !c.audioPath && /^blob:/i.test(c.audioUrl))
      : [];
    if (blobOnlyAudio.length > 0) {
      showAlert(`有 ${blobOnlyAudio.length} 条临时音频无法导出，请重新导入音频文件`);
      return;
    }

    // WebM 可以在支持 MediaRecorder 的环境里实时录制；MOV、透明背景与环境不支持时仍走逐帧 PNG → ffmpeg。
    const pipeline = resolveExportPipeline({
      format,
      method,
      transparentBg,
      recordingSupported: getWebmRecordingSupport().supported,
    });

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

    exportInProgressRef.current = true;
    setExportIssue("");retryExportRef.current=()=>void exportVideo(format,mode,includeAudio,method);
    exportAbortRef.current=new AbortController();recordingCancelRef.current=false;
    setExportState('exporting');
    setExportTime(0);
    setExportProgress(0);
    stopPlayback();

    const app = appRef.current;
    const previewSize = { width: app.screen.width, height: app.screen.height };
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
    renderSubtitleClip(null);

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

    /** 把当前舞台画面画到导出画布：有裁切框时走 2D 画布，否则直接渲染 PIXI 画布。 */
    const paintExportFrame = () => {
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
      } else {
        app.renderer.render(app.stage);
      }
    };

    /**
     * 实时录制：按真实时间推进时间线并录制画布流，音频经 AudioManager 的录制通道混进同一个 WebM。
     * 返回 "cancelled" 表示用户中途停止（不落盘）。
     */
    const runWebmRecording = async (): Promise<"saved" | "cancelled"> => {
      const support = getWebmRecordingSupport();
      if (!support.supported || !support.mimeType) {
        throw new Error(`${support.reason ?? "当前环境不支持实时录制"}，请改用逐帧渲染。`);
      }
      if (includeAudio) {
        await audioManager.resumeAudioContext();
        if (!audioManager.recordingDestinationRef.current) {
          throw new Error("音频录制通道不可用，请改用逐帧渲染。");
        }
      }
      const recordingAudioSchedule = includeAudio
        ? resolveAudioSchedule(sequenceProjectRef.current, previewSequenceId)
        : [];
      const recorder = createCanvasStreamRecorder({
        canvas: exportCanvas,
        fps: settings.fps,
        mimeType: support.mimeType,
        videoBitsPerSecond: estimateRecordingVideoBitrate(exportSequence.width, exportSequence.height, settings.fps),
        audioStream: includeAudio ? audioManager.recordingDestinationRef.current?.stream ?? null : null,
      });

      if (!firstFrame) {
        firstFrame = true;
        if (prepInterval) { clearInterval(prepInterval); prepInterval = null; }
      }
      recordingCancelRef.current = false;
      setExportPhase("record");
      updateExportUi(0, 0, true);

      try {
        // 先把时间线推进到 0 并画一帧，避免录制开头录到上一次预览的残留画面。
        await applyTimelineAtTime(exportStart, true, mode);
        syncPlayheadUi(0, performance.now());
        paintExportFrame();
      } catch (error) {
        recorder.cancel();
        throw error;
      }

      recorder.start();
      // 只改 ref：音频与嘴型需要「播放中」，但 React 播放状态会让空格键触发 stopPlayback 打断录制。
      isPlayingRef.current = true;
      const recordingStart = performance.now();
      let renderedSteps = 0;
      let loopError: unknown = null;

      await new Promise<void>((resolve) => {
        const step = async (ts: number) => {
          const elapsed = (performance.now() - recordingStart) / 1000;
          const time = Math.min(totalDuration, elapsed);
          syncPlayheadUi(time, ts);
          try {
            await applyTimelineAtTime(exportStart+time, true, mode);
          } catch (error) {
            loopError = error;
            resolve();
            return;
          }
          renderedSteps += 1;
          paintExportFrame();
          if (includeAudio) {
            audioManager.syncBufferAudio(recordingAudioSchedule.map(clip=>playbackAudioItem(clip,exportStart+time)),true);
          }
          updateExportUi(time, Math.min(95, (time / totalDuration) * 95));
          if (recordingCancelRef.current || time >= totalDuration) {
            resolve();
            return;
          }
          recordingRafRef.current = requestAnimationFrame((next) => { void step(next); });
        };
        recordingRafRef.current = requestAnimationFrame((ts) => { void step(ts); });
      });

      if (recordingRafRef.current !== null) {
        cancelAnimationFrame(recordingRafRef.current);
        recordingRafRef.current = null;
      }
      if (loopError) {
        recorder.cancel();
        audioManager.stopAllAudio();
        isPlayingRef.current = false;
        throw loopError;
      }
      if (recordingCancelRef.current) {
        recorder.cancel();
        audioManager.stopAllAudio();
        isPlayingRef.current = false;
        return "cancelled";
      }

      const blob = await recorder.stop();
      audioManager.stopAllAudio();
      isPlayingRef.current = false;
      if (blob.size === 0) {
        throw new Error("实时录制没有捕获到画面数据，请改用逐帧渲染。");
      }
      await writeFile(outputPath, new Uint8Array(await blob.arrayBuffer()));

      const expectedFrames = Math.max(1, Math.round(totalDuration * settings.fps));
      if (renderedSteps < expectedFrames * 0.8) {
        showAlert(`实时录制已保存，但渲染丢帧较多（约 ${renderedSteps}/${expectedFrames} 帧）。需要逐帧精确输出请改用「逐帧渲染」。`);
      }
      return "saved";
    };

    try {
      prepInterval = window.setInterval(() => {
        if (firstFrame) return;
        const elapsed = (Date.now() - prepStart) / 1000;
        const pct = Math.min(0.05, elapsed * 0.2);
        updateExportUi(elapsed, pct * 100);
      }, 100);
      await sceneRuntimeRef.current?.prepareSequence(previewSequenceId, true);
      await prepareSequenceAudio(previewSequenceId, true);
      app.renderer.resize(exportSequence.width, exportSequence.height);
      const exportAudioSchedule = resolveAudioSchedule(sequenceProjectRef.current, previewSequenceId);
      const outcome: "saved" | "cancelled" = pipeline.kind === "record"
        ? await runWebmRecording()
        : await runVideoExport({
        canvas: exportCanvas,
        outputPath,
        format,
        fps: settings.fps,
        targetFrameCount: targetFrames,
        startTime:exportStart,signal:exportAbortRef.current?.signal,onPhase:setExportPhase,
        applyTimelineAtTime: (timeSec) => applyTimelineAtTime(timeSec, true, mode),
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
        audioTracks: sliceExportAudio(exportAudioSchedule.map((clip) => {
          const asset = sequenceProjectRef.current.assets[clip.assetId];
          const audioUrl = audioManager.audioRefs.current.get(clip.id)?.src;
          return {
            id: clip.id, start: clip.start, duration: clip.duration, sourceDuration: asset?.duration,
            sourceIn: clip.sourceIn, playbackRate: clip.rate, gain: clip.gain,
            fadeIn: clip.fadeIn, fadeOut: clip.fadeOut, muted: clip.muted,
            gainEnvelopes: clip.gainEnvelopes,preservePitch:clip.preservePitch,
            audioUrl, audioPath: asset?.uri,
          };
        }),exportStart,exportStart+totalDuration),
        includeAudio,
        onProgress: ({ frameIndex, totalFrames, timeSec }) => {
          if (!firstFrame) {
            firstFrame = true;
            if (prepInterval) { clearInterval(prepInterval); prepInterval = null; }
          }
          if (frameIndex >= totalFrames) setExportPhase("encode");
          updateExportUi(
            timeSec,
            Math.min(85, (frameIndex / totalFrames) * 85),
            frameIndex >= totalFrames,
          );
        }
      }).then(() => "saved" as const);

      if (outcome === "cancelled") {
        setExportState('idle');
        setExportTime(0);
        setExportProgress(0);
        return;
      }

      setExportState('done');
      setExportTime(0);
      setExportProgress(0);
    } catch (error) {
      if(exportAbortRef.current?.signal.aborted){setExportState("idle");return;}
      console.error('视频导出失败:', error);
      setExportIssue("导出失败：" + String(error));
      setExportState('idle');
      setExportTime(0);
      setExportProgress(0);
    } finally {
      exportInProgressRef.current = false;exportAbortRef.current=null;
      recordingCancelRef.current = false;
      setExportPhase("render");
      if (recordingRafRef.current !== null) {
        cancelAnimationFrame(recordingRafRef.current);
        recordingRafRef.current = null;
      }
      restoreModelVisibility(previousModelVisibility);
      subtitleVisibilityOverrideRef.current = previousSubtitleOverride;
      renderSubtitleClip(null);
      if (prepInterval) { clearInterval(prepInterval); prepInterval = null; }
      app.renderer.resize(containerRef.current?.clientWidth || previewSize.width, containerRef.current?.clientHeight || previewSize.height);
      await applyTimelineAtTime(playheadRef.current);
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
    } catch (e) {
      console.warn("读取模型库索引失败", e);
      setModelList([]);
      setSelectedModel(null);
    }
  };

  useEffect(() => {
    loadModelList();
  }, [assetBase]);

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
      const project = sequenceProjectRef.current;
      const assets = { ...project.assets };
      for (const path of importedPaths) {
        const id = `asset:model:${path}`;
        assets[id] = { id, kind: "live2d", name: imported.name, uri: path };
      }
      changeSequenceProject({ ...project, assets });
      libraryPreviewRef.current = true;
      setSelectedProjectAssetId(undefined);
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
        setSelectedModel(null);
      }
      const project = sequenceProjectRef.current;
      const affected = Object.values(project.assets).filter((asset) => asset.kind === "live2d" && (target.modelPaths.includes(asset.uri) || asset.uri.startsWith(`${id}/`) || asset.uri.replace(/\\/g, "/").includes(`/${id}/`)));
      if (affected.length) {
        const assets = { ...project.assets };
        for (const asset of affected) assets[asset.id] = { ...asset, missing: true };
        changeSequenceProject({ ...project, assets });
        setAnimationIssue("模型素材已移除，片段和动画已保留。请在素材库替换缺失素材。");
      }
    } catch (error) {
      showAlert(`移除模型失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const makeProjectSnapshot = (): ProjectSnapshot => {
    const currentDocument = structuredClone(sequenceProjectRef.current);
    const base = {
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
    playhead: rootPlayheadRef.current,
    motionDur,
    exprDur,
    characterVisible: isCharacterVisible,
    characterTransformMode,
    characterTransform,
    recordingQuality,
    transparentBg,
    customRecordingBounds,
    };
    return {
      ...base,
      projectPath,
      fileSignature: savedSignature,
      version: 3,
      document: currentDocument,
    };
  };

  const applyProjectSnapshot = async (snapshot: ProjectSnapshot) => {
    canvasEditCancelRef.current?.();
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
    const restoredDocument = snapshot.document ?? migrateLegacyProject({
      selectedModel: snapshot.selectedModel,
      externalModelPath: snapshot.externalModelPath,
      selectedCharacterId: snapshot.selectedCharacterId,
      characterVisible: snapshot.characterVisible,
      characterTransform: snapshot.characterTransform,
      characterTransformMode: snapshot.characterTransformMode,
      animation: snapshot.animation,
      motionClips: snapshot.motionClips,
      exprClips: snapshot.exprClips,
      audioClips: restoredAudio,
      subtitleClips: snapshot.subtitleClips,
      showSubtitles: snapshot.showSubtitles,
      showSubtitleSpeaker: snapshot.showSubtitleSpeaker,
      subtitleSpeakerAlign: snapshot.subtitleSpeakerAlign,
      playhead: snapshot.playhead,
      savedAt: snapshot.savedAt,
      width: Math.max(16, Math.round(snapshot.customRecordingBounds.width)),
      height: Math.max(16, Math.round(snapshot.customRecordingBounds.height)),
      fps: snapshot.recordingQuality === "low" ? 24 : snapshot.recordingQuality === "high" ? 60 : 30,
    });
    sequenceHistoryRef.current?.reset(restoredDocument);
    projectGestureRef.current = null;
    setNavigationResetKey((key) => key + 1);
    sequenceProjectRef.current = restoredDocument;
    previewContextRef.current = { sequenceId: restoredDocument.rootSequenceId, time: snapshot.playhead };
    setPreviewSequenceId(restoredDocument.rootSequenceId);
    setPreviewFinalComposition(false);
    setSequenceSelection({ sequenceId: restoredDocument.rootSequenceId, clipIds: [] });
    sceneRuntimeRef.current?.setProject(restoredDocument);
    setSequenceProject(restoredDocument);
    setProjectPath(snapshot.projectPath);setSavedSignature(projectSignature(restoredDocument));
    libraryPreviewRef.current=false;setSelectedProjectAssetId(undefined);
    const legacyAsset = restoredDocument.assets["asset:model:main"];
    pendingMigrationRef.current = snapshot.version === 1 ? { motions: snapshot.motionClips, expressions: snapshot.exprClips } : legacyAsset?.metadata?.legacyMotions ? { motions: JSON.parse(String(legacyAsset.metadata.legacyMotions)), expressions: JSON.parse(String(legacyAsset.metadata.legacyExpressions ?? "[]")) } : null;
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
          setSavedSignature(snapshot.fileSignature ?? "");
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
      void saveAutosaveProject(snapshot).then(()=>saveRecovery(snapshot))
        .then(() => setLastAutosaveAt(new Date()))
        .catch((error) => {setSaveIssue("自动保存失败："+String(error));console.warn("自动保存工程失败",error);});
    }, 900);
    return () => window.clearTimeout(timer);
  }, [
    projectHydrated,
    projectPath,
    savedSignature,
    animation,
    selectedModel,
    selectedCharacterId,
    motionClips,
    exprClips,
    audioClips,
    subtitleClips,
    sequenceProject,
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

  const saveWorkspaceProject = async (asNew=false) => {
    if(savingRef.current)return;savingRef.current=true;setSaveBusy(true);setSaveIssue("");
    let temp:string|undefined;
    try {
      let path=(!asNew&&projectPath)||await save({title:asNew?"工程另存为":"保存 Live2D 工程",defaultPath:projectPath??`${sequenceProjectRef.current.name}.l2dproject`,filters:[{name:"Live2D 工程",extensions:["l2dproject"]}]});
      if(!path)return;
      try { temp=await invoke<string>("allow_project_write",{path,nonce:crypto.randomUUID()}); }
      catch(error) {
        if(!String(error).includes("请先在保存对话框"))throw error;
        path=await save({title:"重新授权工程保存位置",defaultPath:path,filters:[{name:"Live2D 工程",extensions:["l2dproject"]}]});
        if(!path)return;
        temp=await invoke<string>("allow_project_write",{path,nonce:crypto.randomUUID()});
      }
      const snapshot=makeProjectSnapshot();
      const bytes=await createProjectBundle(snapshot,modelRoot??undefined);
      await writeFile(temp,bytes);
      if(await exists(path))await copyFile(path,`${path}.bak`);
      await rename(temp,path);temp=undefined;
      setProjectPath(path);setSavedSignature(projectSignature(snapshot.document!));
      await saveAutosaveProject({...snapshot,projectPath:path,fileSignature:projectSignature(snapshot.document!)});await saveRecovery({...snapshot,projectPath:path,fileSignature:projectSignature(snapshot.document!)});
    } catch(error){setSaveIssue(`保存失败：${String(error)}`);}
    finally{if(temp)try{await remove(temp);}catch{/* Best effort temporary cleanup. */}savingRef.current=false;setSaveBusy(false);}
  };
  const workspaceSaveRef=useRef(saveWorkspaceProject);workspaceSaveRef.current=saveWorkspaceProject;
  useEffect(()=>{const key=(event:KeyboardEvent)=>{if((event.metaKey||event.ctrlKey)&&event.code==="KeyS"){event.preventDefault();void workspaceSaveRef.current(event.shiftKey);}};window.addEventListener("keydown",key);return()=>window.removeEventListener("keydown",key);},[]);

  const newWorkspaceProject = async () => {
    await saveRecovery(makeProjectSnapshot());
    canvasEditCancelRef.current?.();
    stopPlayback();
    endProjectEdit();
    const project = migrateLegacyProject({ selectedModel: null, motionClips: [], exprClips: [], audioClips: [], subtitleClips: [], playhead: 0 });
    project.id = crypto.randomUUID(); project.name = "新工程";
    setProjectPath(undefined);setSavedSignature("");
    changeSequenceProject(project);
    setNavigationResetKey((key) => key + 1);
    pendingMigrationRef.current = null;
    setAnimationIssue(null);
    setSequenceSelection({ sequenceId: project.rootSequenceId, clipIds: [] });
    setSelectedProjectAssetId(undefined);
    setPlayheadSec(0);
  };

  const openWorkspaceProject = async () => {
    try {
      const path = await open({
        multiple: false,
        title: "打开 Live2D 工程",
        filters: [{ name: "Live2D 工程", extensions: ["l2dproject"] }],
      });
      if (typeof path !== "string") return;
      await saveRecovery(makeProjectSnapshot());
      const snapshot = await openProjectBundle(path, modelRoot ?? undefined);
      snapshot.projectPath=path;
      if (modelRoot && snapshot.document) await refreshModels();
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
      sceneRuntimeRef.current = new SceneRuntime(app, sequenceProjectRef.current, {
        resolveAssetUrl: async (asset) => {
          if (/^(?:https?:|data:|blob:)/.test(asset.uri)) return asset.uri;
          if (/^(?:\/|[A-Za-z]:[\\/])/.test(asset.uri)) return buildExternalAssetUrl(await dirname(asset.uri), asset.uri);
          const base = assetBaseRef.current ?? (await invoke<{ base_url: string }>("get_model_server_info")).base_url;
          return `${base}/${asset.uri.split("/").map(encodeURIComponent).join("/")}`;
        },
        onParametersReady: (sequenceId, document, source) => {
          const current = sequenceProjectRef.current;
          const sequence = current.sequences[sequenceId];
          if (sequence?.kind !== "live2d" || sequence.animation !== source) return;
          const next = { ...current, sequences: { ...current.sequences, [sequenceId]: { ...sequence, animation: document } } };
          sequenceProjectRef.current = next;
          sequenceHistoryRef.current?.replaceCurrent(next);
          setSequenceProject(next);
        },
        onError: (message) => setAnimationIssue(message),
        onThumbnailReady: (assetId, thumbnail) => {
          const current = sequenceProjectRef.current;
          const asset = current.assets[assetId];
          if (!asset || asset.metadata?.thumbnail) return;
          const next = { ...current, assets: { ...current.assets, [assetId]: { ...asset, metadata: { ...asset.metadata, thumbnail } } } };
          sequenceProjectRef.current = next;
          sequenceHistoryRef.current?.replaceCurrent(next);
          setSequenceProject(next);
        },
      });

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
        if (exportInProgressRef.current) return;
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
        sceneRuntimeRef.current?.refreshPreview();
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
      sceneRuntimeRef.current?.destroy();
      sceneRuntimeRef.current = null;
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

  // ??????????
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // ????????????????
      if (e.defaultPrevented || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLButtonElement) {
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
      if (!libraryPreviewRef.current) return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
      const canvas = canvasRef.current;
      const app = appRef.current;
      if (!canvas || !app) return;

      const rect = canvas.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / Math.max(1, rect.width)) * app.screen.width;
      const y = ((event.clientY - rect.top) / Math.max(1, rect.height)) * app.screen.height;
      const overSelectedCharacter = getSelectedCharacterDisplayObjects().some((object) => {
        if (!object.visible) return false;
        try {
          const bounds = object.getBounds();
          return x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height;
        } catch { return false; }
      });
      if (!overSelectedCharacter) return;

      event.preventDefault();
      event.stopPropagation();
      const delta = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? event.deltaY * rect.height : event.deltaY;
      updateUniformScale(Math.exp(-Math.max(-240, Math.min(240, delta)) * 0.001));
    };

    const canvas = canvasRef.current;
    if (!canvas) return;
    const wheelListenerOptions: AddEventListenerOptions = { passive: false, capture: true };
    canvas.addEventListener("wheel", handleWheelTransform, wheelListenerOptions);
    return () => canvas.removeEventListener("wheel", handleWheelTransform, wheelListenerOptions);
  }, [modelUrl, selectedCharacterId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let wheelTimer: number | undefined;
    let cancelDrag: (() => void) | undefined;
    const finishCanvasEdit = () => {
      cancelDrag?.();
      if (wheelTimer !== undefined) { clearTimeout(wheelTimer); wheelTimer = undefined; endProjectEdit(); }
      if (canvasEditCancelRef.current === finishCanvasEdit) canvasEditCancelRef.current = null;
    };
    const commitFocusedInput = () => {
      const element = document.activeElement;
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) element.blur();
    };
    const point = (event: MouseEvent | WheelEvent) => {
      const rect = canvas.getBoundingClientRect(), app = appRef.current;
      return { x: (event.clientX - rect.left) / Math.max(1, rect.width) * (app?.screen.width ?? rect.width), y: (event.clientY - rect.top) / Math.max(1, rect.height) * (app?.screen.height ?? rect.height) };
    };
    const selectedTransform = () => {
      const selected = sequenceSelectionRef.current, project = sequenceProjectRef.current;
      const sequence = project.sequences[selected.sequenceId];
      if (!sequence) return null;
      if (selected.actorId && sequence.kind === "live2d") return sequence.actors.find((actor) => actor.id === selected.actorId)?.transform ?? null;
      const item = sequence.tracks.flatMap((track) => track.clips.map((clip) => ({ track, clip }))).find(({ clip }) => selected.clipIds.includes(clip.id));
      if (!item || item.track.locked || item.clip.kind === "audio") return null;
      return evaluateClipTransform(item.clip, item.clip.sourceIn + (previewContextRef.current.time - item.clip.start) * item.clip.rate);
    };
    const patchTransform = (value: Partial<import("../sequence/types").Transform>) => {
      const selected = sequenceSelectionRef.current, project = sequenceProjectRef.current;
      const sequence = project.sequences[selected.sequenceId];
      if (!sequence) return;
      if (selected.actorId && sequence.kind === "live2d") {
        changeSequenceProject({ ...project, sequences: { ...project.sequences, [sequence.id]: { ...sequence, actors: sequence.actors.map((actor) => actor.id === selected.actorId ? { ...actor, transform: { ...actor.transform, ...value } } : actor) } } });
        return;
      }
      const item = sequence.tracks.flatMap((track) => track.clips.map((clip) => ({ track, clip }))).find(({ clip }) => selected.clipIds.includes(clip.id));
      if (!item || item.track.locked) return;
      const sourceTime = Math.max(0, item.clip.sourceIn + (previewContextRef.current.time - item.clip.start) * item.clip.rate);
      const patch=editPropertiesAt(item.clip,sourceTime,value);
      changeSequenceProject(updateClip(project, sequence.id, item.track.id, item.clip.id, patch, sequence.fps));
    };
    const wheel = (event: WheelEvent) => {
      if (libraryPreviewRef.current || !enableDragging || exportState === "exporting") return;
      const p = point(event), hit = sceneRuntimeRef.current?.hitTest(p.x, p.y), selected = sequenceSelectionRef.current;
      if (!hit || hit.sequenceId !== selected.sequenceId || (hit.clipId ? !selected.clipIds.includes(hit.clipId) : hit.actorId !== selected.actorId)) return;
      const transform = selectedTransform();
      if (!transform) return;
      event.preventDefault(); event.stopPropagation();
      if (cancelDrag) finishCanvasEdit();
      if (wheelTimer !== undefined) clearTimeout(wheelTimer);
      commitFocusedInput();
      beginProjectEdit();
      canvasEditCancelRef.current = finishCanvasEdit;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1);
      const scale = Math.exp(-Math.max(-240, Math.min(240, delta)) * 0.001);
      patchTransform({ scaleX: Math.max(0.01, transform.scaleX * scale), scaleY: Math.max(0.01, transform.scaleY * scale) });
      wheelTimer = window.setTimeout(() => { wheelTimer = undefined; endProjectEdit(); if (canvasEditCancelRef.current === finishCanvasEdit) canvasEditCancelRef.current = null; }, 250);
    };
    const down = (event: MouseEvent) => {
      if (event.button !== 0 || libraryPreviewRef.current || !enableDragging || exportState === "exporting") return;
      const p = point(event), runtime = sceneRuntimeRef.current, hit = runtime?.hitTest(p.x, p.y);
      if (!hit || hit.sequenceId !== previewContextRef.current.sequenceId) return;
      finishCanvasEdit();
      commitFocusedInput();
      event.preventDefault(); event.stopPropagation(); stopPlayback();
      const selected = { sequenceId: hit.sequenceId, clipIds: hit.clipId ? [hit.clipId] : [], actorId: hit.actorId };
      sequenceSelectionRef.current = selected; setSequenceSelection(selected);
      const initial = selectedTransform(), origin = runtime?.pointInSequence(p.x, p.y);
      if (!initial || !origin) return;
      beginProjectEdit(); setIsDragging(true);
      canvasEditCancelRef.current = finishCanvasEdit;
      const move = (pointer: MouseEvent) => {
        const pos = point(pointer), local = runtime?.pointInSequence(pos.x, pos.y);
        if (!local) return;
        patchTransform({ x: initial.x + local.x - origin.x, y: initial.y + local.y - origin.y });
      };
      const up = (pointer: MouseEvent) => {
        move(pointer); finishCanvasEdit();
      };
      cancelDrag = () => {
        window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up);
        cancelDrag = undefined;
        endProjectEdit(); setIsDragging(false);
      };
      window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    };
    canvas.addEventListener("wheel", wheel, { passive: false, capture: true });
    canvas.addEventListener("mousedown", down, true);
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") finishCanvasEdit(); };
    window.addEventListener("blur", finishCanvasEdit);
    window.addEventListener("keydown", escape);
    return () => { canvas.removeEventListener("wheel", wheel, true); canvas.removeEventListener("mousedown", down, true); window.removeEventListener("blur", finishCanvasEdit); window.removeEventListener("keydown", escape); finishCanvasEdit(); };
  }, [projectHydrated, modelUrl, enableDragging, exportState]);

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
      libraryPreviewRef.current = true;
      if(rel){const current=sequenceProjectRef.current;const found=Object.values(current.assets).find(asset=>asset.kind==="live2d"&&asset.uri===rel);const asset=found??{id:`asset:model:${crypto.randomUUID()}`,kind:"live2d" as const,name:rel.split("/").pop()??rel,uri:rel,duration:5};if(!found)changeSequenceProject({...current,assets:{...current.assets,[asset.id]:asset}});setSelectedProjectAssetId(asset.id);}else setSelectedProjectAssetId(undefined);
      sceneRuntimeRef.current?.setVisible(false);
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
    projectAssets: Object.values(sequenceProject.assets).filter((asset) => asset.kind !== "live2d" || asset.missing),
    getMaterialSource,
    selectedProjectAssetId,
    projectAssetThumbnails,
    onSelectProjectAsset: (asset: ProjectAsset) => void previewProjectAsset(asset),
    onRepairAsset: (assetId: string) => void repairProjectAsset(assetId),
    onImportProjectAudio: () => void importProjectAudioAsset(),
    onImportProjectImage: () => void importProjectImageAsset(),
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
    projectFps: sequenceProject.sequences[previewSequenceId]?.fps ?? sequenceProject.fps,
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
    exportPhase,
    exportTime,
    exportProgress,
    onExportVideo: (format: VideoExportFormat, mode: VideoExportMode, includeAudio: boolean, method: VideoExportMethod) => {
      void exportVideo(format, mode, includeAudio, method);
    },
    onCancelExport: () => { recordingCancelRef.current = true;exportAbortRef.current?.abort(); },
    exportRangeAvailable:markedExportRange?.sequenceId===previewSequenceId,
    useMarkedExportRange,setUseMarkedExportRange,
    estimatedStorageBytes:estimateFrameStorage(sequenceProject.sequences[previewSequenceId]?.width??1920,sequenceProject.sequences[previewSequenceId]?.height??1080,Math.ceil((useMarkedExportRange&&markedExportRange?.sequenceId===previewSequenceId?markedExportRange.end-markedExportRange.start:sequenceDuration(sequenceProject.sequences[previewSequenceId]))*(sequenceProject.sequences[previewSequenceId]?.fps??30))),
    onExportSubtitlesSrt: exportSubtitlesSrt,
    onTakeScreenshot: () => screenshotManager.takeScreenshot(),
    onTakePartsScreenshots: () => screenshotManager.takePartsScreenshots(),
  };

  return (
    <div className="editor-shell">
      {showRecovery&&<RecoveryDialog projectId={sequenceProject.id} onClose={()=>setShowRecovery(false)} onRestore={async snapshot=>{await saveRecovery(makeProjectSnapshot());await applyProjectSnapshot(snapshot);setSavedSignature("");}}/>}
      <header className="editor-topbar" inert={exportState === "exporting" || saveBusy}>
        <div className="editor-topbar-brand">
          <h1>{sequenceProject.name}{savedSignature!==projectSignature(sequenceProject)?" · 未保存":""}</h1><span className="pane-note" role="status">{saveBusy?"保存中…":saveIssue|| (projectPath?"已关联工程文件":"自动恢复已启用")}</span>
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
              onChange={(event) => panelProps.onSelectModel(event.target.value || null)}
            >
              <option value="">{modelList.length === 0 ? "未发现模型" : "选择模型"}</option>
              {selectedModel && !modelList.includes(selectedModel) && <option value={selectedModel}>{selectedModel.split('/').pop()}</option>}
              {modelList.map((rel) => (
                <option key={rel} value={rel}>
                  {rel.split("/").pop()?.replace(/\.model3?\.json$/i,"")}
                </option>
              ))}
            </select>
          </div>

          <div className="topbar-button-group">
            <button className="btn btn--quiet" onClick={()=>void newWorkspaceProject()}>新建</button>
            <button className="btn btn--quiet" onClick={() => void openWorkspaceProject()}>打开</button>
            <button className="btn btn--quiet" disabled={saveBusy} onClick={() => void saveWorkspaceProject()}>保存</button><button className="btn btn--quiet" disabled={saveBusy} onClick={()=>void saveWorkspaceProject(true)}>另存为</button><button className="btn btn--quiet" onClick={()=>setShowRecovery(true)}>恢复</button><button className="btn btn--accent" onClick={()=>setActiveInspectorTab("export")}>导出</button>
            <button className="btn btn--quiet" onClick={refreshModels}>
              刷新
            </button>
            <button className="btn btn--accent" onClick={() => void importModel(false)} disabled={isImportingModel}>
              {isImportingModel ? "导入中…" : "＋ 导入模型"}
            </button>
            <button className={`btn ${isPlaying ? "btn--accent" : "btn--primary"}`} onClick={isPlaying||audioPreparing?stopPlayback:()=>void startPlayback()} disabled={!timelineLength && !isPlaying}>
              {audioPreparing?"准备声音…":isPlaying?"暂停":"播放"}
            </button>
            <button className="btn btn--quiet" onClick={importProjectAudioAsset}>
              导入音频素材
            </button>
            {/* WebGAL 入口暂时停用
            <button className="btn btn--quiet" onClick={() => setShowWebGALMode(true)}>
              WebGAL 工具
            </button>
            */}
          </div>
        </div>

      </header>

      <div
        className="editor-workspace"
        style={{ gridTemplateColumns: `${resourcePaneWidth}px 14px minmax(0, 1fr) 14px ${inspectorPaneWidth}px` }}
      >
        <aside className="workspace-dock workspace-dock--left" inert={exportState === "exporting"}>
          <ControlPanel
            {...panelProps}
            mode="resources"
          />
        </aside>

        <div
          className="workspace-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整素材面板宽度"
          tabIndex={0}
          onMouseDown={(event) => beginPanelResize("left", event)}
          aria-valuemin={paneWidthLimits("left").min}
          aria-valuemax={paneWidthLimits("left").max}
          aria-valuenow={resourcePaneWidth}
          onKeyDown={(event) => resizePaneWithKeyboard("left", event)}
        />

        <main className="editor-main" inert={exportState === "exporting"}>
          <section className="monitor-shell">
            <div className="monitor-stage">
              <div
                ref={containerRef}
                className={`monitor-canvas-host ${transparentBg ? "is-transparent" : "is-solid"}`}
                data-transparent={transparentBg}
              />

              {!selectedModel && !timelineLength && !selectedProjectAssetId ? (
                <div className="monitor-empty">
                  <span className="monitor-empty-mark" aria-hidden="true">✦</span>
                  <strong>拖入素材开始剪辑</strong>
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
                <select aria-label="预览质量" className="input" value={previewQuality} onChange={event=>setPreviewQuality(Number(event.target.value))}><option value="1">完整</option><option value="0.5">1/2</option><option value="0.25">1/4</option></select>
                {showPreviewInfo&&<><select aria-label="预览缓存预算" className="input" value={cacheBudget} onChange={event=>setCacheBudget(Number(event.target.value))}><option value="128">128 MiB</option><option value="256">256 MiB</option><option value="512">512 MiB</option></select><button className="btn btn--quiet" onClick={()=>{sceneRuntimeRef.current?.clearCache();void applyTimelineAtTime(previewContextRef.current.time);}}>清除缓存</button></>}
                <span>{selectedProjectAssetId && libraryPreviewRef.current ? sequenceProject.assets[selectedProjectAssetId]?.name : sequenceProject.sequences[previewSequenceId]?.name}</span>
              </div>


              {enableDragging&&<div className="monitor-overlay monitor-overlay--bottom"><button className="btn btn--quiet" title="显示帧率" onClick={()=>setShowPreviewInfo(value=>!value)}>信息</button>{showPreviewInfo&&<span>{currentFps.toFixed(1)} fps · {previewSequenceTime.toFixed(2)} 秒</span>}</div>}
            </div>
          </section>
          <AudioMeter read={audioManager.readOutputLevel}/>
          {libraryPreviewRef.current&&selectedProjectAssetId&&sequenceProject.assets[selectedProjectAssetId]&&!['motion','expression'].includes(sequenceProject.assets[selectedProjectAssetId].kind)&&<SourceMonitor key={selectedProjectAssetId} project={sequenceProject} asset={sequenceProject.assets[selectedProjectAssetId]} onAudioPlay={(time,playing)=>playSourceAudio(sequenceProject.assets[selectedProjectAssetId],time,playing)} onSeek={time=>{if(sequenceProject.assets[selectedProjectAssetId].kind!=="audio")void seekSourceAsset(sequenceProject.assets[selectedProjectAssetId],time);}} onBegin={beginProjectEdit} onEnd={endProjectEdit} onRange={(start,end)=>changeSourceRange(sequenceProject.assets[selectedProjectAssetId],start,end)} onClose={closeSourcePreview} onAdd={()=>{setAssetInsertRequest({assetId:selectedProjectAssetId,serial:Date.now()});closeSourcePreview();}}/>}
        </main>

        <div
          className="workspace-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整检查器宽度"
          tabIndex={0}
          onMouseDown={(event) => beginPanelResize("right", event)}
          aria-valuemin={paneWidthLimits("right").min}
          aria-valuemax={paneWidthLimits("right").max}
          aria-valuenow={inspectorPaneWidth}
          onKeyDown={(event) => resizePaneWithKeyboard("right", event)}
        />

        <aside className="workspace-dock workspace-dock--right">
          <div className="inspector-tabs" role="tablist" aria-label="检查器分页" inert={exportState === "exporting"}>
            {([['character', '检查器'], ['export', '导出'], ['project', '工程']] as const).map(([tab, label]) => <button key={tab} role="tab" aria-selected={activeInspectorTab === tab} className={`inspector-tab${activeInspectorTab === tab ? ' is-active' : ''}`} onClick={() => setActiveInspectorTab(tab)}>{label}</button>)}
          </div>
          {activeInspectorTab === "character" && libraryPreviewRef.current&&selectedProjectAssetId&&sequenceProject.assets[selectedProjectAssetId]?<section className="workspace-section"><header className="workspace-section-header"><h3 className="workspace-section-title">素材</h3></header><div className="workspace-section-body"><label className="field-stack"><span>名称</span><input className="input" value={sequenceProject.assets[selectedProjectAssetId].name} onFocus={beginProjectEdit} onBlur={endProjectEdit} onChange={event=>{const current=sequenceProjectRef.current;changeSequenceProject({...current,assets:{...current.assets,[selectedProjectAssetId]:{...current.assets[selectedProjectAssetId],name:event.target.value}}});}}/></label>{sequenceProject.assets[selectedProjectAssetId].missing&&<button className="btn btn--accent" onClick={()=>void repairProjectAsset(selectedProjectAssetId)}>重新链接</button>}<button className="btn btn--quiet" onClick={()=>{setAssetInsertRequest({assetId:selectedProjectAssetId,serial:Date.now()});closeSourcePreview();}}>加入时间线</button></div></section>:activeInspectorTab === "character" ? <SequenceInspector project={sequenceProject} onProjectChange={changeSequenceProject}
            selection={sequenceSelection} time={previewSequenceTime} linkedSelection={linkedClipSelection}
            onBeginEdit={() => { stopPlayback(); beginProjectEdit(); }} onEndEdit={endProjectEdit} /> : <>
              {activeInspectorTab === "export"&&exportIssue&&<div className="seq-tl-issue" role="alert"><span>{exportIssue}</span><button onClick={()=>retryExportRef.current?.()}>重试</button><button aria-label="关闭导出错误" onClick={()=>setExportIssue("")}>×</button></div>}
              {activeInspectorTab === "export" && <div className="pane-note">{sequenceProject.sequences[previewSequenceId]?.name} · {sequenceProject.sequences[previewSequenceId]?.width}×{sequenceProject.sequences[previewSequenceId]?.height} · {sequenceProject.sequences[previewSequenceId]?.fps} fps</div>}
              <ControlPanel {...panelProps} mode="inspector" activeInspectorTab={activeInspectorTab} hideInspectorTabs inspectorTabs={["export", "project"]} />
            </>}
        </aside>
      </div>

      <div
        className="timeline-resizer"
        role="separator"
        aria-orientation="horizontal"
        aria-label="调整时间线高度"
        tabIndex={0}
        aria-valuemin={150}
        aria-valuemax={Math.max(150, Math.min(640, window.innerHeight * 0.72))}
        aria-valuenow={Math.round(timelinePaneHeight)}
        onMouseDown={beginTimelineResize}
        onKeyDown={resizeTimelineWithKeyboard}
      />
      <section className="timeline-shell" style={{ flexBasis: `${timelinePaneHeight}px` }} inert={exportState === "exporting"}>
        {animationIssue && <div className="timeline-repair"><span>{animationIssue}</span><button className="btn btn--quiet" onClick={() => {
          if (modelData) setProjectRevision(revision => revision + 1);
          else if (appRef.current && modelUrl) void modelManager.loadAnyModel(appRef.current, modelUrl).catch(error => setAnimationIssue(`模型加载失败：${String(error)}`));
        }}>重试加载</button><button className="btn btn--quiet" onClick={() => void importModel(false)}>补充模型</button></div>}
        <Timeline
          project={sequenceProject}
          assetInsertRequest={assetInsertRequest}
          onRangeChange={(sequenceId,range)=>setMarkedExportRange(range?{sequenceId,...range}:undefined)}
          onTrackSelect={(sequenceId,trackId)=>{closeSourcePreview();setSequenceSelection({sequenceId,clipIds:[],trackId});}}
          navigationResetKey={navigationResetKey}
          onProjectChange={changeSequenceProject}
          onUndoProject={undoSequenceProject}
          onRedoProject={redoSequenceProject}
          onBeginProjectEdit={() => { stopPlayback(); beginProjectEdit(); }}
          onEndProjectEdit={endProjectEdit}
          onSelectionChange={(sequenceId, clipIds) => { setSequenceSelection({ sequenceId, clipIds }); if (clipIds.length) { libraryPreviewRef.current = false; void applyTimelineAtTime(previewContextRef.current.time); } }}
          externalSelection={sequenceSelection}
          linkedSelection={linkedClipSelection}
          onLinkedSelectionChange={setLinkedClipSelection}
          previewSequenceId={previewSequenceId}
          previewSequenceTime={previewSequenceTime}
          showInlineInspector={false}
          assetThumbnails={projectAssetThumbnails}
          onImportMaterial={(name, kind, start, source) => void addMaterial(name, kind, start, source)}
          onImportIntoSequence={importMaterialIntoSequence}
          onExportAnimation={exportSequenceAnimation}
          onSequenceAnimationChange={(sequenceId, document) => {
            const current = sequenceProjectRef.current;
            const target = current.sequences[sequenceId];
            if (target?.kind !== "live2d") return;
            changeSequenceProject({ ...current, sequences: { ...current.sequences, [sequenceId]: { ...target, animation: reconcileSourceEdits(target.animation, document) } } });
          }}
          animation={animation}
          onAnimationChange={changeAnimation}
          onBeginEdit={() => { stopPlayback(); beginEdit(); }}
          onEndEdit={endEdit}
          onUndo={undo}
          onRedo={redo}
          playheadSec={playhead}
          playheadSourceRef={rootPlayheadRef}
          onSetPlayhead={setPlayheadSec}
          onSeekSequence={seekSequence}
          audioSourceDuration={(clip) => clip.assetId ? sequenceProject.assets[clip.assetId]?.duration : undefined}
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
