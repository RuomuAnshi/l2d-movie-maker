import { evaluateTrack, splitAt } from "./engine";
import type { AnimationDocument, ParameterTrack, Keyframe } from "./types";

export type AnimationExportOptions = {
  kind: "motion" | "expression";
  name: string;
  characterId: string;
  partId: string;
  start: number;
  end: number;
  time: number;
  fps: number;
  fadeIn: number;
  scope: "animated" | "all" | "material";
  groupId?: string;
  destination: "file" | "model";
};
export type AnimationFile = { text: string; extension: string; parameterCount: number };

function exportTracks(document: AnimationDocument, options: AnimationExportOptions) {
  const group = document.groups.find(item => item.id === options.groupId);
  if (options.scope === "material" && !group) throw new Error("请选择素材。");
  const tracks = document.tracks.filter(track =>
    track.definition.characterId === options.characterId && track.definition.partId === options.partId &&
    (options.kind === "motion" || track.definition.kind === "parameter") &&
    (options.scope === "all" || (options.scope === "material" ? !!group?.curves[track.definition.target]
      : track.animated || track.baseValue !== track.definition.defaultValue)));
  if (!tracks.length) throw new Error("所选部件没有可导出的参数，请调整参数范围。");
  return tracks;
}

function clippedKeys(track: ParameterTrack, start: number, end: number): Keyframe[] {
  const keys = track.animated ? track.keys : [];
  // Clamp overshooting curves just as evaluateTrack does. Safe curves retain original handles.
  const needsBake = keys.some(key => [key, key.inHandle, key.outHandle].some(point =>
    point && (point.value < track.definition.min || point.value > track.definition.max)));
  if (needsBake) {
    const times = new Set([start, end, ...keys.filter(k => k.time > start && k.time < end).map(k => k.time)]);
    const count = Math.ceil((end - start) * 120);
    for (let i = 0; i <= count; i++) times.add(start + (end - start) * i / count);
    return [...times].sort((a, b) => a - b).map(time => ({
      id: String(time), time: time - start, value: evaluateTrack(track, time), interpolation: "linear",
    }));
  }
  return splitAt(splitAt(keys, start, track.baseValue), end, track.baseValue)
    .filter(key => key.time >= start && key.time <= end).map(key => ({
      ...key, time: key.time - start,
      value: Math.max(track.definition.min, Math.min(track.definition.max, key.value)),
      inHandle: key.inHandle && { ...key.inHandle, time: key.inHandle.time - start },
      outHandle: key.outHandle && { ...key.outHandle, time: key.outHandle.time - start },
    }));
}

/** Serialize final parameter curves, including the chosen overlap priority. */
export function exportAnimation(document: AnimationDocument, options: AnimationExportOptions, cubism: 2 | 3): AnimationFile {
  if (![options.start, options.end, options.time, options.fps, options.fadeIn].every(Number.isFinite) ||
      options.start < 0 || options.time < 0 || options.end <= options.start || options.fps < 1 || options.fps > 240 || options.fadeIn < 0)
    throw new Error("导出时间、帧率或淡入设置无效。");
  const tracks = exportTracks(document, options);
  const duration = options.end - options.start;
  if (duration * options.fps * tracks.length > 5_000_000) throw new Error("导出范围过大，请缩短时间范围。");
  if (options.kind === "expression") {
    const parameters = tracks.map(track => ({ id: track.definition.parameterId, value: evaluateTrack(track, options.time) }));
    const json = cubism === 2 ? {
      type: "Live2D Expression", fade_in: options.fadeIn * 1000, fade_out: 0,
      params: parameters.map(p => ({ id: p.id, val: p.value, calc: "set" })),
    } : {
      Type: "Live2D Expression", FadeInTime: options.fadeIn, FadeOutTime: 0,
      Parameters: parameters.map(p => ({ Id: p.id, Value: p.value, Blend: "Overwrite" })),
    };
    return { text: JSON.stringify(json, null, 2), extension: cubism === 2 ? "exp.json" : "exp3.json", parameterCount: tracks.length };
  }
  if (cubism === 2) {
    const count = Math.max(1, Math.ceil(duration * options.fps));
    const lines = tracks.map(track => `${track.definition.kind === "opacity" ? "VISIBLE:" : ""}${track.definition.parameterId}=` +
      Array.from({ length: count }, (_, i) => evaluateTrack(track, options.start + i / options.fps)).join(","));
    return { text: `# Live2D Movie Maker\n$fps=${options.fps}\n$fadein=0\n$fadeout=0\n${lines.join("\n")}\n`, extension: "mtn", parameterCount: tracks.length };
  }
  let segmentCount = 0, pointCount = 0;
  const curves = tracks.map(track => {
    const keys = clippedKeys(track, options.start, options.end);
    const segments: number[] = [keys[0].time, keys[0].value];
    pointCount += 1;
    for (let i = 1; i < keys.length; i++) {
      const a = keys[i - 1], b = keys[i];
      segmentCount++;
      if (a.interpolation === "bezier") {
        const out = a.outHandle ?? { time: a.time + (b.time - a.time) / 3, value: a.value };
        const into = b.inHandle ?? { time: b.time - (b.time - a.time) / 3, value: b.value };
        segments.push(1, out.time, out.value, into.time, into.value, b.time, b.value);
        pointCount += 3;
      } else {
        segments.push(a.interpolation === "hold" ? 2 : a.interpolation === "inverse-hold" ? 3 : 0, b.time, b.value);
        pointCount++;
      }
    }
    return { Target: track.definition.kind === "opacity" ? "PartOpacity" : "Parameter", Id: track.definition.parameterId, Segments: segments };
  });
  const json = { Version: 3, Meta: {
    Duration: duration, Fps: options.fps, Loop: false, AreBeziersRestricted: false,
    FadeInTime: 0, FadeOutTime: 0, CurveCount: curves.length,
    TotalSegmentCount: segmentCount, TotalPointCount: pointCount,
  }, Curves: curves };
  return { text: JSON.stringify(json, null, 2), extension: "motion3.json", parameterCount: tracks.length };
}
