import { curveValue, evaluateTrack, insertSource } from "./engine";
import type {
  AnimationDocument,
  Keyframe,
  ParameterTrack,
  SourceGroup,
} from "./types";
const key = (time: number, value: number): Keyframe => ({
  id: crypto.randomUUID(),
  time,
  value,
  interpolation: "linear",
});
export function parseMotion(text: string): {
  duration: number;
  curves: Record<string, Keyframe[]>;
} {
  const curves: Record<string, Keyframe[]> = {};
  if (text.trimStart().startsWith("{")) {
    const json = JSON.parse(text);
    for (const curve of json.Curves ?? []) {
      if (!["Parameter", "PartOpacity", "Model"].includes(curve.Target))
        continue;
      const s: number[] = curve.Segments;
      if (!s || s.length < 2) throw new Error(`曲线损坏：${curve.Id}`);
      const keys = [key(s[0], s[1])];
      let i = 2;
      while (i < s.length) {
        const type = s[i++],
          previous = keys[keys.length - 1];
        if (type === 1) {
          previous.interpolation = "bezier";
          previous.outHandle = { time: s[i++], value: s[i++] };
          const handle = { time: s[i++], value: s[i++] };
          const next = key(s[i++], s[i++]);
          next.inHandle = handle;
          keys.push(next);
        } else if ([0, 2, 3].includes(type)) {
          previous.interpolation =
            type === 2 ? "hold" : type === 3 ? "inverse-hold" : "linear";
          keys.push(key(s[i++], s[i++]));
        } else throw new Error(`未知曲线插值：${type}`);
      }
      if (
        keys.some((k, index) => !Number.isFinite(k.time) || !Number.isFinite(k.value) || k.time < 0 || (index > 0 && k.time < keys[index - 1].time) || [k.inHandle, k.outHandle].some(h => h && (!Number.isFinite(h.time) || !Number.isFinite(h.value))))
      )
        throw new Error(`无效曲线：${curve.Id}`);
      curves[
        `${curve.Target === "PartOpacity" ? "opacity" : curve.Target === "Model" ? "model" : "parameter"}:${curve.Id}`
      ] = keys;
    }
    return {
      duration:
        Number(json.Meta?.Duration) ||
        Object.values(curves).reduce((end, keys) => Math.max(end, keys[keys.length - 1]?.time ?? 0), 0),
      curves,
    };
  }
  let fps = 30;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at < 0) continue;
    const id = line.slice(0, at).trim(),
      value = line.slice(at + 1).trim();
    if (id === "$fps") {
      fps = Number(value);
      if (!(fps > 0)) throw new Error("MTN 采样率无效");
      continue;
    }
    if (id.startsWith("$")) continue;
    const values = value.split(",").map(Number);
    if (values.some((v) => !Number.isFinite(v)))
      throw new Error(`MTN 参数损坏：${id}`);
    if (id.startsWith("LAYOUT:")) continue; // Screen transforms retain their existing editor.
    const channel = id.startsWith("VISIBLE:")
      ? `opacity:${id.slice(8)}`
      : `parameter:${id}`;
    curves[channel] = values.map((v, i) => key(i / fps, v));
  }
  if (!Object.keys(curves).length)
    throw new Error("素材中没有可导入的参数曲线");
  return {
    duration: Math.max(...Object.values(curves).map((k) => k.length / fps)),
    curves,
  };
}
export function importMaterial(
  document: AnimationDocument,
  tracks: ParameterTrack[],
  text: string,
  kind: "motion" | "expression",
  name: string,
  start: number,
  duration?: number,
): AnimationDocument {
  const curves: Record<string, Keyframe[]> = {};
  let sourceDuration = 0;
  if (kind === "motion") {
    const parsed = parseMotion(text);
    sourceDuration = parsed.duration;
    for (const track of tracks) {
      const source =
        parsed.curves[
          `${track.definition.kind}:${track.definition.parameterId}`
        ];
      const effect = track.definition.effect
        ? parsed.curves[
            `model:${track.definition.effect === "blink" ? "EyeBlink" : "LipSync"}`
          ]
        : undefined;
      if (source && effect) {
        const count = Math.max(1, Math.ceil(sourceDuration * 120));
        curves[track.definition.target] = Array.from(
          { length: count + 1 },
          (_, i) => {
            const time = (sourceDuration * i) / count,
              a = curveValue(source, track.baseValue, time),
              b = curveValue(
                effect,
                track.definition.effect === "blink" ? 1 : 0,
                time,
              );
            return key(
              time,
              track.definition.effect === "blink" ? a * b : a + b,
            );
          },
        );
      } else if (source) curves[track.definition.target] = source;
      else if (effect) curves[track.definition.target] = effect;
    }
  } else {
    const json = JSON.parse(text);
    const params = json.Parameters ?? json.params ?? [];
    sourceDuration = Math.max(
      0,
      Number(json.FadeInTime ?? (json.fade_in == null ? 0.5 : json.fade_in / 1000)),
    );
    for (const p of params) {
      const id = p.Id ?? p.id;
      for (const track of tracks.filter(
        (t) =>
          t.definition.parameterId === id && t.definition.kind === "parameter",
      )) {
        const base = evaluateTrack(track, start),
          value = Number(p.Value ?? p.val),
          blend = String(p.Blend ?? p.calc ?? "Add").toLowerCase();
        const result =
          blend === "multiply" || blend === "mult"
            ? base * value
            : blend === "overwrite" || blend === "set"
              ? value
              : base + value;
        if (!Number.isFinite(result)) throw new Error(`表情参数无效：${id}`);
        // Cubism expressions use a cosine fade. Bake it independently of runtime clocks.
        const count = Math.max(1, Math.ceil(sourceDuration * 120));
        curves[track.definition.target] = Array.from(
          { length: count + 1 },
          (_, i) =>
            key(
              (sourceDuration * i) / count,
              base +
                (result - base) * (0.5 - 0.5 * Math.cos((Math.PI * i) / count)),
            ),
        );
      }
    }
  }
  if (!Object.keys(curves).length)
    throw new Error(`“${name}”没有匹配当前模型的参数`);
  const group: SourceGroup = {
    id: crypto.randomUUID(),
    name,
    kind,
    start,
    duration: duration ?? Math.max(0.1, sourceDuration),
    sourceDuration,
    offset: 0,
    speed: 1,
    curves,
    originalCurves: structuredClone(curves),
  };
  return insertSource(document, group);
}
export function bakeLipSync(buffer: AudioBuffer): number[] {
  const fps = 120,
    count = Math.ceil(buffer.duration * fps),
    channels = Array.from({ length: buffer.numberOfChannels }, (_, i) =>
      buffer.getChannelData(i),
    );
  return Array.from({ length: count }, (_, frame) => {
    const a = Math.floor((frame * buffer.sampleRate) / fps),
      b = Math.min(
        buffer.length,
        Math.floor(((frame + 1) * buffer.sampleRate) / fps),
      );
    let sum = 0;
    for (const c of channels) for (let i = a; i < b; i++) sum += c[i] * c[i];
    return Math.min(
      1,
      Math.sqrt(sum / Math.max(1, (b - a) * channels.length)) * 5,
    );
  });
}
