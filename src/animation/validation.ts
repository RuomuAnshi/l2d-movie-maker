import type { AnimationDocument } from "./types";
export function isAnimationDocument(
  value: unknown,
): value is AnimationDocument {
  if (!value || typeof value !== "object") return false;
  const doc = value as AnimationDocument;
  if (
    !Number.isInteger(doc.seed) ||
    !Array.isArray(doc.tracks) ||
    !Array.isArray(doc.groups)
  )
    return false;
  const point = (p: { time: number; value: number }) =>
    p && Number.isFinite(p.time) && Number.isFinite(p.value);
  const keys = (v: unknown) =>
    Array.isArray(v) &&
    v.every(
      (k, i) =>
        k &&
        typeof k.id === "string" &&
        point(k) &&
        k.time >= 0 &&
        (!i || v[i - 1].time <= k.time) &&
        ["linear", "hold", "inverse-hold", "bezier"].includes(
          k.interpolation,
        ) &&
        (!k.inHandle || point(k.inHandle)) &&
        (!k.outHandle || point(k.outHandle)),
    );
  const targets = new Set<string>();
  for (const t of doc.tracks) {
    const d = t?.definition;
    if (
      !d ||
      typeof d.target !== "string" ||
      targets.has(d.target) ||
      ![d.characterId, d.partId, d.parameterId, d.name, d.group].every(
        (v) => typeof v === "string",
      ) ||
      !["parameter", "opacity"].includes(d.kind) ||
      ![d.min, d.max, d.defaultValue, t.baseValue].every(Number.isFinite) ||
      d.min > d.max ||
      typeof t.animated !== "boolean" ||
      !keys(t.keys)
    )
      return false;
    targets.add(d.target);
  }
  return doc.groups.every(
    (g) =>
      g &&
      typeof g.id === "string" &&
      typeof g.name === "string" &&
      ["motion", "expression"].includes(g.kind) &&
      [g.start, g.duration, g.sourceDuration, g.offset, g.speed].every(
        Number.isFinite,
      ) &&
      g.start >= 0 &&
      g.duration > 0 &&
      g.sourceDuration >= 0 &&
      g.offset >= 0 &&
      g.speed > 0 &&
      g.curves &&
      Object.values(g.curves).every(keys) &&
      (!g.originalCurves || Object.values(g.originalCurves).every(keys)),
  );
}
