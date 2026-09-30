/* Runtime SDKs expose incompatible private physics structures. Keep that boundary here. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { evaluateAt } from "./engine";
import { targetId, type AnimationDocument, type ParameterTrack } from "./types";
import { readModelDataFromRuntime } from "../utils/modelData";
export type RuntimeModel = any;
const copyState = (value: any, seen = new WeakSet<object>()): any => {
  if (value === null || typeof value !== "object")
    return typeof value === "function" ? undefined : value;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (ArrayBuffer.isView(value))
    return {
      typed: true,
      values: Array.from(value as unknown as ArrayLike<number>),
    };
  const result: any = Array.isArray(value) ? [] : {};
  for (const k of Object.keys(value))
    if (!["coreModel", "_model", "model"].includes(k)) {
      const v = copyState(value[k], seen);
      if (v !== undefined) result[k] = v;
    }
  return result;
};
const restoreState = (object: any, state: any) => {
  if (!object || !state) return;
  if (state.typed) {
    object.set(state.values);
    return;
  }
  for (const k of Object.keys(state))
    if (state[k] && typeof state[k] === "object")
      restoreState(object[k], state[k]);
    else object[k] = state[k];
};
export class ModelAdapter {
  tracks: ParameterTrack[] = [];
  private setters = new Map<string, (value: number) => void>();
  private initial: any;
  private currentDocument: AnimationDocument | null = null;
  private animatedTargets = new Set<string>();
  model: RuntimeModel;
  index: number;
  constructor(model: RuntimeModel, index: number) {
    this.model = model;
    this.index = index;
    model.autoUpdate = false;
    model.deltaTime = 0;
    model.internalModel.motionManager.stopAllMotions?.();
    const internal = model.internalModel,
      core = internal.coreModel;
    const native = core._model ?? core;
    const character = String(model.__characterId ?? "main"),
      part = String(model.__jsonlRoleMeta?.index ?? index);
    const add = (
      id: string,
      min: number,
      max: number,
      value: number,
      kind: "parameter" | "opacity",
      setter: (v: number) => void,
    ) => {
      const target = targetId(character, part, id);
      this.tracks.push({
        definition: {
          target,
          characterId: character,
          partId: part,
          parameterId: id,
          name: id,
          group: kind === "opacity" ? "部件透明度" : "参数",
          kind,
          min,
          max,
          defaultValue: value,
        },
        baseValue: value,
        animated: false,
        keys: [],
      });
      this.setters.set(target, setter);
    };
    if (native.parameters) {
      const p = native.parameters;
      p.ids.forEach((id: string, i: number) =>
        add(
          id,
          p.minimumValues[i],
          p.maximumValues[i],
          p.defaultValues[i],
          "parameter",
          (v) => {
            p.values[i] = v;
          },
        ),
      );
      native.parts.ids.forEach((id: string, i: number) =>
        add(id, 0, 1, native.parts.opacities[i], "opacity", (v) => {
          native.parts.opacities[i] = v;
        }),
      );
    } else {
      const context = core.getModelContext?.();
      // Cubism 2's shipped SDK has obfuscated storage names but stable context APIs.
      const ids = context?._$pb ?? [];
      ids.forEach((id: any, i: number) => {
        const label = String(id.id ?? id._$id ?? id);
        add(
          label,
          context.getParamMin(i),
          context.getParamMax(i),
          core.getParamFloat(i),
          "parameter",
          (v) => core.setParamFloat(i, v),
        );
      });
      (context?._$F2 ?? []).forEach((id: any, i: number) =>
        add(String(id), 0, 1, core.getPartsOpacity(i), "opacity", (v) =>
          core.setPartsOpacity(i, v),
        ),
      );
    }
    for (const track of this.tracks) {
      if (
        internal.settings
          ?.getEyeBlinkParameters?.()
          ?.includes(track.definition.parameterId)
      )
        track.definition.effect = "blink";
      if (
        internal.settings
          ?.getLipSyncParameters?.()
          ?.includes(track.definition.parameterId)
      )
        track.definition.effect = "lip";
    }
    if (!this.tracks.length) throw new Error("模型运行时未提供可读取的参数");
    this.initial = this.snapshot();
  }
  async metadata() {
    const settings = this.model.internalModel.settings;
    const path = settings?.json?.FileReferences?.DisplayInfo;
    if (!path) return;
    const response = await fetch(new URL(path, settings.url).href);
    if (!response.ok) return;
    const info = await response.json();
    const names = new Map((info.Parameters ?? []).map((p: any) => [p.Id, p]));
    const groups = new Map(
      (info.ParameterGroups ?? []).map((g: any) => [g.Id, g.Name]),
    );
    for (const track of this.tracks) {
      const p: any = names.get(track.definition.parameterId);
      if (p) {
        track.definition.name = p.Name ?? p.Id;
        track.definition.group = String(groups.get(p.GroupId) ?? "参数");
      }
    }
  }
  async material(name: string, kind: "motion" | "expression") {
    const data = readModelDataFromRuntime(this.model);
    const file =
      kind === "motion"
        ? data?.motions[name]?.[0]?.file
        : data?.expressions.find((e) => e.name === name)?.file;
    if (!file)
      throw new Error(
        `缺少${kind === "motion" ? "动作" : "表情"}素材：${name}`,
      );
    const settings = this.model.internalModel.settings;
    const base = this.model.__compositeResolvedUrl ?? settings.url;
    const url = settings.resolveURL?.(file) ?? new URL(file, base).href;
    const response = await fetch(url);
    if (!response.ok)
      throw new Error(`素材读取失败：${url} (${response.status})`);
    return response.text();
  }
  write(values: Record<string, number>) {
    for (const [id, set] of this.setters) {
      const value = values[id];
      if (value !== undefined) set(value);
    }
  }
  snapshot() {
    const core = this.model.internalModel.coreModel,
      native = core._model ?? core;
    const values = native.parameters
      ? [...native.parameters.values, ...native.parts.opacities]
      : this.tracks.map((t) =>
          t.definition.kind === "opacity"
            ? core.getPartsOpacity(t.definition.parameterId)
            : core.getParamFloat(t.definition.parameterId),
        );
    return {
      state: copyState({
        physics: this.model.internalModel.physics,
        pose: this.model.internalModel.pose,
      }),
      values,
    };
  }
  restore(state: any) {
    restoreState(
      {
        physics: this.model.internalModel.physics,
        pose: this.model.internalModel.pose,
      },
      state.state,
    );
    this.tracks.forEach((t, i) =>
      this.setters.get(t.definition.target)?.(state.values[i]),
    );
    this.model.internalModel.coreModel.update();
  }
  reset() {
    this.restore(this.initial);
  }
  step(document: AnimationDocument, time: number, dt: number, lip: number) {
    if (this.currentDocument !== document) {
      this.currentDocument = document;
      this.animatedTargets = new Set(
        document.tracks
          .filter((t) => t.animated)
          .map((t) => t.definition.target),
      );
    }
    const values = evaluateAt(document, time);
    this.write(values);
    const internal = this.model.internalModel,
      core = internal.coreModel;
    for (const track of this.tracks) {
      const animated = this.animatedTargets.has(track.definition.target);
      if (animated) continue;
      const id = track.definition.parameterId;
      if (
        track.definition.effect === "lip" ||
        /mouth.*open|PARAM_MOUTH_OPEN_Y/i.test(id)
      )
        this.setters.get(track.definition.target)?.(lip);
      if (
        track.definition.effect === "blink" ||
        /eye.*open|PARAM_EYE_[LR]_OPEN/i.test(id)
      ) {
        const cycle = 4 + ((document.seed + this.index * 17) % 11) / 10,
          phase = (time + this.index * 0.7) % cycle;
        const blink = phase < 0.16 ? Math.abs(phase - 0.08) / 0.08 : 1;
        this.setters.get(track.definition.target)?.(
          values[track.definition.target] * blink,
        );
      }
    }
    if (dt > 0 && internal.physics?.evaluate)
      internal.physics.evaluate(core, dt);
    else if (dt > 0) internal.physics?.update(time * 1000);
    if (dt > 0 && internal.pose?.updateParameters)
      internal.pose.updateParameters(core, dt);
    else if (dt > 0) internal.pose?.update(dt * 1000);
    for (const track of document.tracks)
      if (track.animated)
        this.setters.get(track.definition.target)?.(
          values[track.definition.target],
        );
    core.update();
  }
}
export class TimelineRenderer {
  private snapshots = new Map<number, any[]>();
  private document: AnimationDocument | null = null;
  private audioVersion: unknown;
  private liveFrame = -1;
  private liveState: any[] = [];
  adapters: ModelAdapter[];
  constructor(adapters: ModelAdapter[]) {
    this.adapters = adapters;
    this.invalidate();
  }
  invalidate() {
    this.liveFrame = -1;
    this.liveState = [];
    this.snapshots.clear();
    this.adapters.forEach((a) => a.reset());
    this.snapshots.set(
      0,
      this.adapters.map((a) => a.snapshot()),
    );
    this.document = null;
  }
  seek(
    document: AnimationDocument,
    time: number,
    lipAt: (t: number) => number = () => 0,
    audioVersion: unknown = null,
  ) {
    if (this.audioVersion !== audioVersion) {
      this.invalidate();
      this.audioVersion = audioVersion;
    }
    if (this.document !== document) {
      const earliest = this.document
        ? firstChangedTime(this.document, document)
        : 0;
      if (this.liveFrame >= earliest * 120) {
        this.liveFrame = -1;
        this.liveState = [];
      }
      for (const step of this.snapshots.keys())
        if (step >= earliest * 120) this.snapshots.delete(step);
      if (!this.snapshots.has(0)) {
        this.adapters.forEach((a) => a.reset());
        this.adapters.forEach((a) => a.step(document, 0, 0, lipAt(0)));
        this.snapshots.set(
          0,
          this.adapters.map((a) => a.snapshot()),
        );
      }
      this.document = document;
    }

    const target = Math.max(0, time),
      step = 1 / 120,
      whole = Math.floor(target * 120 + 1e-8);
    let cached = Math.max(
      ...[...this.snapshots.keys()].filter((s) => s <= whole),
    );
    const useLive = this.liveFrame >= cached && this.liveFrame <= whole;
    if (useLive) cached = this.liveFrame;
    const state = useLive ? this.liveState : this.snapshots.get(cached)!;
    this.adapters.forEach((a, i) => a.restore(state[i]));
    for (let frame = cached + 1; frame <= whole; frame++) {
      const t = frame * step;
      this.adapters.forEach((a) => a.step(document, t, step, lipAt(t)));
      if (frame % 120 === 0)
        this.snapshots.set(
          frame,
          this.adapters.map((a) => a.snapshot()),
        );
    }

    this.liveFrame = whole;
    this.liveState = this.adapters.map((a) => a.snapshot());
    const fractional = target - whole * step;
    if (fractional > 1e-9)
      this.adapters.forEach((a) =>
        a.step(document, target, fractional, lipAt(target)),
      );
  }
}

export function firstChangedTime(
  before: AnimationDocument,
  after: AnimationDocument,
): number {
  if (
    before.seed !== after.seed ||
    before.tracks.length !== after.tracks.length
  )
    return 0;
  let earliest = Infinity;
  for (const track of after.tracks) {
    const old = before.tracks.find(
      (t) => t.definition.target === track.definition.target,
    );
    if (
      !old ||
      old.baseValue !== track.baseValue ||
      old.animated !== track.animated ||
      JSON.stringify(old.definition) !== JSON.stringify(track.definition)
    )
      return 0;
    const count = Math.max(old.keys.length, track.keys.length);
    for (let i = 0; i < count; i++)
      if (JSON.stringify(old.keys[i]) !== JSON.stringify(track.keys[i])) {
        earliest = Math.min(
          earliest,
          old.keys[Math.max(0, i - 1)]?.time ?? 0,
          track.keys[Math.max(0, i - 1)]?.time ?? 0,
        );
        break;
      }
  }
  return earliest;
}
