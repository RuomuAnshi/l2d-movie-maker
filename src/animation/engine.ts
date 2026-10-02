import type {
  AnimationDocument,
  Keyframe,
  ParameterTrack,
  Point,
  SourceGroup,
} from "./types";
const cubic = (a: number, b: number, c: number, d: number, u: number) =>
  (1 - u) ** 3 * a +
  3 * (1 - u) ** 2 * u * b +
  3 * (1 - u) * u * u * c +
  u ** 3 * d;
export function curveValue(
  keys: Keyframe[],
  base: number,
  time: number,
): number {
  if (!keys.length || time < keys[0].time) return base;
  let lo = 0,
    hi = keys.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (keys[mid].time <= time) lo = mid;
    else hi = mid - 1;
  }
  const a = keys[lo],
    b = keys[lo + 1];
  if (!b || time === a.time) return a.value;
  if (a.interpolation === "hold") return a.value;
  if (a.interpolation === "inverse-hold") return b.value;
  if (a.interpolation !== "bezier")
    return (
      a.value + ((b.value - a.value) * (time - a.time)) / (b.time - a.time)
    );
  const c = a.outHandle ?? {
    time: a.time + (b.time - a.time) / 3,
    value: a.value,
  };
  const d = b.inHandle ?? {
    time: b.time - (b.time - a.time) / 3,
    value: b.value,
  };
  let left = 0,
    right = 1;
  for (let i = 0; i < 48; i++) {
    const u = (left + right) / 2;
    if (cubic(a.time, c.time, d.time, b.time, u) < time) left = u;
    else right = u;
  }
  return cubic(a.value, c.value, d.value, b.value, (left + right) / 2);
}
export function evaluateTrack(track: ParameterTrack, time: number) {
  const v = track.animated
    ? curveValue(track.keys, track.baseValue, time)
    : track.baseValue;
  return Math.max(track.definition.min, Math.min(track.definition.max, v));
}
export function evaluateAt(
  document: AnimationDocument,
  time: number,
): Record<string, number> {
  return Object.fromEntries(
    document.tracks.map((track) => [
      track.definition.target,
      evaluateTrack(track, time),
    ]),
  );
}
export function sortKeys(keys: Keyframe[]) {
  const unique = new Map<number, Keyframe>();
  for (const key of keys) unique.set(key.time, key);
  return [...unique.values()].sort((a, b) => a.time - b.time);
}
export function upsertKey(
  track: ParameterTrack,
  time: number,
  value: number,
): ParameterTrack {
  const existing = track.keys.find((k) => Math.abs(k.time - time) < 1e-7);
  return {
    ...track,
    animated: true,
    keys: sortKeys([
      ...track.keys.filter((k) => k !== existing),
      {
        id: existing?.id ?? crypto.randomUUID(),
        time: Math.max(0, time),
        value,
        interpolation: existing?.interpolation ?? "linear",
        sourceId: existing?.sourceId,
        sourceKeyId: existing?.sourceKeyId,
        inHandle: existing?.inHandle,
        outHandle: existing?.outHandle,
      },
    ]),
  };
}
// Split Bezier handles before replacing an interval so the untouched curve stays exact.
export function splitAt(keys: Keyframe[], time: number, base: number): Keyframe[] {
  if (keys.some((k) => Math.abs(k.time - time) < 1e-9))
    return keys.map((k) =>
      Math.abs(k.time - time) < 1e-9 ? { ...k, time } : k,
    );
  const nextIndex = keys.findIndex((k) => k.time > time);
  const index = nextIndex === -1 ? keys.length - 1 : nextIndex - 1;
  const value = curveValue(keys, base, time);
  const point: Keyframe = {
    id: crypto.randomUUID(),
    time,
    value,
    interpolation: "hold",
    generated: true,
  };
  if (index < 0) return sortKeys([...keys, point]);
  const a = { ...keys[index] },
    b = { ...keys[index + 1] };
  if (!b.id) return sortKeys([...keys.slice(0, index), { ...a, interpolation: "hold", outHandle: undefined }, point]);
  point.interpolation = a.interpolation;
  if (a.interpolation === "bezier") {
    const c = a.outHandle ?? {
      time: a.time + (b.time - a.time) / 3,
      value: a.value,
    };
    const d = b.inHandle ?? {
      time: b.time - (b.time - a.time) / 3,
      value: b.value,
    };
    let l = 0,
      r = 1;
    for (let i = 0; i < 48; i++) {
      const u = (l + r) / 2;
      if (cubic(a.time, c.time, d.time, b.time, u) < time) l = u;
      else r = u;
    }
    const u = (l + r) / 2;
    const mix = (p: Point, q: Point): Point => ({
      time: p.time + (q.time - p.time) * u,
      value: p.value + (q.value - p.value) * u,
    });
    const ac = mix(a, c),
      cd = mix(c, d),
      db = mix(d, b),
      e = mix(ac, cd),
      f = mix(cd, db);
    a.outHandle = ac;
    point.inHandle = e;
    point.outHandle = f;
    b.inHandle = db;
  }
  return sortKeys([
    ...keys.slice(0, index),
    a,
    point,
    b,
    ...keys.slice(index + 2),
  ]);
}
function overlaySource(
  document: AnimationDocument,
  group: SourceGroup,
): AnimationDocument {
  const end = group.start + group.duration;
  return {
    ...document,
    tracks: document.tracks.map((track) => {
      const source = group.curves[track.definition.target];
      if (!source?.length) return track;
      const mapPoint = (p: Point): Point => ({
        time: group.start + (p.time - group.offset) / group.speed,
        value: p.value,
      });
      let mapped: Keyframe[] = source.map((k) => ({
        ...k,
        ...mapPoint(k),
        id: `${group.id}:${k.id}`,
        sourceId: group.id,
        sourceKeyId: k.id,
        inHandle: k.inHandle && mapPoint(k.inHandle),
        outHandle: k.outHandle && mapPoint(k.outHandle),
      }));
      mapped = splitAt(
        splitAt(
          mapped,
          group.start,
          curveValue(source, track.baseValue, group.offset),
        ),
        end,
        track.baseValue,
      )
        .filter((k) => k.time >= group.start && k.time <= end)
        .map((k) => ({ ...k, sourceId: group.id,
          id: k.generated ? `${group.id}:boundary:${track.definition.target}:${k.time}` : k.id,
        }));
      const old = splitAt(
        splitAt(track.keys, group.start, track.baseValue),
        end,
        track.baseValue,
      );
      // Interval end is inclusive. Resume the prior curve immediately after it.
      const leftBoundary = old.find((k) => k.time === group.start);
      const left = old.filter((k) => k.time < group.start);
      if (group.start > 0 && leftBoundary)
        left.push({
          ...leftBoundary,
          id: `${group.id}:before:${track.definition.target}`,
          sourceId: group.id, sourceKeyId: undefined, generated: true,
          time: Math.max(0, group.start - 1e-7),
        });
      const resume = old.find((k) => k.time === end);
      const tail = old.filter((k) => k.time > end);
      if (tail.length && resume)
        tail.unshift({ ...resume, id: `${group.id}:after:${track.definition.target}`, sourceId: group.id, sourceKeyId: undefined, generated: true, time: end + 1e-7 });
      return {
        ...track,
        animated: true,
        keys: sortKeys([...left, ...mapped, ...tail]),
      };
    }),
  };
}
/** Material order is insertion priority. Rebuild only when layers change;
 * preview and export continue to evaluate the resulting parameter tracks. */
export function rebuildSources(document: AnimationDocument): AnimationDocument {
  const groupIds = new Set(document.groups.map(g => g.id));
  const targets = new Set(document.groups.flatMap(g => Object.keys(g.curves)));
  const base: AnimationDocument = { ...document, tracks: document.tracks.map(track => {
    const sourceBase = track.sourceBase ?? (targets.has(track.definition.target) ? {
      keys: track.keys.filter(k => !k.sourceId || !groupIds.has(k.sourceId)),
      animated: track.animated,
    } : undefined);
    return sourceBase ? { ...track, sourceBase, keys: sourceBase.keys, animated: sourceBase.animated } : track;
  }) };
  let next = base;
  for (const group of document.groups) {
    if (group.enabled === false) continue;
    const filtered = group.targetMask ? { ...group, curves: Object.fromEntries(Object.entries(group.curves).filter(([target]) => group.targetMask!.includes(target))) } : group;
    next = overlaySource(next, filtered);
  }
  return next;
}
export function insertSource(document: AnimationDocument, group: SourceGroup): AnimationDocument {
  const index = document.groups.findIndex(g => g.id === group.id);
  const groups = document.groups.slice();
  if (index < 0) groups.push(group); else groups[index] = group;
  return rebuildSources({ ...document, groups });
}
export function editSource(
  document: AnimationDocument,
  id: string,
  patch: Partial<Pick<SourceGroup, "start" | "duration" | "offset" | "speed" | "enabled" | "targetMask">>,
) {
  if (!document.groups.some(g => g.id === id)) return document;
  return rebuildSources({ ...document, groups: document.groups.map(g => g.id === id ? { ...g, ...patch } : g) });
}
export function removeSource(document: AnimationDocument, id: string) {
  // Seed underlying tracks before removing a legacy group which has no sourceBase yet.
  const prepared = rebuildSources(document);
  return rebuildSources({ ...prepared, groups: prepared.groups.filter(g => g.id !== id) });
}
export function moveSourcePriority(document: AnimationDocument, id: string, delta: number): AnimationDocument {
  const groups = document.groups.slice();
  const index = groups.findIndex(group => group.id === id);
  if (index < 0) return document;
  const to = Math.max(0, Math.min(groups.length - 1, index + delta));
  groups.splice(to, 0, groups.splice(index, 1)[0]);
  return rebuildSources({ ...document, groups });
}
export class CommandHistory<T> {
  private past: T[] = [];
  private future: T[] = [];
  commit(before: T) {
    this.past.push(structuredClone(before));
    if (this.past.length > 100) this.past.shift();
    this.future = [];
  }
  undo(current: T) {
    const previous = this.past.pop();
    if (!previous) return current;
    this.future.push(structuredClone(current));
    return previous;
  }
  redo(current: T) {
    const next = this.future.pop();
    if (!next) return current;
    this.past.push(structuredClone(current));
    return next;
  }
}

export function animationEnd(document: AnimationDocument): number {
  const groups = document.groups.reduce(
    (end, g) => Math.max(end, g.start + g.duration),
    0,
  );
  return document.tracks.reduce(
    (end, t) => t.keys.reduce((end, k) => Math.max(end, k.time), end),
    groups,
  );
}

/** A material imported into several composite parts remains one editable group. */
export function combineSourceGroups(
  document: AnimationDocument,
  ids: string[],
): AnimationDocument {
  const groups = document.groups.filter((g) => ids.includes(g.id));
  if (groups.length < 2) return document;
  const merged = {
    ...groups[0],
    duration: Math.max(...groups.map((g) => g.duration)),
    sourceDuration: Math.max(...groups.map((g) => g.sourceDuration)),
    curves: Object.assign({}, ...groups.map((g) => g.curves)),
    originalCurves: Object.assign(
      {},
      ...groups.map((g) => g.originalCurves ?? g.curves),
    ),
  };
  return {
    ...document,
    groups: [...document.groups.filter((g) => !ids.includes(g.id)), merged],
    tracks: document.tracks.map((t) => ({
      ...t,
      keys: t.keys.map((k) =>
        k.sourceId && ids.includes(k.sourceId)
          ? { ...k, sourceId: merged.id }
          : k,
      ),
    })),
  };
}

/** Write user changes back into working material curves; immutable originals remain available. */
export function reconcileSourceEdits(
  before: AnimationDocument,
  next: AnimationDocument,
): AnimationDocument {
  if (before.groups !== next.groups) return next;
  const replacements = new Map<string, Keyframe>();
  const groups = next.groups.map((group) => {
    let changed = false;
    const curves = { ...group.curves };
    for (const track of next.tracks) {
      const previous = before.tracks.find(
        (t) => t.definition.target === track.definition.target,
      );
      if (!previous || !curves[track.definition.target]) continue;
      let keys = curves[track.definition.target];
      const newFrames = track.keys.filter(k => !k.sourceId && !previous.keys.some(old => old.id === k.id) &&
        next.groups.slice().reverse().find(g => g.enabled!==false && (!g.targetMask||g.targetMask.includes(track.definition.target)) && g.curves[track.definition.target]?.length && k.time >= g.start && k.time <= g.start + g.duration)?.id === group.id);
      const frames = previous.keys.filter(k => k.sourceId === group.id && (!k.generated || (k.time >= group.start && k.time <= group.start + group.duration)));
      for (const old of [...frames, ...newFrames]) {
        let current = track.keys.find((k) => k.id === old.id);
        if (newFrames.includes(old)) current = { ...old, sourceId: group.id };
        if (JSON.stringify(old) === JSON.stringify(current)) continue;
        changed = true;
        if (old.sourceKeyId)
          keys = keys.filter((k) => k.id !== old.sourceKeyId);
        if (!current || current.sourceId !== group.id) continue;
        // Moving a frame out of its material interval makes it an independent manual frame.
        if (
          current.time < group.start ||
          current.time > group.start + group.duration
        ) {
          replacements.set(current.id, {
            ...current,
            sourceId: undefined,
            sourceKeyId: undefined,
            generated: false,
          });
          continue;
        }
        const id = current.sourceKeyId ?? crypto.randomUUID();
        const local = (p: Point): Point => ({
          time: group.offset + (p.time - group.start) * group.speed,
          value: p.value,
        });
        keys = sortKeys([
          ...keys,
          {
            ...current,
            ...local(current),
            id,
            sourceId: undefined,
            sourceKeyId: undefined,
            generated: false,
            inHandle: current.inHandle && local(current.inHandle),
            outHandle: current.outHandle && local(current.outHandle),
          },
        ]);
        replacements.set(current.id, { ...current, generated: false, sourceKeyId: id });
      }
      curves[track.definition.target] = keys;
    }
    return changed ? { ...group, curves } : group;
  });
  return {
    ...next,
    groups,
    tracks: next.tracks.map((t) => ({
      ...t,
      keys: t.keys.map((k) => replacements.get(k.id) ?? k),
      sourceBase: t.sourceBase && {
        ...t.sourceBase,
        animated: t.animated,
        keys: sortKeys([
          ...t.sourceBase.keys.filter(k => {
            const old = before.tracks.find(v => v.definition.target === t.definition.target)?.keys.find(v => v.id === k.id && !v.sourceId);
            return !old || t.keys.some(v => v.id === k.id && !v.sourceId);
          }),
          ...t.keys.map(k => replacements.get(k.id) ?? k).filter(k => !k.sourceId && !k.generated),
        ]),
      },
    })),
  };
}
