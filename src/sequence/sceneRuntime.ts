import * as PIXI from "pixi.js";
import { Live2DModel } from "pixi-live2d-display";
import { loadPixiCompositeModel, resolveCompositePath } from "composite-model";
import { ModelAdapter, TimelineRenderer } from "../animation/runtime";
import type { AnimationDocument, ParameterTrack } from "../animation/types";
import type { JsonlLive2DModel } from "../components/ModelManager";
import { beginModelResourceLoad, retainModelResources, releaseModelResources } from "./modelResources";
import type { Clip, Live2DActor, ProjectAsset, ProjectDocument, Sequence, Transform } from "./types";
import { evaluateClipTransform } from "./engine";
import { renderClipText } from "./text";

type ActorRuntime = {
  actorId: string;
  uri: string;
  partId: string;
  container: PIXI.Container;
  models: JsonlLive2DModel[];
  renderer: TimelineRenderer;
  disposed: boolean;
};
type SequenceRuntime = {
  sequenceId: string;
  path: string[];
  container: PIXI.Container;
  texture: PIXI.RenderTexture;
  actors: Map<string, ActorRuntime>;
  visuals: Map<string, PIXI.Sprite | PIXI.Text>;
  disposed: boolean;
};
type RuntimeCallbacks = {
  resolveAssetUrl: (asset: ProjectAsset) => Promise<string>;
  onParametersReady?: (sequenceId: string, animation: AnimationDocument, source: AnimationDocument) => void;
  onError?: (message: string) => void;
  onThumbnailReady?: (assetId: string, thumbnail: string) => void;
};
type PreviewPreparation = {
  issues: Set<string>;
  unavailableClips: Set<string>;
  unavailableActors: Set<string>;
};
class SceneCancelledError extends Error {}

/** Owns all visible instances. Each path has separate native model state and physics snapshots. */
export class SceneRuntime {
  private project: ProjectDocument;
  private sequences = new Map<string, SequenceRuntime>();
  private actorLoads = new Map<string, Promise<ActorRuntime>>();
  private imageLoads = new Map<string, Promise<PIXI.Texture>>();
  private imageTextures = new Map<string, PIXI.Texture>();
  private thumbnailAssets = new Set<string>();
  private revision = 0;
  private disposed = false;
  private sprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
  private latest: { sequenceId: string; time: number; options: SceneSeekOptions } | null = null;
  private normalized = new WeakMap<AnimationDocument, Map<string, AnimationDocument>>();
  private lastPreviewIssue = "";
  private app: PIXI.Application;
  private callbacks: RuntimeCallbacks;
  constructor(app: PIXI.Application, project: ProjectDocument, callbacks: RuntimeCallbacks) {
    this.app = app;
    this.callbacks = callbacks;
    this.project = project;
    this.sprite.anchor.set(0.5);
    this.sprite.zIndex = 500;
    this.app.stage.addChild(this.sprite);
  }

  setProject(project: ProjectDocument) {
    this.project = project;
    for (const [key, runtime] of this.sequences) {
      let sequence: Sequence | undefined = project.sequences[runtime.path[0]];
      for (const clipId of runtime.path.slice(1)) {
        const clip: Clip | undefined = sequence?.tracks.flatMap((track) => track.clips).find((clip) => clip.id === clipId);
        sequence = clip?.sequenceId ? project.sequences[clip.sequenceId] : undefined;
      }
      if (!sequence || sequence.id !== runtime.sequenceId) {
        this.disposeSequence(runtime); this.sequences.delete(key);
        continue;
      }
      else if (sequence.kind === "live2d") {
        for (const [actorId, actor] of runtime.actors) {
          const current = sequence.actors.find((item) => item.id === actorId);
          const asset = current ? project.assets[current.assetId] : undefined;
          if (!current || !asset || asset.missing || !asset.uri || asset.uri.startsWith("bundle:") || asset.uri !== actor.uri || current.modelPartId !== actor.partId) {
            this.disposeActor(actor); runtime.actors.delete(actorId);
          }
        }
      }
      if (sequence) for (const [id, display] of runtime.visuals) {
        if (!sequence.tracks.some((track) => track.clips.some((clip) => clip.id === id))) {
          display.destroy({ children: true, texture: false, baseTexture: false }); runtime.visuals.delete(id);
        }
      }
    }
  }

  setVisible(visible: boolean) { this.sprite.visible = visible; }

  private key(path: string[]) { return JSON.stringify(path); }
  private getSequence(sequence: Sequence, path: string[]): SequenceRuntime {
    const key = this.key(path);
    let runtime = this.sequences.get(key);
    if (runtime && (runtime.sequenceId !== sequence.id || runtime.texture.width !== sequence.width || runtime.texture.height !== sequence.height)) {
      this.disposeSequence(runtime);
      this.sequences.delete(key);
      runtime = undefined;
    }
    if (!runtime) {
      runtime = {
        sequenceId: sequence.id, path, container: new PIXI.Container(),
        texture: PIXI.RenderTexture.create({ width: sequence.width, height: sequence.height, resolution: 1 }),
        actors: new Map(), visuals: new Map(), disposed: false,
      };
      this.sequences.set(key, runtime);
    }
    return runtime;
  }

  private image(asset: ProjectAsset): Promise<PIXI.Texture> {
    let pending = this.imageLoads.get(asset.uri);
    if (!pending) {
      pending = this.callbacks.resolveAssetUrl(asset).then((url) => PIXI.Texture.fromURL(url)).then((texture) => {
        if (this.disposed) { texture.destroy(true); throw new SceneCancelledError("场景已关闭"); }
        this.imageTextures.set(asset.uri, texture); return texture;
      });
      this.imageLoads.set(asset.uri, pending);
      void pending.catch(() => this.imageLoads.delete(asset.uri));
    }
    return pending;
  }

  private actor(sequence: Sequence, runtime: SequenceRuntime, actor: Live2DActor): Promise<ActorRuntime> {
    const asset = this.project.assets[actor.assetId];
    const loaded = runtime.actors.get(actor.id);
    if (!asset || asset.missing || !asset.uri || asset.uri.startsWith("bundle:")) {
      if (loaded) { this.disposeActor(loaded); runtime.actors.delete(actor.id); }
      return Promise.reject(new Error(`缺少模型素材：${asset?.name ?? actor.name}`));
    }
    if (loaded?.uri === asset.uri && loaded.partId === actor.modelPartId) return Promise.resolve(loaded);
    if (loaded) { this.disposeActor(loaded); runtime.actors.delete(actor.id); }
    const key = `${this.key(runtime.path)}:${actor.id}:${actor.modelPartId}:${asset.uri}`;
    let pending = this.actorLoads.get(key);
    if (pending) return pending;
    pending = (async () => {
      const url = await this.callbacks.resolveAssetUrl(asset);
      const finishLoading = beginModelResourceLoad();
      let models: JsonlLive2DModel[] = [];
      const container = new PIXI.Container();
      try {
      if (/\.jsonl(?:[?#]|$)/i.test(url)) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`模型读取失败：${asset.name} (${response.status})`);
        const loaded = await loadPixiCompositeModel({
          jsonlText: await response.text(), jsonlUrl: url, source: url,
          createContainer: () => container,
          resolveAssetUrl: async (part, manifest) => resolveCompositePath(part.path, manifest.source),
          configureModel: async ({ model, part, resolvedUrl, modelIndex }) => {
            const tagged = model as unknown as JsonlLive2DModel;
            models.push(tagged);
            tagged.autoUpdate = false; tagged.deltaTime = 0; tagged.autoInteract = false;
            tagged.visible = true;
            tagged.internalModel.motionManager.stopAllMotions();
            retainModelResources(tagged);
            tagged.__characterId = String(part.id ?? part.folder ?? "main").replace(/\d+$/, "") || "main";
            tagged.__compositeResolvedUrl = resolvedUrl;
            tagged.__jsonlRoleMeta = { id: String(part.id ?? modelIndex), index: part.index ?? modelIndex, path: resolvedUrl, folder: part.folder };
            tagged.anchor.set(0.5);
            const scale = Math.min(sequence.width / tagged.width, sequence.height / tagged.height) * (asset.metadata?.legacyTransform ? 1 : 0.85);
            tagged.scale.set(scale * (part.xscale ?? 1), scale * (part.yscale ?? 1));
            tagged.position.set(part.x ?? 0, part.y ?? 0);
          },
        });
        models = loaded.models as unknown as JsonlLive2DModel[];
      } else {
        const model = await Live2DModel.from(url, { autoUpdate: false, autoInteract: false }) as JsonlLive2DModel;
        models = [model]; retainModelResources(model);
        model.__characterId = "main";
        model.__compositeResolvedUrl = url;
        model.anchor.set(0.5);
        const scale = asset.metadata?.legacyTransform ? 1 : Math.min(sequence.width / model.width, sequence.height / model.height) * 0.85;
        model.scale.set(scale);
        container.addChild(model);
      }
      if (this.disposed || runtime.disposed) throw new SceneCancelledError("场景已关闭");
      for (const model of models) { model.autoInteract = false; retainModelResources(model); }
      const adapters = models.map((model, index) => new ModelAdapter(model, index, {
        characterId: actor.id, partId: models.length > 1 ? `${actor.modelPartId}:${model.__jsonlRoleMeta?.index ?? index}` : actor.modelPartId,
      }));
      await Promise.all(adapters.map((adapter) => adapter.metadata().catch(() => undefined)));
      const current = this.project.sequences[sequence.id];
      if (this.disposed || runtime.disposed || current?.kind !== "live2d" || !current.actors.some((item) => item.id === actor.id && item.modelPartId === actor.modelPartId && !this.project.assets[item.assetId]?.missing && this.project.assets[item.assetId]?.uri === asset.uri)) throw new SceneCancelledError("模型实例已改变");
      const instance = { actorId: actor.id, uri: asset.uri, partId: actor.modelPartId, container, models, renderer: new TimelineRenderer(adapters), disposed: false };
      runtime.actors.set(actor.id, instance);
      runtime.container.addChild(container);
      return instance;
      } catch (error) {
        for (const model of models) {
          try { model.destroy({ children: true, texture: false, baseTexture: false }); }
          finally { releaseModelResources(model); }
        }
        container.destroy({ children: false });
        throw error;
      } finally { finishLoading(); }
    })();
    this.actorLoads.set(key, pending);
    void pending.finally(() => this.actorLoads.delete(key)).catch(() => undefined);
    return pending;
  }

  private normalizeAnimation(sequence: Sequence, runtime: SequenceRuntime): AnimationDocument | null {
    if (sequence.kind !== "live2d") return null;
    const signature = [...runtime.actors.values()].map((actor) => actor.uri + actor.actorId + actor.partId).join("|");
    let cache = this.normalized.get(sequence.animation);
    const cached = cache?.get(signature);
    if (cached) return cached;
    const definitions = [...runtime.actors.values()].flatMap((actor) => actor.renderer.adapters.flatMap((adapter) => adapter.tracks));
    const mapping = new Map<string, string>();
    const used = new Set<string>();
    const tracks = definitions.map((track): ParameterTrack => {
      const exact = sequence.animation.tracks.find((saved) => saved.definition.target === track.definition.target);
      const parts = track.definition.partId.split(":");
      const index = parts[parts.length - 1];
      const saved = exact ?? sequence.animation.tracks.find((candidate) => !used.has(candidate.definition.target)
        && candidate.definition.parameterId === track.definition.parameterId && candidate.definition.kind === track.definition.kind
        && (candidate.definition.partId === track.definition.partId || candidate.definition.partId === index || definitions.filter((item) => item.definition.parameterId === candidate.definition.parameterId).length === 1));
      if (!saved) return track;
      used.add(saved.definition.target); mapping.set(saved.definition.target, track.definition.target);
      return { ...saved, definition: track.definition };
    });
    const missing = sequence.animation.tracks.filter((track) => !used.has(track.definition.target) && !definitions.some((item) => item.definition.target === track.definition.target));
    const remap = (curves: Record<string, import("../animation/types").Keyframe[]>) => Object.fromEntries(Object.entries(curves).map(([id, keys]) => [mapping.get(id) ?? id, keys]));
    const result = {
      ...sequence.animation, tracks: [...tracks, ...missing],
      groups: sequence.animation.groups.map((group) => ({ ...group, curves: remap(group.curves), originalCurves: group.originalCurves ? remap(group.originalCurves) : undefined })),
    };
    if (!cache) { cache = new Map(); this.normalized.set(sequence.animation, cache); }
    cache.set(signature, result);
    if (JSON.stringify(sequence.animation.tracks.map((t) => t.definition)) !== JSON.stringify(result.tracks.map((t) => t.definition))) this.callbacks.onParametersReady?.(sequence.id, result, sequence.animation);
    return result;
  }

  async prepareSequence(sequenceId: string, all = false, time = 0, path = [sequenceId], ancestors = new Set<string>()): Promise<void> {
    return this.prepare(sequenceId, all, time, path, ancestors);
  }

  private async prepare(sequenceId: string, all: boolean, time: number, path: string[], ancestors: Set<string>, preview?: PreviewPreparation): Promise<void> {
    if (this.disposed) throw new SceneCancelledError("场景已关闭");
    if (ancestors.has(sequenceId)) throw new Error("循环嵌套序列。");
    const sequence = this.project.sequences[sequenceId];
    if (!sequence) throw new Error(`缺少序列：${sequenceId}`);
    const runtime = this.getSequence(sequence, path);
    const nextAncestors = new Set(ancestors).add(sequenceId);
    if (sequence.kind === "live2d") {
      await Promise.all(sequence.actors.map(async (actor) => {
        try { await this.actor(sequence, runtime, actor); }
        catch (error) {
          if (!preview || error instanceof SceneCancelledError) throw error;
          preview.unavailableActors.add(this.key([...path, actor.id]));
          preview.issues.add(error instanceof Error ? error.message : String(error));
        }
      }));
      this.normalizeAnimation(sequence, runtime);
    }
    await Promise.all(sequence.tracks.flatMap((track) => track.clips.filter((clip) => all || (time >= clip.start && time < clip.start + clip.duration)).map(async (clip) => {
      try {
      if (clip.placeholder) throw new Error(`片段“${clip.name}”缺少素材：${clip.placeholder.reason}`);
      if (clip.sequenceId) return await this.prepare(clip.sequenceId, all, clip.sourceIn + (time - clip.start) * clip.rate, [...path, clip.id], nextAncestors, preview);
      const asset = clip.assetId ? this.project.assets[clip.assetId] : undefined;
      if (!asset || asset.missing) throw new Error(`缺少素材：${clip.name}`);
      if (clip.kind === "image") await this.image(asset);
      } catch (error) {
        if (!preview || error instanceof SceneCancelledError) throw error;
        preview.unavailableClips.add(this.key([...path, clip.id]));
        preview.issues.add(error instanceof Error ? error.message : String(error));
      }
    })));
  }

  getAdapters(sequenceId: string): ModelAdapter[] {
    const runtime = [...this.sequences.values()].find((item) => item.sequenceId === sequenceId && item.actors.size);
    return runtime ? [...runtime.actors.values()].flatMap((actor) => actor.renderer.adapters) : [];
  }

  private setTransform(display: PIXI.Container, transform: Transform, width: number, height: number) {
    display.position.set(width / 2 + transform.x, height / 2 + transform.y);
    display.scale.set(transform.scaleX, transform.scaleY);
    display.rotation = transform.rotation * Math.PI / 180;
    display.alpha = transform.opacity;
  }

  private drawSequence(sequenceId: string, time: number, path: string[], options: SceneSeekOptions, preview?: PreviewPreparation): PIXI.RenderTexture {
    const sequence = this.project.sequences[sequenceId];
    const runtime = this.getSequence(sequence, path);
    for (const child of runtime.container.children) child.visible = false;
    if (sequence.kind === "live2d") {
      const animation = this.normalizeAnimation(sequence, runtime) ?? sequence.animation;
      for (const actor of sequence.actors) {
        const instance = runtime.actors.get(actor.id);
        const asset = this.project.assets[actor.assetId];
        if (!instance || !asset || asset.missing || instance.uri !== asset.uri || preview?.unavailableActors.has(this.key([...path, actor.id]))) continue;
        instance.renderer.seek(animation, time, (sourceTime) => options.lipAt?.(sequence.id, actor.id, sourceTime, path) ?? 0, options.audioVersion);
        instance.container.visible = actor.visible && options.mode !== "subtitle-only";
        this.setTransform(instance.container, actor.transform, sequence.width, sequence.height);
        if (actor.visible && this.callbacks.onThumbnailReady && !this.thumbnailAssets.has(actor.assetId)) {
          this.thumbnailAssets.add(actor.assetId);
          try {
            const source = this.app.renderer.plugins.extract.canvas(instance.container) as HTMLCanvasElement;
            const canvas = document.createElement("canvas"); canvas.width = 160; canvas.height = 160;
            const context = canvas.getContext("2d");
            if (context) {
              const scale = Math.min(160 / source.width, 160 / source.height);
              context.drawImage(source, (160 - source.width * scale) / 2, (160 - source.height * scale) / 2, source.width * scale, source.height * scale);
              this.callbacks.onThumbnailReady(actor.assetId, canvas.toDataURL("image/png"));
            }
          } catch { /* 缩略图失败不会中断模型求值。 */ }
        }
        runtime.container.setChildIndex(instance.container, runtime.container.children.length - 1);
      }
    }
    for (const track of sequence.tracks.slice().sort((a, b) => b.order - a.order)) {
      if (track.hidden) continue;
      for (const clip of track.clips) {
        if (time < clip.start || time >= clip.start + clip.duration || clip.kind === "audio") continue;
        if (clip.placeholder || preview?.unavailableClips.has(this.key([...path, clip.id]))) continue;
        if (options.mode === "live2d-only" && clip.kind === "text") continue;
        if (options.mode === "subtitle-only" && !clip.sequenceId && clip.kind !== "text") continue;
        const sourceTime = clip.sourceIn + (time - clip.start) * clip.rate;
        const asset = clip.assetId ? this.project.assets[clip.assetId] : undefined;
        if (clip.sequenceId ? !this.project.sequences[clip.sequenceId] : !asset || asset.missing) continue;
        if (clip.kind === "image" && (!asset || !this.imageTextures.has(asset.uri))) continue;
        let display = runtime.visuals.get(clip.id);
        let texture: PIXI.Texture | undefined;
        if (clip.sequenceId) texture = this.drawSequence(clip.sequenceId, sourceTime, [...path, clip.id], options, preview);
        if (!display) {
          if (clip.kind === "text") {
            display = new PIXI.Text(renderClipText(clip, asset), {
              fontFamily: clip.fontFamily ?? String(asset?.metadata?.fontFamily ?? "sans-serif"), fontSize: clip.fontSize ?? Number(asset?.metadata?.fontSize ?? 34),
              fill: clip.textColor ?? String(asset?.metadata?.color ?? "#ffffff"), align: "center", wordWrap: true, wordWrapWidth: sequence.width * 0.8,
            });
          } else display = new PIXI.Sprite(texture ?? PIXI.Texture.EMPTY);
          display.anchor.set(0.5); runtime.visuals.set(clip.id, display); runtime.container.addChild(display);
        }
        if (display instanceof PIXI.Text) {
          display.text = renderClipText(clip, asset);
          display.style.fontFamily = clip.fontFamily ?? String(asset?.metadata?.fontFamily ?? "sans-serif");
          display.style.fontSize = clip.fontSize ?? Number(asset?.metadata?.fontSize ?? 34);
          display.style.fill = clip.textColor ?? String(asset?.metadata?.color ?? "#ffffff");
        } else if (texture) display.texture = texture;
        else if (clip.kind === "image" && asset && this.imageTextures.has(asset.uri)) display.texture = this.imageTextures.get(asset.uri)!;
        display.visible = true;
        this.setTransform(display, evaluateClipTransform(clip, sourceTime), sequence.width, sequence.height);
        runtime.container.setChildIndex(display, runtime.container.children.length - 1);
      }
    }
    const alpha = this.app.renderer.backgroundAlpha;
    this.app.renderer.backgroundAlpha = 0;
    try { this.app.renderer.render(runtime.container, { renderTexture: runtime.texture, clear: true }); }
    finally { this.app.renderer.backgroundAlpha = alpha; }
    return runtime.texture;
  }

  async seekSceneAt(sequenceId: string, time: number, options: SceneSeekOptions = {}): Promise<void> {
    const revision = ++this.revision;
    this.latest = { sequenceId, time, options };
    const preview: PreviewPreparation | undefined = options.offline ? undefined : { issues: new Set(), unavailableClips: new Set(), unavailableActors: new Set() };
    await this.prepare(sequenceId, false, time, [sequenceId], new Set(), preview);
    if (this.disposed || (!options.offline && revision !== this.revision)) return;
    const texture = this.drawSequence(sequenceId, Math.max(0, time), [sequenceId], options, preview);
    this.sprite.texture = texture;
    const sequence = this.project.sequences[sequenceId];
    const scale = Math.min(this.app.screen.width / sequence.width, this.app.screen.height / sequence.height);
    this.sprite.position.set(this.app.screen.width / 2, this.app.screen.height / 2);
    this.sprite.scale.set(scale);
    this.sprite.visible = true;
    this.app.renderer.render(this.app.stage);
    if (preview) {
      const issue = [...preview.issues].join("\n");
      if (issue && issue !== this.lastPreviewIssue) this.callbacks.onError?.(issue);
      this.lastPreviewIssue = issue;
    }
  }

  seekPreview(sequenceId: string, time: number) {
    void this.seekSceneAt(sequenceId, time).catch((error) => this.callbacks.onError?.(error instanceof Error ? error.message : String(error)));
  }
  refreshPreview() {
    if (this.latest) void this.seekSceneAt(this.latest.sequenceId, this.latest.time, this.latest.options).catch((error) => this.callbacks.onError?.(String(error)));
  }

  pointInSequence(x: number, y: number): { sequenceId: string; x: number; y: number } | null {
    if (!this.latest || !this.sprite.visible || !this.sprite.scale.x) return null;
    const sequence = this.project.sequences[this.latest.sequenceId];
    if (!sequence) return null;
    const point = { sequenceId: sequence.id, x: (x - this.sprite.x) / this.sprite.scale.x + sequence.width / 2, y: (y - this.sprite.y) / this.sprite.scale.y + sequence.height / 2 };
    return point.x >= 0 && point.x <= sequence.width && point.y >= 0 && point.y <= sequence.height ? point : null;
  }

  /** The final canvas owns pointer routing; offscreen children are never interaction targets. */
  hitTest(x: number, y: number): { sequenceId: string; clipId?: string; actorId?: string } | null {
    const point = this.pointInSequence(x, y);
    if (!point || !this.latest) return null;
    const sequence = this.project.sequences[point.sequenceId];
    const runtime = this.sequences.get(this.key([sequence.id]));
    if (!runtime) return null;
    const inside = (display: PIXI.Container, transform: Transform) => {
      const dx = point.x - sequence.width / 2 - transform.x, dy = point.y - sequence.height / 2 - transform.y;
      const angle = -transform.rotation * Math.PI / 180;
      if (!transform.scaleX || !transform.scaleY || !transform.opacity) return false;
      const localX = (dx * Math.cos(angle) - dy * Math.sin(angle)) / transform.scaleX;
      const localY = (dx * Math.sin(angle) + dy * Math.cos(angle)) / transform.scaleY;
      return display.getLocalBounds().contains(localX, localY);
    };
    for (const track of sequence.tracks.slice().sort((a, b) => a.order - b.order)) {
      if (track.hidden || track.locked) continue;
      for (const clip of track.clips) {
        const time = this.latest.time;
        if (clip.kind === "audio" || time < clip.start || time >= clip.start + clip.duration) continue;
        const display = runtime.visuals.get(clip.id);
        if (display?.visible && inside(display, evaluateClipTransform(clip, clip.sourceIn + (time - clip.start) * clip.rate))) return { sequenceId: sequence.id, clipId: clip.id };
      }
    }
    if (sequence.kind === "live2d") for (const actor of sequence.actors.slice().reverse()) {
      const instance = runtime.actors.get(actor.id);
      if (actor.visible && instance?.container.visible && inside(instance.container, actor.transform)) return { sequenceId: sequence.id, actorId: actor.id };
    }
    return null;
  }

  private disposeActor(actor: ActorRuntime) {
    if (actor.disposed) return;
    actor.disposed = true;
    for (const model of actor.models) {
      try { model.destroy({ children: true, texture: false, baseTexture: false }); }
      finally { releaseModelResources(model); }
    }
    actor.container.destroy({ children: false });
  }
  private disposeSequence(runtime: SequenceRuntime) {
    if (runtime.disposed) return;
    runtime.disposed = true;
    for (const actor of runtime.actors.values()) this.disposeActor(actor);
    runtime.actors.clear();
    for (const display of runtime.visuals.values()) display.destroy({ children: true, texture: false, baseTexture: false });
    runtime.visuals.clear();
    runtime.container.destroy({ children: false }); runtime.texture.destroy(true);
  }
  destroy() {
    if (this.disposed) return;
    this.disposed = true; this.revision += 1;
    for (const runtime of this.sequences.values()) this.disposeSequence(runtime);
    this.sequences.clear(); this.sprite.destroy({ texture: false, baseTexture: false });
    for (const texture of new Set(this.imageTextures.values())) texture.destroy(true);
    this.imageTextures.clear();
  }
}

export type SceneSeekOptions = {
  offline?: boolean;
  mode?: "composite" | "live2d-only" | "subtitle-only";
  audioVersion?: unknown;
  lipAt?: (sequenceId: string, actorId: string, time: number, path: string[]) => number;
};
