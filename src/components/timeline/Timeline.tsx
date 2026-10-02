import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ParameterTimeline from "./ParameterTimeline";
import type { AnimationDocument } from "../../animation/types";
import type { AnimationExportOptions } from "../../animation/exporters";
import { emptyAnimation } from "../../animation/types";
import { addTrack, changeClipRate, clipVolumeAt, createCompound, createIndependentClip, deleteClips, evaluateClipTransform, removeEmptyTrack, reorderTrack, sequenceDuration, updateClip } from "../../sequence/engine";
import { editTimelineClip, linkedClipIds, linkedTrimDelta, linkClips, moveTimelineClips, pasteTimelineClips, rippleDeleteClips, rippleDeleteRanges, splitTimelineClips, trimLinkedClips, unlinkClips } from "../../sequence/editing";
import type { EditMode } from "../../sequence/editing";
import { adjacentEditTime, formatTimecode, parseTimecode } from "../../sequence/navigation";
import { assetRange } from "../../sequence/sourcePreview";
import { createClip, DEFAULT_TRANSFORM } from "../../sequence/types";
import type { Clip, ProjectAsset, ProjectDocument, Sequence, Transform, PropertyName } from "../../sequence/types";
import { propertyLabels } from "../../sequence/properties";
import { materialSourceFromAsset, parseMaterialSource } from "../../sequence/materials";
import type { MaterialSource } from "../../sequence/materials";
import "./sequenceTimeline.css";

type Props = {
  project: ProjectDocument;
  onProjectChange: (project: ProjectDocument) => void;
  onUndoProject: () => void;
  onRedoProject: () => void;
  onBeginProjectEdit?: () => void;
  onEndProjectEdit?: () => void;
  onSelectionChange?: (sequenceId: string, clipIds: string[]) => void;
  externalSelection?: { sequenceId: string; clipIds: string[] };
  showInlineInspector?: boolean;
  linkedSelection?: boolean;
  onLinkedSelectionChange?: (enabled: boolean) => void;
  assetInsertRequest?: { assetId: string; serial: number };
  onRangeChange?: (sequenceId:string, range:{start:number;end:number}|undefined)=>void;
  onTrackSelect?: (sequenceId:string,trackId:string)=>void;
  assetThumbnails?: Record<string, string>;
  navigationResetKey?: string | number;
  onImportMaterial: (name: string, kind: "motion" | "expression", start: number, source?: MaterialSource) => void;
  onImportIntoSequence?: (sequenceId: string, name: string, kind: "motion" | "expression", start: number, source?: MaterialSource) => void;
  onSequenceAnimationChange?: (sequenceId: string, document: AnimationDocument) => void;
  onExportAnimation?: (sequenceId: string, options: AnimationExportOptions) => Promise<string | undefined>;
  animation: AnimationDocument;
  onAnimationChange: (document: AnimationDocument) => void;
  onBeginEdit: () => void;
  onEndEdit: () => void;
  onUndo: () => void;
  onRedo: () => void;
  playheadSec: number;
  previewSequenceId?: string;
  previewSequenceTime?: number;
  playheadSourceRef?: { current: number };
  onSetPlayhead?: (time: number) => void;
  onSeekSequence?: (sequenceId: string, time: number, context?: SequenceSeekContext) => void;
  onStartPlayback?: () => void;
  onStopPlayback?: () => void;
  isPlaying?: boolean;
  audioSourceDuration?: (clip: Clip) => number | undefined;
};

export type SequenceSeekContext = { rootTime?: number; finalComposition?: boolean; instancePath?: string[] };
type PathEntry = {
  parentId: string; clipId: string; parentTime: number; childId: string;
  selection: string[]; focusedTrackId: string; scrollLeft: number; scrollTop: number; showParameters: boolean;
};
type ClipGhost = { id: string; trackId: string; start: number; duration: number; name: string; kind: string };
type DragPreview = { clips: ClipGhost[]; label: string; snapAt?: number; invalid?: boolean; createsTrack?: boolean; targetClipId?: string };
type Marquee = { left: number; top: number; width: number; height: number };
type ExternalDrag = { name: string; duration: number; kind: string };
const MATERIAL_MIME = "application/x-live2d-material";
const ASSET_MIME = "application/x-live2d-asset";
const pxPerSecondDefault = 72;
const clipColor: Record<string, string> = { live2d: "#738d4d", sequence: "#617950", image: "#568e8c", audio: "#ba8147", text: "#ac6854" };

export default function Timeline(p: Props) {
  const [zoom, setZoom] = useState(pxPerSecondDefault);
  const [currentId, setCurrentId] = useState(p.project.rootSequenceId);
  const [path, setPath] = useState<PathEntry[]>([]);
  const [nestedTime, setNestedTime] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [focusedTrackId, setFocusedTrackId] = useState("");
  const [showParameters, setShowParameters] = useState(false);
  const [finalComposition, setFinalComposition] = useState(false);
  const [snapping, setSnapping] = useState(true);
  const [editMode, setEditMode] = useState<EditMode>("free");
  const [localLinkedSelection, setLocalLinkedSelection] = useState(true);
  const linkedSelection = p.linkedSelection ?? localLinkedSelection;
  const setLinkedSelection = (enabled: boolean) => { setLocalLinkedSelection(enabled); p.onLinkedSelectionChange?.(enabled); };
  const [ranges, setRanges] = useState<Record<string, { start: number; end?: number }>>({});
  const [issue, setIssue] = useState("");
  const [timecodeDraft, setTimecodeDraft] = useState<string | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const [propertyKeyPreview, setPropertyKeyPreview] = useState<{ clipId: string; keyId: string; time: number } | null>(null);
  const [clipboard, setClipboard] = useState<Array<{ trackOffset: number; timeOffset: number; clip: Clip }>>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const restoringScroll = useRef<{ left: number; top: number } | null>(null);
  const suppressClick = useRef(false);
  const externalDragRef = useRef<ExternalDrag | null>(null);
  const previousProjectId = useRef(p.project.id);
  const previousNavigationResetKey = useRef(p.navigationResetKey);
  const gestureCancelRef = useRef<(() => void) | null>(null);
  const seekCallbackRef = useRef(p.onSeekSequence);
  seekCallbackRef.current = p.onSeekSequence;
  const selectionCallbackRef = useRef(p.onSelectionChange);
  selectionCallbackRef.current = p.onSelectionChange;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const suppressSelectionNotify = useRef(false);
  const skipExternalSelectionAfterNavigation = useRef(false);
  const sequence = p.project.sequences[currentId] ?? p.project.sequences[p.project.rootSequenceId];
  const parameterDocument = sequence.kind === "live2d" ? sequence.animation : p.animation;
  const tracks = sequence.tracks.slice().sort((a, b) => a.order - b.order);
  const localTime = currentId === p.project.rootSequenceId ? p.playheadSec
    : p.previewSequenceId === currentId && p.previewSequenceTime !== undefined ? p.previewSequenceTime : nestedTime[currentId] ?? 0;
  const localTimeRef = useRef(localTime);
  localTimeRef.current = localTime;
  const duration = Math.max(sequenceDuration(sequence), 5);
  const width = Math.max(1000, (duration + 2) * zoom);
  const selectedItems = useMemo(() => tracks.flatMap((track) => track.clips.filter((clip) => selected.includes(clip.id)).map((clip) => ({ track, clip }))), [tracks, selected]);
  const mode = sequence.kind === "edit" ? editMode : "free";
  const markedRange = ranges[currentId];
  const rangeCallback=useRef(p.onRangeChange);rangeCallback.current=p.onRangeChange;
  useEffect(()=>rangeCallback.current?.(currentId,markedRange?.end!=null?{start:markedRange.start,end:markedRange.end}:undefined),[currentId,markedRange]);
  const expandSelection = (ids: string[], bypass = false) => linkedSelection && !bypass ? linkedClipIds(sequence, ids) : ids.filter((id) => tracks.some((track) => track.clips.some((clip) => clip.id === id)));
  const edit = (command: (project: ProjectDocument) => ProjectDocument) => {
    try { p.onProjectChange(command(p.project)); setIssue(""); return true; }
    catch (error) { setIssue(error instanceof Error ? error.message : String(error)); return false; }
  };
  const frame = 1 / sequence.fps;
  const timeAt = (clientX: number) => {
    const rect = scrollRef.current?.getBoundingClientRect();
    return Math.max(0, ((clientX - (rect?.left ?? 0)) + (scrollRef.current?.scrollLeft ?? 0) - 124) / zoom);
  };
  const rootTimeAt = (time: number, entries = path): number | undefined => {
    let value = time;
    for (const entry of entries.slice().reverse()) {
      const clip = p.project.sequences[entry.parentId]?.tracks.flatMap((track) => track.clips).find((item) => item.id === entry.clipId);
      if (!clip || value < clip.sourceIn - 1e-7 || value >= clip.sourceIn + clip.duration * clip.rate - 1e-7) return undefined;
      value = clip.start + (value - clip.sourceIn) / clip.rate;
    }
    return value;
  };
  const notifySeek = (sequenceId: string, time: number, entries = path, final = finalComposition) => {
    seekCallbackRef.current?.(sequenceId, time, {
      rootTime: rootTimeAt(time, entries), finalComposition: final,
      instancePath: entries.map((entry) => entry.clipId),
    });
  };
  const navigationStateRef = useRef({ nestedTime, finalComposition, playheadSec: p.playheadSec, stopPlayback: p.onStopPlayback, setPlayhead: p.onSetPlayhead, notifySeek });
  navigationStateRef.current = { nestedTime, finalComposition, playheadSec: p.playheadSec, stopPlayback: p.onStopPlayback, setPlayhead: p.onSetPlayhead, notifySeek };
  useEffect(() => {
    const latest = navigationStateRef.current;
    const projectChanged = previousProjectId.current !== p.project.id || previousNavigationResetKey.current !== p.navigationResetKey;
    previousProjectId.current = p.project.id;
    previousNavigationResetKey.current = p.navigationResetKey;
    let validDepth = 0;
    let validId = p.project.rootSequenceId;
    if (!projectChanged) for (const entry of path) {
      if (entry.parentId !== validId || !p.project.sequences[entry.childId] || !p.project.sequences[entry.parentId]?.tracks.some((track) => track.clips.some((clip) => clip.id === entry.clipId && clip.sequenceId === entry.childId))) break;
      validDepth += 1; validId = entry.childId;
    }
    if (!projectChanged && validDepth === path.length && currentId === validId && p.project.sequences[currentId]) return;
    gestureCancelRef.current?.(); latest.stopPlayback?.();
    const target = p.project.sequences[validId];
    const snapshot = projectChanged ? undefined : path[validDepth];
    const nextPath = projectChanged ? [] : path.slice(0, validDepth);
    const nextTime = Math.max(0, Math.min(Math.max(sequenceDuration(target), 5), snapshot?.parentTime ?? (validId === p.project.rootSequenceId ? latest.playheadSec : latest.nestedTime[validId] ?? 0)));
    const validClipIds = new Set(target.tracks.flatMap((track) => track.clips.map((clip) => clip.id)));
    skipExternalSelectionAfterNavigation.current = true;
    setCurrentId(validId); setPath(nextPath);
    setSelected(snapshot?.selection.filter((id) => validClipIds.has(id)) ?? []);
    setShowParameters(target.kind === "live2d" && !!snapshot?.showParameters);
    setFocusedTrackId(target.tracks.some((track) => track.id === snapshot?.focusedTrackId) ? snapshot!.focusedTrackId : "");
    setNestedTime(projectChanged ? {} : { ...latest.nestedTime, [validId]: nextTime });
    restoringScroll.current = { left: snapshot?.scrollLeft ?? 0, top: snapshot?.scrollTop ?? 0 };
    if (projectChanged) { setClipboard([]); setFinalComposition(false); }
    if (validId === p.project.rootSequenceId) latest.setPlayhead?.(nextTime);
    latest.notifySeek(validId, nextTime, nextPath, projectChanged ? false : latest.finalComposition);
  }, [p.project, p.navigationResetKey, currentId, path]);
  useEffect(() => { gestureCancelRef.current?.(); }, [p.project, currentId, showParameters]);
  useEffect(() => {
    const cancel = () => gestureCancelRef.current?.();
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") cancel(); };
    window.addEventListener("blur", cancel); window.addEventListener("keydown", escape);
    return () => { cancel(); window.removeEventListener("blur", cancel); window.removeEventListener("keydown", escape); };
  }, []);
  useEffect(() => {
    const current = p.project.sequences[currentId];
    if (!current) return;
    const ids = new Set(current.tracks.flatMap((track) => track.clips.map((clip) => clip.id)));
    const next = selectedRef.current.filter((id) => ids.has(id));
    if (next.length !== selectedRef.current.length) setSelected(next);
  }, [p.project.sequences, p.project.rootSequenceId, currentId]);
  useEffect(() => {
    if (suppressSelectionNotify.current) { suppressSelectionNotify.current = false; return; }
    selectionCallbackRef.current?.(currentId, selected);
  }, [currentId, selected]);
  useEffect(() => {
    if (skipExternalSelectionAfterNavigation.current) { skipExternalSelectionAfterNavigation.current = false; return; }
    const external = p.externalSelection;
    if (!external || external.sequenceId !== currentId) return;
    const previous = selectedRef.current;
    if (previous.length !== external.clipIds.length || previous.some((id, index) => id !== external.clipIds[index])) {
      const expanded = linkedSelection ? linkedClipIds(sequence, external.clipIds) : [...external.clipIds];
      suppressSelectionNotify.current = expanded.length === external.clipIds.length;
      setSelected(expanded);
    }
  }, [p.externalSelection, currentId, linkedSelection, sequence]);
  useEffect(() => { skipExternalSelectionAfterNavigation.current = false; }, [currentId, path]);
  useEffect(() => {
    const start = (event: DragEvent) => {
      const transfer = event.dataTransfer;
      if (!transfer) return;
      try {
        const raw = transfer.getData(ASSET_MIME);
        if (!raw) return;
        const payload = JSON.parse(raw) as { assetId?: string; modelPath?: string; name?: string };
        const asset = payload.assetId ? p.project.assets[payload.assetId] : undefined;
        const sequenceId = asset?.metadata?.sequenceId;
        const child = typeof sequenceId === "string" ? p.project.sequences[sequenceId] : undefined;
        const childDuration = child ? Math.max(1 / sequence.fps, sequenceDuration(child)) : undefined;
        externalDragRef.current = { name: asset?.name ?? payload.name ?? "素材", kind: asset?.kind ?? "sequence", duration: asset ? assetRange(p.project, asset).duration : childDuration ?? 5 };
      } catch { externalDragRef.current = null; }
    };
    const end = () => { externalDragRef.current = null; setDragPreview(null); };
    window.addEventListener("dragstart", start); window.addEventListener("dragend", end);
    return () => { window.removeEventListener("dragstart", start); window.removeEventListener("dragend", end); };
  }, [p.project, sequence.fps]);
  useLayoutEffect(() => {
    const saved = restoringScroll.current;
    if (!saved) return;
    const element = showParameters ? rootRef.current?.querySelector<HTMLElement>(".parameter-scroll") : scrollRef.current;
    if (element) { element.scrollLeft = saved.left; element.scrollTop = saved.top; }
    restoringScroll.current = null;
  }, [currentId, showParameters, path, p.project.id, p.navigationResetKey]);
  const snapTime = (value: number, excludedIds: string[] = [], offsets: number[] = [0], bypass = false) => {
    const framed = Math.max(0, Math.round(value / frame) * frame);
    if (!snapping || bypass) return { value: framed, snapAt: undefined as number | undefined };
    const points = [0, localTime, ...tracks.flatMap((track) => track.clips.filter((clip) => !excludedIds.includes(clip.id)).flatMap((clip) => [clip.start, clip.start + clip.duration]))];
    let nearest = 8 / zoom;
    let snapped = framed;
    let snapAt: number | undefined;
    for (const point of points) for (const offset of offsets) {
      const candidate = point - offset;
      const distance = Math.abs(candidate - framed);
      if (candidate >= 0 && distance < nearest) { nearest = distance; snapped = candidate; snapAt = point; }
    }
    return { value: Math.round(snapped / frame) * frame, snapAt };
  };
  const seek = (next: number) => {
    const value = Math.max(0, Math.min(duration, Math.round(next / frame) * frame));
    if (currentId === p.project.rootSequenceId) p.onSetPlayhead?.(value);
    else {
      setNestedTime((previous) => ({ ...previous, [currentId]: value }));
    }
    notifySeek(currentId, value);
  };
  const navigate = (time: number) => { p.onStopPlayback?.(); seek(time); };
  const markRange = (edge: "in" | "out") => setRanges((previous) => {
    const old = previous[currentId] ?? { start: 0 };
    return { ...previous, [currentId]: edge === "in"
      ? { start: localTime, end: old.end != null && old.end > localTime ? old.end : undefined }
      : { start: Math.min(old.start, Math.max(0, localTime - frame)), end: localTime > 0 ? localTime : undefined } };
  });
  const fitTimeline = () => {
    setZoom(Math.max(0.1, Math.min(360, ((scrollRef.current?.clientWidth ?? 900) - 148) / Math.max(1, sequenceDuration(sequence)))));
    if (scrollRef.current) scrollRef.current.scrollLeft = 0;
  };
  const splitSelection = () => {
    const ids = selected.length ? expandSelection(selected) : tracks.filter((track) => !track.locked).flatMap((track) => track.clips.filter((clip) => localTime > clip.start && localTime < clip.start + clip.duration).map((clip) => clip.id));
    edit((project) => splitTimelineClips(project, currentId, ids, localTime));
  };
  const deleteSelection = (ripple = false) => {
    const ids = expandSelection(selected);
    if (!ids.length && !(ripple && markedRange?.end != null)) return;
    let next: ProjectDocument | undefined;
    const start = ids.length ? Math.min(...selectedItems.map(({ clip }) => clip.start)) : markedRange!.start;
    if (edit((project) => {
      next = ripple ? ids.length ? rippleDeleteClips(project, currentId, ids)
        : rippleDeleteRanges(project, currentId, [{ start: markedRange!.start, end: markedRange!.end! }])
        : deleteClips(project, currentId, ids);
      return next;
    })) {
      setSelected([]);
      if (ripple) {
        p.onStopPlayback?.();
        seek(Math.min(start, sequenceDuration(next!.sequences[currentId])));
        setRanges((previous) => ({ ...previous, [currentId]: { start: 0 } }));
      }
    }
  };
  useEffect(() => { setRanges({}); setIssue(""); setTimecodeDraft(null); }, [p.project.id, p.navigationResetKey]);
  useEffect(() => { setTimecodeDraft(null); setIssue(""); }, [currentId]);
  useEffect(() => {
    const valid = new Set(sequence.tracks.flatMap((track) => track.clips.map((clip) => clip.id)));
    setSelected((previous) => previous.some((id) => !valid.has(id)) ? previous.filter((id) => valid.has(id)) : previous);
  }, [sequence]);
  useEffect(() => {
    if (!p.isPlaying || showParameters || !scrollRef.current) return;
    const body = scrollRef.current, x = localTime * zoom;
    if (x < body.scrollLeft || x > body.scrollLeft + body.clientWidth - 156) body.scrollLeft = Math.max(0, x - (body.clientWidth - 156) / 3);
  }, [localTime, p.isPlaying, showParameters, zoom]);
  const startRulerDrag = (event: React.MouseEvent) => {
    if (event.button !== 0) return;
    event.preventDefault(); rootRef.current?.focus({ preventScroll: true }); gestureCancelRef.current?.(); p.onStopPlayback?.(); seek(timeAt(event.clientX));
    const move = (pointer: MouseEvent) => seek(timeAt(pointer.clientX));
    const up = (pointer: MouseEvent) => { cancel(); seek(timeAt(pointer.clientX)); };
    const cancel = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); gestureCancelRef.current = null; };
    gestureCancelRef.current = cancel;
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };
  const enter = (clip: Clip) => {
    if (!clip.sequenceId || !p.project.sequences[clip.sequenceId]) return;
    p.onStopPlayback?.();
    const element = showParameters ? rootRef.current?.querySelector<HTMLElement>(".parameter-scroll") : scrollRef.current;
    const nextPath = [...path, { parentId: currentId, clipId: clip.id, parentTime: localTime, childId: clip.sequenceId,
      selection: [...selected], focusedTrackId, scrollLeft: element?.scrollLeft ?? 0, scrollTop: element?.scrollTop ?? 0, showParameters }];
    setPath(nextPath);
    skipExternalSelectionAfterNavigation.current = true;
    const childTime = clip.sourceIn + (localTime >= clip.start && localTime < clip.start + clip.duration ? localTime - clip.start : 0) * clip.rate;
    setNestedTime((previous) => ({ ...previous, [clip.sequenceId!]: childTime }));
    setCurrentId(clip.sequenceId);
    setSelected([]); setFocusedTrackId(""); setShowParameters(p.project.sequences[clip.sequenceId].kind === "live2d");
    restoringScroll.current = { left: 0, top: 0 };
    notifySeek(clip.sequenceId, childTime, nextPath);
  };
  const leave = (depth: number) => {
    if (depth < 0 || depth >= path.length) return;
    p.onStopPlayback?.();
    const entry = path[depth];
    const nextPath = path.slice(0, depth);
    skipExternalSelectionAfterNavigation.current = true;
    setCurrentId(entry.parentId);
    setPath(nextPath);
    setSelected(entry.selection); setFocusedTrackId(entry.focusedTrackId); setShowParameters(entry.showParameters);
    restoringScroll.current = { left: entry.scrollLeft, top: entry.scrollTop };
    if (entry.parentId === p.project.rootSequenceId) p.onSetPlayhead?.(entry.parentTime);
    else setNestedTime((previous) => ({ ...previous, [entry.parentId]: entry.parentTime }));
    notifySeek(entry.parentId, entry.parentTime, nextPath);
  };
  const addText = () => {
    const id = crypto.randomUUID();
    const asset: ProjectAsset = { id: `asset:${id}`, kind: "text", name: "文字", uri: "", metadata: { fontFamily: "sans-serif", fontSize: 34, color: "#ffffff" } };
    const withAsset = { ...p.project, assets: { ...p.project.assets, [asset.id]: asset } };
    let next = withAsset;
    const existingTrack = tracks.find((item) => item.id === focusedTrackId && !item.locked) ?? tracks.find((item) => !item.locked);
    let targetTrackId = existingTrack?.id;
    if (!targetTrackId) {
      next = addTrack(next, currentId);
      targetTrackId = next.sequences[currentId].tracks.slice().sort((a, b) => b.order - a.order)[0].id;
    }
    const clip = createClip({ id, kind: "text", assetId: asset.id, name: "文字", text: "双击编辑", start: localTime, duration: 3 });
    if (edit(() => editTimelineClip(next, currentId, targetTrackId!, clip, mode).project)) setSelected([id]);
  };
  const addDroppedAsset = (assetId: string, trackId: string, at: number, supplied?: ProjectAsset, targetClipId?: string) => {
    const asset = supplied ?? p.project.assets[assetId];
    if (!asset) return;
    if (asset.kind === "motion" || asset.kind === "expression") {
      importMaterialAt(asset.name, asset.kind, at, targetClipId, materialSourceFromAsset(asset) ?? undefined);
      return;
    }
    let next = supplied ? { ...p.project, assets: { ...p.project.assets, [asset.id]: asset } } : p.project;
    let clip: Clip;
    if (asset.kind === "sequence") {
      const sequenceId = asset.metadata?.sequenceId;
      if (typeof sequenceId !== "string") return;
      const child = p.project.sequences[sequenceId];
      if (!child) throw new Error("复合素材的序列已丢失。");
      clip = createClip({ kind: "sequence", sequenceId, name: asset.name, start: at, duration: Math.max(frame, sequenceDuration(child)) });
    } else if (asset.kind === "live2d") {
      const childId = crypto.randomUUID();
      const actorId = crypto.randomUUID();
      const child: Sequence = {
        id: childId, name: asset.name, kind: "live2d", width: p.project.width, height: p.project.height,
        fps: p.project.fps, duration: asset.duration ?? 5, tracks: [],
        actors: [{ id: actorId, assetId: asset.id, modelPartId: actorId, name: asset.name, transform: { ...DEFAULT_TRANSFORM }, visible: true }],
        animation: structuredClone(emptyAnimation()),
      };
      next = { ...next, sequences: { ...next.sequences, [childId]: child } };
      clip = createClip({ kind: "sequence", sequenceId: childId, name: asset.name, start: at, duration: Math.max(frame, sequenceDuration(child)) });
    } else {
      clip = createClip({ kind: asset.kind, assetId: asset.id, name: asset.name, start: at, duration: asset.duration ?? (asset.kind === "text" ? 3 : 5) });
    }
    const range = assetRange(next,asset);
    clip = {...clip,sourceIn:range.sourceIn,duration:Math.max(frame,range.duration)};
    let target = tracks.find((track) => track.id === trackId) ?? tracks[0];
    if (!target) {
      next = addTrack(next, currentId);
      target = next.sequences[currentId].tracks[0];
    }
    const inserted = editTimelineClip(next, currentId, target.id, clip, mode);
    p.onProjectChange(inserted.project);
    setIssue("");
    setSelected([clip.id]);
  };
  const assetInsertRef=useRef<()=>void>(()=>{});assetInsertRef.current=()=>{const request=p.assetInsertRequest;if(request)addDroppedAsset(request.assetId,focusedTrackId,localTime,undefined,selectedItems[0]?.clip.id);};
  useEffect(()=>{const request=p.assetInsertRequest;if(!request)return;try{assetInsertRef.current();}catch(error){setIssue(String(error));}},[p.assetInsertRequest]);
  const onDrop = (event: React.DragEvent, trackId: string) => {
    event.preventDefault();
    event.stopPropagation();
    setDragPreview(null);
    const at = snapTime(timeAt(event.clientX), [], [0], event.altKey).value;
    if (tracks.find((track) => track.id === trackId)?.locked) return;
    const rawAsset = event.dataTransfer.getData(ASSET_MIME);
    if (rawAsset) {
      try {
        const payload = JSON.parse(rawAsset) as { assetId?: string; modelPath?: string; name?: string };
        const targetId = (event.target as HTMLElement).closest<HTMLElement>("[data-clip-id]")?.dataset.clipId;
        if (payload.assetId) addDroppedAsset(payload.assetId, trackId, at, undefined, targetId);
        else if (payload.modelPath) {
          const existing=Object.values(p.project.assets).find(asset=>asset.kind==="live2d"&&asset.uri===payload.modelPath);
          const assetId=existing?.id??`asset:model:${crypto.randomUUID()}`;
          addDroppedAsset(assetId,trackId,at,existing??{id:assetId,kind:"live2d",name:payload.name??payload.modelPath,uri:payload.modelPath,duration:5});
        }
      }
      catch (error) { setIssue(error instanceof Error ? error.message : "无法放入该素材。"); }
      return;
    }
    const material = event.dataTransfer.getData(MATERIAL_MIME);
    if (material) {
      try {
        const payload = JSON.parse(material) as { name?: string; kind?: string; source?: unknown };
        if (payload.name && (payload.kind === "motion" || payload.kind === "expression")) {
          const targetId = (event.target as HTMLElement).closest<HTMLElement>("[data-clip-id]")?.dataset.clipId;
          importMaterialAt(payload.name, payload.kind, at, targetId, payload.source ? parseMaterialSource(payload.source) : undefined);
        }
      } catch (error) { setIssue(error instanceof Error ? error.message : "无法导入该素材。"); }
    }
  };
  const importMaterialAt = (name: string, kind: "motion" | "expression", at: number, targetClipId?: string, source?: MaterialSource) => {
    if (sequence.kind === "live2d") {
      if (p.onImportIntoSequence) p.onImportIntoSequence(sequence.id, name, kind, at, source);
      else p.onImportMaterial(name, kind, at, source);
      return;
    }
    const target = tracks.filter((track) => !track.locked).flatMap((track) => track.clips)
      .find((clip) => clip.id === targetClipId && clip.kind === "sequence" && clip.sequenceId && p.project.sequences[clip.sequenceId]?.kind === "live2d" && at >= clip.start && at <= clip.start + clip.duration);
    if (!target?.sequenceId) { setIssue("动作和表情需要放到 Live2D 片段上。请将素材拖到对应片段中。"); return; }
    const sourceTime = target.sourceIn + (at - target.start) * target.rate;
    if (p.onImportIntoSequence) p.onImportIntoSequence(target.sequenceId, name, kind, sourceTime, source);
    else p.onImportMaterial(name, kind, sourceTime, source);
  };
  const previewDrop = (event: React.DragEvent, trackId: string) => {
    if (!event.dataTransfer.types.includes(ASSET_MIME) && !event.dataTransfer.types.includes(MATERIAL_MIME)) return;
    event.preventDefault(); event.stopPropagation();
    const track = tracks.find((item) => item.id === trackId);
    const { value: start, snapAt } = snapTime(timeAt(event.clientX), [], [0], event.altKey);
    if (event.dataTransfer.types.includes(MATERIAL_MIME) || externalDragRef.current?.kind === "motion" || externalDragRef.current?.kind === "expression") {
      const targetId = (event.target as HTMLElement).closest<HTMLElement>("[data-clip-id]")?.dataset.clipId;
      const target = track?.clips.find((clip) => clip.id === targetId);
      const valid = !track?.locked && (sequence.kind === "live2d" || !!target?.sequenceId && p.project.sequences[target.sequenceId]?.kind === "live2d");
      event.dataTransfer.dropEffect = valid ? "copy" : "none";
      setDragPreview({ clips: [], label: valid ? `${start.toFixed(2)} 秒` : track?.locked ? "轨道已锁定" : "需要 Live2D 片段", snapAt, invalid: !valid, targetClipId: valid ? targetId : undefined });
      return;
    }
    const invalid = !!track?.locked;
    event.dataTransfer.dropEffect = invalid ? "none" : "copy";
    const draggedAsset = externalDragRef.current;
    const duration = draggedAsset?.duration ?? 5;
    const createsTrack = mode === "free" && track?.clips.some((clip) => start < clip.start + clip.duration && start + duration > clip.start);
    setDragPreview({ clips: [{ id: "drop", trackId, start, duration, name: draggedAsset?.name ?? "素材", kind: draggedAsset?.kind ?? "sequence" }], label: invalid ? "轨道已锁定" : `${formatTimecode(start, sequence.fps)} · ${mode === "insert" ? "插入" : mode === "overwrite" ? "覆盖" : createsTrack ? "新轨道" : "放置"}`, snapAt, invalid, createsTrack });
  };
  const startClipDrag = (event: React.MouseEvent, trackId: string, clip: Clip, edge?: "left" | "right") => {
    if (event.button !== 0) return;
    gestureCancelRef.current?.();
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.closest<HTMLElement>(".tl-root")?.focus();
    setFocusedTrackId(trackId);
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    const clicked = expandSelection([clip.id], event.altKey);
    const movingIds = edge ? clicked : additive ? selected.includes(clip.id) ? selected.filter((id) => !clicked.includes(id)) : [...new Set([...selected, ...clicked])] : selected.includes(clip.id) && !event.altKey ? expandSelection(selected) : clicked;
    setSelected(movingIds);
    if (tracks.find((track) => track.id === trackId)?.locked || !movingIds.includes(clip.id)) return;
    const originX = event.clientX;
    const originY = event.clientY;
    const originScrollLeft = scrollRef.current?.scrollLeft ?? 0;
    const moving = tracks.flatMap((track) => track.clips.filter((item) => movingIds.includes(item.id)).map((item) => ({ track, clip: item })));
    const originalTrack = tracks.find((track) => track.id === trackId)!;
    let dragged = false;
    const dragPosition = (pointer: MouseEvent, autoScroll = true) => {
      const scroll = scrollRef.current;
      const rect = scroll?.getBoundingClientRect();
      if (autoScroll && scroll && rect) {
        if (pointer.clientX > rect.right - 28) scroll.scrollLeft += 14;
        else if (pointer.clientX < rect.left + 148) scroll.scrollLeft = Math.max(0, scroll.scrollLeft - 14);
      }
      const row = document.elementFromPoint(pointer.clientX, pointer.clientY)?.closest<HTMLElement>("[data-track-id]");
      const targetTrack = tracks.find((track) => track.id === row?.dataset.trackId) ?? originalTrack;
      const rawDelta = (pointer.clientX - originX + (scroll?.scrollLeft ?? 0) - originScrollLeft) / zoom;
      const originalEdge = clip.start + (edge === "right" ? clip.duration : 0);
      const offsets = edge ? [0] : moving.flatMap(({ clip: item }) => [item.start - clip.start, item.start + item.duration - clip.start]);
      const snapped = snapTime(originalEdge + rawDelta, edge ? [clip.id] : movingIds, offsets, pointer.altKey);
      let delta = snapped.value - originalEdge;
      let ghosts: ClipGhost[];
      if (edge) {
        delta = linkedTrimDelta(p.project, currentId, movingIds, edge, delta);
        ghosts = moving.map(({ track, clip: item }) => ({ id: item.id, trackId: track.id, start: item.start + (edge === "left" ? delta : 0), duration: item.duration + (edge === "left" ? -delta : delta), name: item.name, kind: item.kind }));
      } else {
        delta = Math.max(-Math.min(...moving.map(({ clip: item }) => item.start)), delta);
        const orderDelta = Math.max(-Math.min(...moving.map(({ track }) => track.order)), targetTrack.order - originalTrack.order);
        ghosts = moving.map(({ track, clip: item }) => ({ id: item.id, trackId: tracks.find((candidate) => candidate.order === track.order + orderDelta)?.id ?? targetTrack.id, start: item.start + delta, duration: item.duration, name: item.name, kind: item.kind }));
      }
      const invalid = moving.some(({ track }) => track.locked) || targetTrack.locked || ghosts.some((ghost) => tracks.find((track) => track.id === ghost.trackId)?.locked);
      const createsTrack = (edge || mode === "free") && ghosts.some((ghost) => tracks.find((track) => track.id === ghost.trackId)?.clips.some((item) => !movingIds.includes(item.id) && ghost.start < item.start + item.duration && ghost.start + ghost.duration > item.start));
      return { delta, targetTrackId: targetTrack.id, preview: { clips: ghosts, label: invalid ? "轨道已锁定" : `${ghosts[0]?.start.toFixed(2)} 秒${createsTrack ? " · 新轨道" : ""}`, snapAt: snapped.snapAt, invalid, createsTrack } };
    };
    const onMove = (moveEvent: MouseEvent) => {
      if (Math.abs(moveEvent.clientX - originX) + Math.abs(moveEvent.clientY - originY) > 3) dragged = true;
      if (dragged) setDragPreview(dragPosition(moveEvent).preview);
    };
    const onUp = (upEvent: MouseEvent) => {
      cancel();
      if (!dragged) return;
      suppressClick.current = true;
      const { delta, targetTrackId, preview } = dragPosition(upEvent, false);
      if (preview.invalid) return;
      if (edge) edit((project) => trimLinkedClips(project, currentId, movingIds, edge, delta));
      else if (targetTrackId !== trackId || delta !== 0) edit((project) => moveTimelineClips(project, currentId, movingIds, clip.id, targetTrackId, clip.start + delta, mode));
    };
    const cancel = () => {
      window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp);
      gestureCancelRef.current = null; setDragPreview(null);
    };
    gestureCancelRef.current = cancel;
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  const startMarquee = (event: React.MouseEvent) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest(".seq-clip,.seq-tl-ruler,.seq-tl-track-head,button,input")) return;
    gestureCancelRef.current?.();
    rootRef.current?.focus({ preventScroll: true });
    const body = scrollRef.current;
    if (!body) return;
    const bodyRect = body.getBoundingClientRect();
    const origin = { x: event.clientX - bodyRect.left + body.scrollLeft, y: event.clientY - bodyRect.top + body.scrollTop };
    const baseline = event.shiftKey || event.ctrlKey || event.metaKey ? selected : [];
    let dragged = false;
    const onMove = (pointer: MouseEvent) => {
      const x = pointer.clientX - bodyRect.left + body.scrollLeft;
      const y = pointer.clientY - bodyRect.top + body.scrollTop;
      if (Math.abs(x - origin.x) + Math.abs(y - origin.y) < 4 && !dragged) return;
      dragged = true;
      const box = { left: Math.min(x, origin.x), top: Math.min(y, origin.y), width: Math.abs(x - origin.x), height: Math.abs(y - origin.y) };
      setMarquee(box);
      const hits = Array.from(body.querySelectorAll<HTMLElement>("[data-clip-id]")).filter((element) => {
        const rect = element.getBoundingClientRect();
        const left = rect.left - bodyRect.left + body.scrollLeft;
        const top = rect.top - bodyRect.top + body.scrollTop;
        return left < box.left + box.width && left + rect.width > box.left && top < box.top + box.height && top + rect.height > box.top;
      }).map((element) => element.dataset.clipId!);
      setSelected(expandSelection([...new Set([...baseline, ...hits])], pointer.altKey));
    };
    const onUp = (pointer: MouseEvent) => {
      cancel();
      if (dragged) suppressClick.current = true;
      else { setSelected(baseline); seek(timeAt(pointer.clientX)); }
    };
    const cancel = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); gestureCancelRef.current = null; setMarquee(null); };
    gestureCancelRef.current = cancel;
    window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
  };
  const currentAssetLabel = (clip: Clip) => clip.kind === "sequence" ? p.project.sequences[clip.sequenceId ?? ""]?.kind === "live2d" ? "Live2D" : "复合" : ({ live2d: "Live2D", image: "图片", audio: "音频", text: "文字" } as const)[clip.kind];
  const clipThumbnail = (clip: Clip) => {
    if(clip.kind === "audio" || clip.kind === "text")return undefined;
    const child = clip.sequenceId ? p.project.sequences[clip.sequenceId] : undefined;
    const assetId = child?.kind === "live2d" ? child.actors[0]?.assetId : clip.assetId;
    const asset = assetId ? p.project.assets[assetId] : undefined;
    const supplied = assetId ? p.assetThumbnails?.[assetId] : undefined;
    return supplied ?? (typeof asset?.metadata?.thumbnail === "string" ? asset.metadata.thumbnail : undefined);
  };
  const waveformPath = (clip: Clip) => {
    const asset = clip.assetId ? p.project.assets[clip.assetId] : undefined;
    const peaks = asset?.waveformPeaks;
    const sourceDuration = asset?.duration;
    if (!peaks?.length || !sourceDuration) return "";
    return Array.from({ length: 64 }, (_, index) => {
      const sourceTime = clip.sourceIn + index / 63 * clip.duration * clip.rate;
      const amplitude = Math.max(0, Math.min(1, peaks[Math.min(peaks.length - 1, Math.floor(sourceTime / sourceDuration * peaks.length))] ?? 0)) * 8;
      const x = index / 63 * 100;
      return `M${x},${10 - amplitude}V${10 + amplitude}`;
    }).join(" ");
  };
  const inspectorClip = selectedItems[0]?.clip;
  const inspectorClipVisible = !!inspectorClip && localTime >= inspectorClip.start && localTime < inspectorClip.start + inspectorClip.duration;
  const inspectorSourceTime = inspectorClip ? Math.max(0, inspectorClip.sourceIn + (localTime - inspectorClip.start) * inspectorClip.rate) : 0;
  const inspectorTransform = inspectorClip ? evaluateClipTransform(inspectorClip, inspectorSourceTime) : DEFAULT_TRANSFORM;
  const inspectorVolume = inspectorClip ? clipVolumeAt(inspectorClip, inspectorSourceTime) : 1;
  const transformKey = inspectorClip?.transformKeys.find((key) => Math.abs(key.time - inspectorSourceTime) < 1e-6);
  const volumeKey = inspectorClip?.volumeKeys.find((key) => Math.abs(key.time - inspectorSourceTime) < 1e-6);
  const patchSelected = (patch: Partial<Clip>) => {
    if (!inspectorClip) return;
    edit((project) => updateClip(project, currentId, selectedItems[0].track.id, inspectorClip.id, patch, sequence.fps));
  };
  const patchTransform = (patch: Partial<Transform>) => {
    if (!inspectorClip) return;
    const next = { ...inspectorTransform, ...patch };
    if (inspectorClip.transformKeys.length && inspectorClipVisible) {
      const key = { ...next, time: inspectorSourceTime, id: transformKey?.id ?? crypto.randomUUID() };
      patchSelected({ transformKeys: [...inspectorClip.transformKeys.filter((item) => item.id !== transformKey?.id), key].sort((a, b) => a.time - b.time) });
    } else patchSelected({ transform: next });
  };
  const patchVolume = (value: number) => {
    if (!inspectorClip) return;
    if (inspectorClip.volumeKeys.length && inspectorClipVisible) {
      const key = { time: inspectorSourceTime, value, id: volumeKey?.id ?? crypto.randomUUID() };
      patchSelected({ volumeKeys: [...inspectorClip.volumeKeys.filter((item) => item.id !== volumeKey?.id), key].sort((a, b) => a.time - b.time) });
    } else patchSelected({ volume: value });
  };
  const startPropertyKeyDrag = (event: React.MouseEvent, trackId: string, clip: Clip, kind: "transform" | "volume" | `property:${PropertyName}`, id: string) => {
    if (event.button !== 0) return;
    gestureCancelRef.current?.();
    event.preventDefault(); event.stopPropagation();
    setSelected([clip.id]); setFocusedTrackId(trackId);
    const property = kind.startsWith("property:") ? kind.slice(9) as PropertyName : undefined;
    const keys = property ? clip.propertyCurves?.[property]?.keys ?? [] : kind === "transform" ? clip.transformKeys : clip.volumeKeys;
    const key = keys.find((item) => item.id === id);
    if (!key) return;
    const at = clip.start + (key.time - clip.sourceIn) / clip.rate;
    seek(at);
    if (tracks.find((track) => track.id === trackId)?.locked) return;
    const originX = event.clientX;
    let targetTime = key.time;
    let dragged = false;
    const move = (pointer: MouseEvent) => {
      if (Math.abs(pointer.clientX - originX) < 3 && !dragged) return;
      dragged = true;
      const result = snapTime(at + (pointer.clientX - originX) / zoom, [clip.id], [0], pointer.altKey);
      targetTime = Math.max(0, clip.sourceIn + (result.value - clip.start) * clip.rate);
      setPropertyKeyPreview({ clipId: clip.id, keyId: id, time: targetTime });
    };
    const up = () => {
      cancel();
      if (!dragged) return;
      suppressClick.current = true;
      const curve = property ? clip.propertyCurves?.[property] : undefined;
      const patch = property && curve ? { propertyCurves: { ...clip.propertyCurves, [property]: { ...curve, keys: curve.keys.filter(item => item.id === id || Math.abs(item.time-targetTime)>1e-6).map(item => item.id === id ? {...item,time:targetTime,inHandle:item.inHandle&&{...item.inHandle,time:item.inHandle.time+targetTime-key.time},outHandle:item.outHandle&&{...item.outHandle,time:item.outHandle.time+targetTime-key.time}} : item).sort((a,b)=>a.time-b.time) } } } : kind === "transform" ? { transformKeys: clip.transformKeys.filter((item) => item.id === id || Math.abs(item.time - targetTime) > 1e-6).map((item) => item.id === id ? { ...item, time: targetTime } : item).sort((a, b) => a.time - b.time) }
        : { volumeKeys: clip.volumeKeys.filter((item) => item.id === id || Math.abs(item.time - targetTime) > 1e-6).map((item) => item.id === id ? { ...item, time: targetTime } : item).sort((a, b) => a.time - b.time) };
      edit((project) => updateClip(project, currentId, trackId, clip.id, patch, sequence.fps));
    };
    const cancel = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); gestureCancelRef.current = null; setPropertyKeyPreview(null); };
    gestureCancelRef.current = cancel;
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };

  const finalTime = rootTimeAt(localTime);
  return <div className="tl-root sequence-timeline" ref={rootRef} style={{ "--zoom": `${zoom}px` } as React.CSSProperties} tabIndex={0} onKeyDown={(event) => {
    if (event.defaultPrevented || event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement) return;
    const command = event.metaKey || event.ctrlKey;
    if (command && event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) p.onRedoProject(); else p.onUndoProject(); }
    else if (command && event.key.toLowerCase() === "a" && !showParameters) { event.preventDefault(); setSelected(tracks.flatMap((track) => track.clips.map((clip) => clip.id))); }
    else if (command && event.key.toLowerCase() === "b" && !showParameters) { event.preventDefault(); splitSelection(); }
    else if (command && event.key.toLowerCase() === "l" && !showParameters) {
      event.preventDefault(); edit((project) => event.shiftKey ? unlinkClips(project, currentId, selected) : linkClips(project, currentId, selected));
    }
    else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const delta = (event.key === "ArrowLeft" ? -1 : 1) * frame * (event.shiftKey ? 10 : 1);
      if (event.altKey && selectedItems.length && !showParameters) edit((project) => moveTimelineClips(project, currentId, expandSelection(selected), selectedItems[0].clip.id, selectedItems[0].track.id, selectedItems[0].clip.start + delta, "free"));
      else navigate(command ? event.key === "ArrowLeft" ? 0 : sequenceDuration(sequence) : localTime + delta);
    }
    else if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); navigate(adjacentEditTime(sequence, localTime, event.key === "ArrowUp" ? -1 : 1)); }
    else if (event.key === "Home" || event.key === "End") { event.preventDefault(); navigate(event.key === "Home" ? 0 : sequenceDuration(sequence)); }
    else if (!command && event.key.toLowerCase() === "i") { event.preventDefault(); markRange("in"); }
    else if (!command && event.key.toLowerCase() === "o") { event.preventDefault(); markRange("out"); }
    else if (!command && event.altKey && event.code === "KeyX") { event.preventDefault(); setRanges((previous) => ({ ...previous, [currentId]: { start: 0 } })); }
    else if (!command && event.shiftKey && event.key.toLowerCase() === "z") { event.preventDefault(); fitTimeline(); }
    else if (command && event.key.toLowerCase() === "c") {
      event.preventDefault();
      const ordered = selectedItems.slice().sort((a, b) => a.track.order - b.track.order || a.clip.start - b.clip.start);
      if (ordered.length) {
        const baseTime = Math.min(...ordered.map((item) => item.clip.start));
        const baseTrack = Math.min(...ordered.map((item) => item.track.order));
        setClipboard(ordered.map((item) => ({ trackOffset: item.track.order - baseTrack, timeOffset: item.clip.start - baseTime, clip: structuredClone(item.clip) })));
      }
    }
    else if (command && event.key.toLowerCase() === "v" && clipboard.length) {
      event.preventDefault();
      const target = tracks.find((item) => item.id === focusedTrackId && !item.locked) ?? tracks.find((item) => !item.locked);
      if (!target) return;
      try {
        const result = pasteTimelineClips(p.project, currentId, target.id, localTime, clipboard, mode);
        p.onProjectChange(result.project); setSelected(result.clipIds);
        setIssue("");
      } catch (error) { setIssue(error instanceof Error ? error.message : String(error)); }
    } else if ((event.key === "Delete" || event.key === "Backspace") && !showParameters) {
      event.preventDefault(); deleteSelection(event.shiftKey);
    }
  }}>
    <header className="seq-tl-header">
      <nav className="seq-tl-crumbs" aria-label="序列层级">
        {!!path.length && <button className="seq-tl-back" title="返回上一层" aria-label="返回上一层" onClick={() => leave(path.length - 1)}>‹</button>}
        <button className={!path.length ? "current" : ""} aria-current={!path.length ? "location" : undefined} onClick={() => leave(0)}>{p.project.sequences[p.project.rootSequenceId]?.name ?? "主序列"}</button>
        {path.map((entry, index) => <span key={entry.clipId}><i>›</i><button className={index === path.length - 1 ? "current" : ""} aria-current={index === path.length - 1 ? "location" : undefined} onClick={() => leave(index + 1)}>{p.project.sequences[entry.childId]?.name}</button></span>)}
      </nav>
      <div className="seq-tl-tools">
        <button onClick={() => p.isPlaying ? p.onStopPlayback?.() : p.onStartPlayback?.()}>{p.isPlaying ? "暂停" : "播放"}</button>
        <button onClick={p.onUndoProject}>撤销</button><button onClick={p.onRedoProject}>重做</button>
        {sequence.kind === "live2d" && <button onClick={() => setShowParameters((value) => !value)}>{showParameters ? "剪辑" : "参数"}</button>}
        {!!path.length && <button className={finalComposition ? "active" : ""} aria-pressed={finalComposition} onClick={() => { const next = !finalComposition; setFinalComposition(next); notifySeek(currentId, localTime, path, next); }}>{finalComposition ? "最终合成" : "当前序列"}</button>}
        <button className={snapping ? "active" : ""} aria-pressed={snapping} title="吸附到播放头与片段边缘；按住 Option / Alt 临时关闭" onClick={() => setSnapping((value) => !value)}>吸附</button>
        {!showParameters && <>
          {sequence.kind === "edit" && <select aria-label="剪辑方式" title="自由：碰撞新建轨道；插入：所有轨道腾出时间；覆盖：替换目标轨道区间" value={editMode} onChange={(event) => setEditMode(event.target.value as EditMode)}><option value="free">自由</option><option value="insert">插入</option><option value="overwrite">覆盖</option></select>}
          <button className={linkedSelection ? "active" : ""} aria-pressed={linkedSelection} title="关联选择；按住 Option / Alt 可单独拖动片段" onClick={() => { const next = !linkedSelection; setLinkedSelection(next); if (next) setSelected(linkedClipIds(sequence, selected)); }}>联动</button>
          {selectedItems.length > 1 && <button title="关联所选片段 · ⌘/Ctrl L" onClick={() => edit((project) => linkClips(project, currentId, selected))}>关联</button>}
          {selectedItems.some(({ clip }) => clip.linkGroupId) && <button title="解除关联 · ⇧⌘/Ctrl L" onClick={() => edit((project) => unlinkClips(project, currentId, selected))}>解除</button>}
          <button disabled={!(selected.length ? selectedItems : tracks.filter((track) => !track.locked).flatMap((track) => track.clips.map((clip) => ({ track, clip })))).some(({ clip }) => localTime > clip.start && localTime < clip.start + clip.duration)} title="分割所选片段；未选时分割播放头下未锁定片段 · ⌘/Ctrl B" onClick={splitSelection}>分割</button>
          {sequence.kind === "edit" && <button disabled={!selected.length && markedRange?.end == null} title="删除所选片段覆盖的时间；未选片段时删除 I/O 范围。所有轨道同步闭合 · Shift Delete" onClick={() => deleteSelection(true)}>波纹删除</button>}
        </>}
        <button onClick={addText}>＋文字</button>
        {selectedItems.length > 1 && <button onClick={() => {
          try {
            const made = createCompound(p.project, currentId, selected);
            const assetId = `asset:sequence:${made.sequenceId}`;
            const project = { ...made.project, assets: { ...made.project.assets, [assetId]: { id: assetId, kind: "sequence" as const, name: made.project.sequences[made.sequenceId].name, uri: "", duration: sequenceDuration(made.project.sequences[made.sequenceId]), metadata: { sequenceId: made.sequenceId } } } };
            p.onProjectChange(project); setSelected([made.clipId]);
          }
          catch (error) { setIssue(error instanceof Error ? error.message : String(error)); }
        }}>复合</button>}
        <button title="缩小时间线" onClick={() => setZoom((value) => Math.max(0.1, value / 1.2))}>−</button><button title="放大时间线" onClick={() => setZoom((value) => Math.min(360, value * 1.2))}>＋</button>
        {!showParameters && <button title="适应整个序列 · Shift Z" onClick={fitTimeline}>适应</button>}
        <button title="上一帧 · ←；Shift ← 退十帧" aria-label="上一帧" onClick={() => navigate(localTime - frame)}>‹</button>
        <button title="下一帧 · →；Shift → 进十帧" aria-label="下一帧" onClick={() => navigate(localTime + frame)}>›</button>
        <input className="seq-timecode" aria-label="播放头时间码" title="时:分:秒:帧；也可输入秒数。非丢帧时间码" value={timecodeDraft ?? formatTimecode(localTime, sequence.fps)} onFocus={() => setTimecodeDraft(formatTimecode(localTime, sequence.fps))} onChange={(event) => setTimecodeDraft(event.target.value)} onBlur={(event) => {
          if (timecodeDraft != null) { try { navigate(parseTimecode(event.currentTarget.value, sequence.fps)); setIssue(""); } catch (error) { setIssue(error instanceof Error ? error.message : String(error)); } }
          setTimecodeDraft(null);
        }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); else if (event.key === "Escape") { event.currentTarget.value = formatTimecode(localTime, sequence.fps); setTimecodeDraft(null); event.currentTarget.blur(); } }} />
      </div>
    </header>
    {issue && <div className="seq-tl-issue" role="status"><span>{issue}</span><button aria-label="关闭提示" onClick={() => setIssue("")}>×</button></div>}
    {finalComposition && path.length > 0 && finalTime === undefined && <div className="seq-tl-range-notice" role="status">当前时间超出父片段范围</div>}
    {p.showInlineInspector !== false && inspectorClip && <div className="seq-tl-inspector" inert={selectedItems[0]?.track.locked} onFocusCapture={(event) => { if ((event.target as HTMLElement).matches("input,select,textarea")) p.onBeginProjectEdit?.(); }} onBlurCapture={(event) => { if ((event.target as HTMLElement).matches("input,select,textarea")) p.onEndProjectEdit?.(); }}>
      <b>{inspectorClip.name}</b><span>{currentAssetLabel(inspectorClip)}</span>
      <label>起点<input aria-label="片段起点" type="number" min="0" step={frame} value={Number(inspectorClip.start.toFixed(3))} onChange={(event) => edit((project) => moveTimelineClips(project, currentId, expandSelection([inspectorClip.id]), inspectorClip.id, selectedItems[0].track.id, Math.max(0, Number(event.target.value)), "free"))} /></label>
      <label>入点<input aria-label="素材入点" type="number" min="0" step={frame} value={Number(inspectorClip.sourceIn.toFixed(3))} onChange={(event) => edit((project) => updateClip(project, currentId, selectedItems[0].track.id, inspectorClip.id, { sourceIn: Math.max(0, Number(event.target.value)) }, sequence.fps))} /></label>
      <label>速率<input aria-label="片段速率" type="number" min="0.1" max="8" step="0.1" value={Number(inspectorClip.rate.toFixed(2))} onChange={(event) => edit((project) => changeClipRate(project, currentId, selectedItems[0].track.id, inspectorClip.id, Number(event.target.value), sequence.fps))} /></label>
      <label>时长<input aria-label="片段时长" type="number" min={frame} step={frame} value={Number(inspectorClip.duration.toFixed(3))} onChange={(event) => edit((project) => trimLinkedClips(project, currentId, expandSelection([inspectorClip.id]), "right", Number(event.target.value) - inspectorClip.duration))} /></label>
      {inspectorClip.kind === "audio" ? <>
        <label>音量<input aria-label="片段音量" type="number" min="0" max="4" step="0.05" value={Number(inspectorVolume.toFixed(3))} onChange={(event) => patchVolume(Math.max(0, Number(event.target.value)))} /></label>
        <button disabled={!inspectorClipVisible} className={volumeKey ? "active" : ""} title={!inspectorClipVisible ? "播放头不在片段内" : volumeKey ? "删除当前音量关键帧" : "添加音量关键帧"} aria-label={volumeKey ? "删除当前音量关键帧" : "添加音量关键帧"} onClick={() => patchSelected({ volumeKeys: volumeKey ? inspectorClip.volumeKeys.filter((key) => key.id !== volumeKey.id) : [...inspectorClip.volumeKeys, { id: crypto.randomUUID(), time: inspectorSourceTime, value: inspectorVolume }].sort((a, b) => a.time - b.time) })}>{volumeKey ? "◆" : "◇"}</button>
        <label>淡入<input aria-label="音频淡入" type="number" min="0" step="0.1" value={inspectorClip.fadeIn} onChange={(event) => edit((project) => updateClip(project, currentId, selectedItems[0].track.id, inspectorClip.id, { fadeIn: Math.max(0, Number(event.target.value)) }, sequence.fps))} /></label>
        <label>淡出<input aria-label="音频淡出" type="number" min="0" step="0.1" value={inspectorClip.fadeOut} onChange={(event) => edit((project) => updateClip(project, currentId, selectedItems[0].track.id, inspectorClip.id, { fadeOut: Math.max(0, Number(event.target.value)) }, sequence.fps))} /></label>
        <label>口型<select aria-label="音频口型目标" value={inspectorClip.lipSyncActorId ?? ""} onChange={(event) => patchSelected({ lipSyncActorId: event.target.value || undefined })}><option value="">不绑定</option>{Object.values(p.project.sequences).flatMap((item) => item.kind === "live2d" ? item.actors.map((actor) => <option key={actor.id} value={actor.id}>{item.name} · {actor.name}</option>) : [])}</select></label>
      </> : null}
      {inspectorClip.kind !== "audio" ? <>
        <label>X<input aria-label="片段横坐标" type="number" step="1" value={Number(inspectorTransform.x.toFixed(2))} onChange={(event) => patchTransform({ x: Number(event.target.value) })} /></label>
        <label>Y<input aria-label="片段纵坐标" type="number" step="1" value={Number(inspectorTransform.y.toFixed(2))} onChange={(event) => patchTransform({ y: Number(event.target.value) })} /></label>
        <label>缩放<input aria-label="片段缩放" type="number" min="0.01" step="0.05" value={Number(inspectorTransform.scaleX.toFixed(3))} onChange={(event) => patchTransform({ scaleX: Number(event.target.value), scaleY: Number(event.target.value) })} /></label>
        <label>旋转<input aria-label="片段旋转" type="number" step="1" value={Number(inspectorTransform.rotation.toFixed(2))} onChange={(event) => patchTransform({ rotation: Number(event.target.value) })} /></label>
        <label>透明<input aria-label="片段透明度" type="number" min="0" max="1" step="0.05" value={Number(inspectorTransform.opacity.toFixed(3))} onChange={(event) => patchTransform({ opacity: Number(event.target.value) })} /></label>
        <button disabled={!inspectorClipVisible} className={transformKey ? "active" : ""} title={!inspectorClipVisible ? "播放头不在片段内" : transformKey ? "删除当前画面关键帧" : "添加画面关键帧"} aria-label={transformKey ? "删除当前画面关键帧" : "添加画面关键帧"} onClick={() => patchSelected({ transformKeys: transformKey ? inspectorClip.transformKeys.filter((key) => key.id !== transformKey.id) : [...inspectorClip.transformKeys, { ...inspectorTransform, id: crypto.randomUUID(), time: inspectorSourceTime }].sort((a, b) => a.time - b.time) })}>{transformKey ? "◆" : "◇"}</button>
      </> : null}
      {inspectorClip.kind === "text" && <>
        <label>文字<input className="seq-tl-text-field" aria-label="文字内容" value={inspectorClip.text ?? ""} onChange={(event) => patchSelected({ text: event.target.value, name: event.target.value.trim().slice(0, 18) || "文字" })} /></label>
        <label>字体<input className="seq-tl-font-field" aria-label="文字字体" value={inspectorClip.fontFamily ?? String(p.project.assets[inspectorClip.assetId ?? ""]?.metadata?.fontFamily ?? "sans-serif")} onChange={(event) => patchSelected({ fontFamily: event.target.value })} /></label>
        <label>字号<input aria-label="文字字号" type="number" min="1" max="500" value={inspectorClip.fontSize ?? Number(p.project.assets[inspectorClip.assetId ?? ""]?.metadata?.fontSize ?? 34)} onChange={(event) => patchSelected({ fontSize: Math.max(1, Number(event.target.value)) })} /></label>
        <label>颜色<input aria-label="文字颜色" type="color" value={inspectorClip.textColor ?? String(p.project.assets[inspectorClip.assetId ?? ""]?.metadata?.color ?? "#ffffff")} onChange={(event) => patchSelected({ textColor: event.target.value })} /></label>
      </>}
      {inspectorClip.kind === "sequence" ? <button onClick={() => {
        try { const made = createIndependentClip(p.project, currentId, selectedItems[0].track.id, inspectorClip.id); p.onProjectChange(made.project); setSelected([made.clipId]); }
        catch (error) { setIssue(error instanceof Error ? error.message : String(error)); }
      }}>独立副本</button> : null}
      <button onClick={splitSelection}>分割</button>
      <button onClick={() => deleteSelection()}>删除</button>
    </div>}
    {showParameters ? <ParameterTimeline
      fps={sequence.fps}
      characterNames={sequence.kind === "live2d" ? Object.fromEntries(sequence.actors.map(actor=>[actor.id,actor.name])) : undefined}
      onExportAnimation={p.onExportAnimation ? options => p.onExportAnimation!(sequence.id, options) : undefined}
      onImportMaterial={(name, kind, start, source) => importMaterialAt(name, kind, start, undefined, source)}
      animation={parameterDocument}
      onAnimationChange={(document) => sequence.kind === "live2d" && p.onSequenceAnimationChange
        ? p.onSequenceAnimationChange(sequence.id, document)
        : p.onAnimationChange(document)}
      onBeginEdit={p.onBeginProjectEdit ?? p.onBeginEdit}
      onEndEdit={p.onEndProjectEdit ?? p.onEndEdit}
      onUndo={p.onUndoProject}
      onRedo={p.onRedoProject}
      playheadSec={localTime}
      playheadSourceRef={currentId === p.project.rootSequenceId ? p.playheadSourceRef : localTimeRef}
      onSetPlayhead={seek}
      isPlaying={p.isPlaying}
      onStartPlayback={p.onStartPlayback}
      onStopPlayback={p.onStopPlayback}
    /> : <>
      <div className="seq-tl-body" ref={scrollRef} onMouseDown={startMarquee} onClickCapture={(event) => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; } }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragPreview(null); }}>
        <div className="seq-tl-ruler-row"><div className="seq-tl-left-tools"><button title="新增轨道" onClick={() => edit((project) => addTrack(project, currentId))}>＋轨道</button><button title="设置入点 · I" className={markedRange ? "active" : ""} onClick={() => markRange("in")}>I</button><button title="设置出点 · O；Option X 清除范围" className={markedRange?.end != null ? "active" : ""} onClick={() => markRange("out")}>O</button></div><div className="seq-tl-ruler" style={{ width }} onMouseDown={startRulerDrag}>{Array.from({ length: Math.ceil(width / zoom / Math.max(1, Math.ceil(48 / zoom))) + 1 }, (_, index) => index * Math.max(1, Math.ceil(48 / zoom))).map((second) => <span key={second} style={{ left: second * zoom }}>{second}s</span>)}{markedRange && <div className="seq-tl-marked-range" style={{ left: markedRange.start * zoom, width: Math.max(2, ((markedRange.end ?? localTime) - markedRange.start) * zoom) }} />}<i style={{ left: localTime * zoom }} /> </div></div>
        {tracks.map((track) => <div className={`seq-tl-track-row${track.locked ? " is-locked" : ""}`} data-track-id={track.id} key={track.id} onMouseDownCapture={() => setFocusedTrackId(track.id)} onDragOver={(event) => previewDrop(event, track.id)} onDrop={(event) => onDrop(event, track.id)}>
          <div className="seq-tl-track-head" onMouseDown={event=>{event.stopPropagation();setSelected([]);setFocusedTrackId(track.id);p.onTrackSelect?.(currentId,track.id);}}>
            <input aria-label="轨道名称" value={track.name} onFocus={() => p.onBeginProjectEdit?.()} onBlur={() => p.onEndProjectEdit?.()} onChange={(event) => edit((project) => ({ ...project, sequences: { ...project.sequences, [currentId]: { ...sequence, tracks: sequence.tracks.map((item) => item.id === track.id ? { ...item, name: event.target.value } : item) } } }))} />
            <div className="seq-tl-track-controls"><button title="锁定" className={track.locked ? "active" : ""} onClick={() => edit((project) => ({ ...project, sequences: { ...project.sequences, [currentId]: { ...sequence, tracks: sequence.tracks.map((item) => item.id === track.id ? { ...item, locked: !item.locked } : item) } } }))}>锁</button><button title="隐藏画面" className={track.hidden ? "active" : ""} onClick={() => edit((project) => ({ ...project, sequences: { ...project.sequences, [currentId]: { ...sequence, tracks: sequence.tracks.map((item) => item.id === track.id ? { ...item, hidden: !item.hidden } : item) } } }))}>显</button><button title="静音" className={track.muted ? "active" : ""} onClick={() => edit((project) => ({ ...project, sequences: { ...project.sequences, [currentId]: { ...sequence, tracks: sequence.tracks.map((item) => item.id === track.id ? { ...item, muted: !item.muted } : item) } } }))}>音</button><button title="上移轨道" onClick={() => edit((project) => reorderTrack(project, currentId, track.id, track.order - 1))}>↑</button><button title="下移轨道" onClick={() => edit((project) => reorderTrack(project, currentId, track.id, track.order + 1))}>↓</button><button title="删除空轨道" disabled={!!track.clips.length} onClick={() => edit((project) => removeEmptyTrack(project, currentId, track.id))}>×</button></div>
          </div>
          <div className={`seq-tl-lane${track.hidden ? " is-hidden" : ""}`} style={{ width }}>
            {track.clips.map((clip) => <div key={clip.id} data-clip-id={clip.id} className={`seq-clip${selected.includes(clip.id) ? " selected" : ""}${clip.placeholder ? " missing" : ""}${dragPreview?.clips.some((ghost) => ghost.id === clip.id) ? " dragging" : ""}${dragPreview?.targetClipId === clip.id ? " material-target" : ""}`} style={{ left: clip.start * zoom, width: Math.max(8, clip.duration * zoom), backgroundColor: clipColor[clip.kind] }} onMouseDown={(event) => startClipDrag(event, track.id, clip)} onDoubleClick={() => {
              if (clip.kind === "text") {
                const value = window.prompt("文字内容", clip.text ?? "");
                if (value !== null) edit((project) => updateClip(project, currentId, track.id, clip.id, { text: value, name: value.trim().slice(0, 18) || "文字" }, sequence.fps));
              } else enter(clip);
            }} title={`${clip.name} · ${clip.start.toFixed(2)}–${(clip.start + clip.duration).toFixed(2)}s`}>
              <span className="seq-clip-grip" onMouseDown={(event) => startClipDrag(event, track.id, clip, "left")} />{clip.linkGroupId && <svg className="seq-clip-link" viewBox="0 0 16 16" aria-label="关联片段"><path d="M6 10l4-4M5 8l-1 1a3 3 0 004 4l2-2M11 8l1-1a3 3 0 00-4-4L6 5" /></svg>}{clipThumbnail(clip) && <img className="seq-clip-thumbnail" src={clipThumbnail(clip)} alt="" draggable={false} />}{clip.kind === "audio" && <svg className="seq-clip-waveform" viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true"><path d={waveformPath(clip)} /></svg>}<strong>{clip.name}</strong><small>{currentAssetLabel(clip)}</small>
              {[...clip.transformKeys.map((key) => ({ ...key, kind: "transform" as const })), ...clip.volumeKeys.map((key) => ({ ...key, kind: "volume" as const })), ...Object.entries(clip.propertyCurves ?? {}).flatMap(([name,curve]) => curve.enabled ? curve.keys.map(key=>({...key,kind:`property:${name}` as `property:${PropertyName}`})) : [])].filter((key) => key.time >= clip.sourceIn && key.time <= clip.sourceIn + clip.duration * clip.rate).map((key) => <button key={key.id} className="seq-property-key" title={`${key.kind.startsWith("property:") ? propertyLabels[key.kind.slice(9) as PropertyName] : key.kind === "transform" ? "画面" : "音量"}关键帧 · ${key.time.toFixed(3)} 秒`} aria-label={`${key.kind.startsWith("property:") ? propertyLabels[key.kind.slice(9) as PropertyName] : key.kind === "transform" ? "画面" : "音量"}关键帧`} style={{ left: ((propertyKeyPreview?.clipId === clip.id && propertyKeyPreview.keyId === key.id ? propertyKeyPreview.time : key.time) - clip.sourceIn) / clip.rate * zoom }} onMouseDown={(event) => startPropertyKeyDrag(event, track.id, clip, key.kind, key.id)} onDoubleClick={(event) => event.stopPropagation()}>◆</button>)}
              <span className="seq-clip-grip right" onMouseDown={(event) => startClipDrag(event, track.id, clip, "right")} />
            </div>)}
            {dragPreview?.clips.filter((ghost) => ghost.trackId === track.id).map((ghost) => <div key={ghost.id} className={`seq-clip seq-clip-ghost${dragPreview.invalid ? " invalid" : ""}${dragPreview.createsTrack ? " new-track" : ""}`} style={{ left: ghost.start * zoom, width: Math.max(8, ghost.duration * zoom), backgroundColor: clipColor[ghost.kind] }}><strong>{ghost.name}</strong><small>{dragPreview.label}</small></div>)}
            {dragPreview?.snapAt !== undefined && <i className="seq-tl-snap" style={{ left: dragPreview.snapAt * zoom }} />}
            <i className="seq-tl-playhead" style={{ left: localTime * zoom }} />
          </div>
        </div>)}
        {!tracks.length && <div className="seq-tl-empty" style={{ width: width + 124 }} onDragOver={(event) => previewDrop(event, "")} onDrop={(event) => onDrop(event, "")}><button onClick={() => edit((project) => addTrack(project, currentId))}>＋轨道</button></div>}
        {marquee && <div className="seq-tl-marquee" style={marquee} />}
      </div>
      <footer className="seq-tl-footer"><span>{sequence.name}</span><span>{sequence.width} × {sequence.height} · {sequence.fps}fps</span><span>{dragPreview?.label ?? (selectedItems.length ? `选中 ${selectedItems.length}` : "")}</span></footer>
    </>}
  </div>;
}
