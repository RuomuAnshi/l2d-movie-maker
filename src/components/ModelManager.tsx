import * as PIXI from "pixi.js";
import { useEffect, useRef } from "react";
import {
  loadPixiCompositeModel,
  resolveCompositePath,
  type CompositePart,
  type ExtractCompositeSelectorsResult,
} from "composite-model";
import { Live2DModel } from "pixi-live2d-display";
import { beginModelResourceLoad, retainModelResources, releaseModelResources } from "../sequence/modelResources";
import {
  normalizeModelData,
  readModelDataFromRuntime,
  withFallbackModelData,
  type ModelData,
} from "../utils/modelData";

type TransformSnapshot = {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
};
type DragMode = "move" | "rotate";
type PointerDataLike = {
  data: {
    global: { x: number; y: number };
    originalEvent?: MouseEvent | PointerEvent;
  };
};
type DraggableState = {
  dragging?: boolean;
  _pointerX?: number;
  _pointerY?: number;
  _dragMode?: DragMode;
  _startAngle?: number;
  _startRotation?: number;
};
type InternalEyeBlinkLike = {
  blinkInterval: number;
  nextBlinkTimeLeft: number;
};
type InternalModelLike = {
  angleXParamIndex?: number;
  angleYParamIndex?: number;
  angleZParamIndex?: number;
  eyeBlink?: InternalEyeBlinkLike;
  motionManager?: { stopAllMotions?: () => void; expressionManager?: { stopAllExpressions?: () => void } };
  coreModel?: {
    setParamFloat?: (id: string, value: number) => void;
  };
};
type DraggableDisplayObject = PIXI.Container & DraggableState & {
  autoInteract?: boolean;
};
type DraggableCleanupTarget = PIXI.Container & {
  __dragCleanup?: () => void;
};

export interface JsonlRoleMeta {
  id: string;
  folder?: string;
  path: string;
  index: number;
}

export type JsonlLive2DModel = Live2DModel & {
  __characterId?: string;
  __characterLabel?: string;
  __jsonlRoleMeta?: JsonlRoleMeta;
  __compositeResolvedUrl?: string;
};

interface ModelManagerProps {
  appRef: React.MutableRefObject<PIXI.Application | null>;
  modelRef: React.MutableRefObject<Live2DModel | Live2DModel[] | null>;
  groupContainerRef: React.MutableRefObject<PIXI.Container | null>;
  isCompositeRef: React.MutableRefObject<boolean>;
  motionBaseRef: React.MutableRefObject<string | null>;
  setModelData: (data: ModelData | null) => void;
  setCustomRecordingBounds: (bounds: { x: number; y: number; width: number; height: number }) => void;
  enableDragging: boolean;
  setIsDragging: (dragging: boolean) => void;
  onTransformChange?: (transform: TransformSnapshot) => void;
  onBeforeModelDispose?: () => void;
}

export default function ModelManager({
  appRef,
  modelRef,
  groupContainerRef,
  isCompositeRef,
  motionBaseRef,
  setModelData,
  setCustomRecordingBounds,
  enableDragging,
  setIsDragging,
  onTransformChange,
  onBeforeModelDispose
}: ModelManagerProps) {
  const loadGeneration = useRef(0);
  const mounted = useRef(true);
  const fetchController = useRef<AbortController | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loadGeneration.current += 1;
      fetchController.current?.abort();
      disposeCurrentModel(false);
    };
    // Factory refs persist across renders; cleanup deliberately avoids state callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 工具函数
  const isJsonl = (u: string) => /\.jsonl(\?|#|$)/i.test(u);
  
  const resolveRelativeFrom = (baseUrl: string, rel: string) => {
    if (/^https?:\/\//i.test(rel)) return rel;
    if (rel.startsWith("/")) return rel;
    if (rel.startsWith("./")) rel = rel.slice(2);
    const base = baseUrl.slice(0, baseUrl.lastIndexOf("/") + 1);
    return base + rel;
  };

  const forEachModel = (fn: (m: Live2DModel) => void) => {
    const cur = modelRef.current;
    if (!cur) return;
    if (Array.isArray(cur)) cur.forEach(fn);
    else fn(cur as Live2DModel);
  };

  const disposeModel = (model: JsonlLive2DModel) => {
    try {
      (model as DraggableCleanupTarget).__dragCleanup?.();
      model.parent?.removeChild(model);
      model.destroy({ children: true, texture: false, baseTexture: false });
    } catch (error) { console.warn("模型清理失败", error); }
    finally { releaseModelResources(model); }
  };

  const disposeContainer = (container: PIXI.Container) => {
    (container as DraggableCleanupTarget).__dragCleanup?.();
    container.parent?.removeChild(container);
    try { container.destroy({ children: false }); } catch { /* 已销毁的容器忽略 */ }
  };

  const disposeCurrentModel = (notify = true) => {
    if (notify) { onBeforeModelDispose?.(); setModelData(null); }
    const current = modelRef.current, container = groupContainerRef.current;
    modelRef.current = null;
    groupContainerRef.current = null;
    isCompositeRef.current = false;
    motionBaseRef.current = null;
    if (Array.isArray(current)) current.forEach((model) => disposeModel(model as JsonlLive2DModel));
    else if (current) disposeModel(current as JsonlLive2DModel);
    if (container) disposeContainer(container);
  };

  const cleanupCurrentModel = () => {
    loadGeneration.current += 1;
    fetchController.current?.abort();
    disposeCurrentModel();
  };

  const assertCurrentLoad = (app: PIXI.Application, generation: number) => {
    if (!mounted.current || loadGeneration.current !== generation || appRef.current !== app) {
      throw new DOMException("模型加载已取消", "AbortError");
    }
  };

  const emitTransformChange = (target: PIXI.Container) => {
    onTransformChange?.({
      x: Number(target.position.x),
      y: Number(target.position.y),
      scaleX: Number(target.scale.x),
      scaleY: Number(target.scale.y),
      rotation: Number(target.rotation * 180 / Math.PI),
    });
  };

  const updateBoundsFromDisplayObject = (target: PIXI.Container) => {
    const bounds = target.getBounds();
    setCustomRecordingBounds({
      x: Math.max(0, bounds.x),
      y: Math.max(0, bounds.y),
      width: Math.max(100, Math.min(bounds.width, appRef.current!.screen.width)),
      height: Math.max(100, Math.min(bounds.height, appRef.current!.screen.height)),
    });
  };

  const disableModelAutoBehaviors = (model: JsonlLive2DModel) => {
    model.autoUpdate = false;
    model.deltaTime = 0;
    model.autoInteract = false;
    const im = model.internalModel as unknown as InternalModelLike | undefined;
    if (!im) return;
    im.motionManager?.stopAllMotions?.();
    im.motionManager?.expressionManager?.stopAllExpressions?.();

    (["angleXParamIndex", "angleYParamIndex", "angleZParamIndex"] as const).forEach((k) => {
      if (typeof im[k] === "number") im[k] = -1;
    });

    if (im.eyeBlink) {
      im.eyeBlink.blinkInterval = 1000 * 60 * 60 * 24;
      im.eyeBlink.nextBlinkTimeLeft = 1000 * 60 * 60 * 24;
    }
  };

  const getCharacterIdFromPart = (part: CompositePart, fallbackIndex: number) => {
    const rawRoleId = (part.id && String(part.id).trim()) || (part.folder && String(part.folder).trim()) || `part${part.index ?? fallbackIndex}`;
    const mergedRoleId = rawRoleId.replace(/\d+$/, "") || rawRoleId;
    return { rawRoleId, mergedRoleId };
  };

  const synthesizeCompositeModelData = async (
    selectors: ExtractCompositeSelectorsResult,
    firstModelUrl: string,
    signal?: AbortSignal,
  ): Promise<ModelData> => {
    const response = await fetch(firstModelUrl, { cache: "no-cache", signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    const firstModelJson = normalizeModelData(await response.json());
    const fullMotions = firstModelJson.motions;
    const motionsFiltered: ModelData["motions"] = {};

    for (const group of selectors.motions) {
      const entries = fullMotions[group] ?? [];
      if (entries.length > 0) {
        motionsFiltered[group] = entries.map((item) => ({ name: item.name, file: item.file }));
      }
    }

    const fullExpressions = firstModelJson.expressions;
    const expressions = selectors.expressions.length > 0
      ? fullExpressions.filter((expression) => selectors.expressions.includes(expression.name))
      : fullExpressions;

    return { motions: motionsFiltered, expressions };
  };

  // 使模�?容器可拖�?
  const makeDraggableModel = (model: DraggableDisplayObject) => {
    model.interactive = true;
    model.buttonMode = true;

    model.on("pointerdown", (e: PointerDataLike) => {
      setIsDragging(true);
      model.dragging = true;
      model._pointerX = e.data.global.x - model.x;
      model._pointerY = e.data.global.y - model.y;
      model._dragMode = "move";
      const originalEvent = e.data.originalEvent as MouseEvent | PointerEvent | undefined;
      if (originalEvent?.altKey) {
        model._dragMode = "rotate";
        model._startAngle = Math.atan2(e.data.global.y - model.y, e.data.global.x - model.x);
        model._startRotation = model.rotation ?? 0;
      }
    });

    model.on("pointermove", (e: PointerDataLike) => {
      if (model.dragging) {
        const originalEvent = e.data.originalEvent as MouseEvent | PointerEvent | undefined;
        const wantsRotate = !!originalEvent?.altKey;

        if (wantsRotate) {
          if (model._dragMode !== "rotate") {
            model._dragMode = "rotate";
            model._startAngle = Math.atan2(e.data.global.y - model.y, e.data.global.x - model.x);
            model._startRotation = model.rotation ?? 0;
          }
          const currentAngle = Math.atan2(e.data.global.y - model.y, e.data.global.x - model.x);
          model.rotation = (model._startRotation ?? model.rotation) + (currentAngle - (model._startAngle ?? currentAngle));
        } else {
          if (model._dragMode !== "move") {
            model._dragMode = "move";
            model._pointerX = e.data.global.x - model.x;
            model._pointerY = e.data.global.y - model.y;
          }
          model.position.x = e.data.global.x - (model._pointerX ?? 0);
          model.position.y = e.data.global.y - (model._pointerY ?? 0);
        }

        updateBoundsFromDisplayObject(model);
        emitTransformChange(model);
      }
    });

    const up = () => {
      setIsDragging(false);
      model.dragging = false;
      model._dragMode = undefined;
    };
    model.on("pointerup", up);
    model.on("pointerupoutside", up);
  };

  const makeDraggableContainer = (container: DraggableDisplayObject) => {
    // 为容器添加一个几乎透明的命中区域，保证好拖
    const hit = new PIXI.Graphics();
    const redrawHit = () => {
      const b = container.getBounds();
      hit.clear();
      hit.beginFill(0x000000, 0.0001);
      hit.drawRect(b.x - container.x, b.y - container.y, b.width, b.height);
      hit.endFill();
    };
    redrawHit();
    container.addChild(hit);

    container.interactive = true;
    // @ts-expect-error pixi v7 兼容字段，v6 类型中不存在
    container.eventMode = "static";
    container.cursor = "grab";

    container.on("pointerdown", (e: PointerDataLike) => {
      setIsDragging(true);
      container.cursor = "grabbing";
      container.dragging = true;
      container._pointerX = e.data.global.x - container.x;
      container._pointerY = e.data.global.y - container.y;
      container._dragMode = "move";
      const originalEvent = e.data.originalEvent as MouseEvent | PointerEvent | undefined;
      if (originalEvent?.altKey) {
        container._dragMode = "rotate";
        container._startAngle = Math.atan2(e.data.global.y - container.y, e.data.global.x - container.x);
        container._startRotation = container.rotation ?? 0;
      }
    });

    container.on("pointermove", (e: PointerDataLike) => {
      if (container.dragging) {
        const originalEvent = e.data.originalEvent as MouseEvent | PointerEvent | undefined;
        const wantsRotate = !!originalEvent?.altKey;

        if (wantsRotate) {
          if (container._dragMode !== "rotate") {
            container._dragMode = "rotate";
            container._startAngle = Math.atan2(e.data.global.y - container.y, e.data.global.x - container.x);
            container._startRotation = container.rotation ?? 0;
          }
          const currentAngle = Math.atan2(e.data.global.y - container.y, e.data.global.x - container.x);
          container.rotation = (container._startRotation ?? container.rotation) + (currentAngle - (container._startAngle ?? currentAngle));
        } else {
          if (container._dragMode !== "move") {
            container._dragMode = "move";
            container._pointerX = e.data.global.x - container.x;
            container._pointerY = e.data.global.y - container.y;
          }
          container.position.x = e.data.global.x - (container._pointerX ?? 0);
          container.position.y = e.data.global.y - (container._pointerY ?? 0);
        }

        updateBoundsFromDisplayObject(container);
        redrawHit();
        emitTransformChange(container);
      }
    });

    const up = () => {
      setIsDragging(false);
      container.cursor = "grab";
      container.dragging = false;
      container._dragMode = undefined;
    };
    container.on("pointerup", up);
    container.on("pointerupoutside", up);
    window.addEventListener("resize", redrawHit);
    (container as DraggableCleanupTarget).__dragCleanup = () => {
      window.removeEventListener("resize", redrawHit);
      container.off("pointerup", up);
      container.off("pointerupoutside", up);
    };
  };

  const loadSingleModel = async (app: PIXI.Application, url: string, generation: number, signal: AbortSignal) => {
    let model: JsonlLive2DModel | null = null;
    try {
      model = await Live2DModel.from(url, { autoUpdate: false, autoInteract: false }) as JsonlLive2DModel;
      retainModelResources(model);
      disableModelAutoBehaviors(model);
      assertCurrentLoad(app, generation);
      model.__characterId = "main";
      model.__characterLabel = "Main Model";
      model.__compositeResolvedUrl = url;
      const response = await fetch(url, { cache: "no-cache", signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      const normalized = normalizeModelData(await response.json());
      assertCurrentLoad(app, generation);

      model.anchor.set(0.5, 0.5);
      model.scale.set(0.3);
      model.position.set(app.screen.width / 2, app.screen.height / 2);
      if (enableDragging) makeDraggableModel(model);
      const data = withFallbackModelData(normalized, readModelDataFromRuntime(model));
      disposeCurrentModel();
      app.stage.addChild(model);
      modelRef.current = model;
      isCompositeRef.current = false;
      motionBaseRef.current = url.slice(0, url.lastIndexOf("/") + 1);
      setModelData(data);
      updateBoundsFromDisplayObject(model);
    } catch (error) {
      if (model) {
        if (modelRef.current === model) {
          modelRef.current = null; isCompositeRef.current = false; motionBaseRef.current = null;
        }
        disposeModel(model);
      }
      if (!mounted.current || generation !== loadGeneration.current || appRef.current !== app) return;
      console.error("模型加载失败", error);
      setModelData(null);
      throw error;
    }
  };

  const loadJsonlComposite = async (app: PIXI.Application, jsonlUrl: string, generation: number, signal: AbortSignal) => {
    let container: PIXI.Container | null = null;
    const partialModels: JsonlLive2DModel[] = [];
    try {
      const response = await fetch(jsonlUrl, { cache: "no-cache", signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      const text = await response.text();
      assertCurrentLoad(app, generation);
      if (text.includes('<!DOCTYPE html>') || text.includes('<html')) throw new Error(`文件不存在或路径错误: ${jsonlUrl} (返回HTML页面)`);
      const loaded = await loadPixiCompositeModel({
        jsonlText: text, jsonlUrl, source: jsonlUrl,
        createContainer: () => {
          container = new PIXI.Container();
          container.sortableChildren = true;
          container.position.set(app.screen.width / 2, app.screen.height / 2);
          return container;
        },
        resolveAssetUrl: async (part, manifest) => {
          assertCurrentLoad(app, generation);
          return resolveCompositePath(part.path, manifest.source);
        },
        configureModel: async ({ model, part, resolvedUrl, modelIndex }) => {
          const taggedModel = model as unknown as JsonlLive2DModel;
          // Retain each completed part before the loader waits for another one.
          partialModels.push(taggedModel);
          retainModelResources(taggedModel);
          disableModelAutoBehaviors(taggedModel);
          assertCurrentLoad(app, generation);
          const { rawRoleId, mergedRoleId } = getCharacterIdFromPart(part, modelIndex);
          taggedModel.__characterId = mergedRoleId;
          taggedModel.__characterLabel = mergedRoleId;
          taggedModel.__compositeResolvedUrl = resolvedUrl;
          taggedModel.__jsonlRoleMeta = { id: rawRoleId, folder: part.folder, path: resolvedUrl, index: part.index ?? modelIndex };
          taggedModel.anchor?.set?.(0.5);
          const base = Math.min(app.screen.width / taggedModel.width, app.screen.height / taggedModel.height);
          taggedModel.scale.set(base * (part.xscale ?? 1), base * (part.yscale ?? 1));
          taggedModel.position.set(part.x ?? 0, part.y ?? 0);
        },
      });
      assertCurrentLoad(app, generation);
      const children = loaded.models as unknown as JsonlLive2DModel[];
      const firstModel = children[0], firstModelUrl = firstModel?.__compositeResolvedUrl;
      if (!firstModelUrl) throw new Error(`无法解析首个子模型路径: ${jsonlUrl}`);
      let data: ModelData;
      try {
        const synthesized = await synthesizeCompositeModelData(loaded.selectors, firstModelUrl, signal);
        data = withFallbackModelData(synthesized, readModelDataFromRuntime(firstModel));
      } catch (error) {
        assertCurrentLoad(app, generation);
        console.warn("复合模型素材索引读取失败，使用运行时索引", error);
        data = readModelDataFromRuntime(firstModel) ?? { motions: {}, expressions: [] };
      }
      assertCurrentLoad(app, generation);
      if (enableDragging) makeDraggableContainer(loaded.container as DraggableDisplayObject);
      disposeCurrentModel();
      app.stage.addChild(loaded.container);
      groupContainerRef.current = loaded.container;
      modelRef.current = children;
      isCompositeRef.current = true;
      motionBaseRef.current = firstModelUrl.slice(0, firstModelUrl.lastIndexOf("/") + 1);
      setModelData(data);
      requestAnimationFrame(() => {
        if (mounted.current && generation === loadGeneration.current && appRef.current === app && groupContainerRef.current === loaded.container) updateBoundsFromDisplayObject(loaded.container);
      });
    } catch (error) {
      if (groupContainerRef.current === container && container) {
        groupContainerRef.current = null; modelRef.current = null; isCompositeRef.current = false; motionBaseRef.current = null;
      }
      partialModels.forEach(disposeModel);
      if (container) disposeContainer(container);
      if (!mounted.current || generation !== loadGeneration.current || appRef.current !== app) return;
      console.error("复合模型加载失败", error);
      setModelData(null);
      throw error;
    }
  };

  const loadAnyModel = async (app: PIXI.Application, url: string) => {
    const generation = ++loadGeneration.current;
    fetchController.current?.abort();
    const controller = new AbortController();
    fetchController.current = controller;
    const finishLoad = beginModelResourceLoad();
    try {
      assertCurrentLoad(app, generation);
      if (isJsonl(url)) await loadJsonlComposite(app, url, generation, controller.signal);
      else await loadSingleModel(app, url, generation, controller.signal);
    } finally {
      finishLoad();
      if (fetchController.current === controller) fetchController.current = null;
    }
  };

  return {
    loadAnyModel,
    cleanupCurrentModel,
    forEachModel,
    isJsonl,
    resolveRelativeFrom
  };
} 
