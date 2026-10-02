import { curveValue } from "../animation/engine";
import type { Clip, PropertyCurve, PropertyName, Transform } from "./types";
export const transformProperties: Array<keyof Transform> = ["x", "y", "scaleX", "scaleY", "rotation", "opacity"];
export const propertyLabels: Record<PropertyName, string> = { x: "X", y: "Y", scaleX: "横向缩放", scaleY: "纵向缩放", rotation: "旋转", opacity: "透明度", volume: "音量" };
export function propertyValue(clip: Clip, name: PropertyName, time: number, legacy: number): number {
    const curve = clip.propertyCurves?.[name];
    if (!curve)
        return legacy;
    const base = name === "volume" ? clip.volume : clip.transform[name];
    const value = curve.enabled ? curveValue(curve.keys, base, time) : base;
    return name === "opacity" ? Math.max(0, Math.min(1, value)) : name === "volume" ? Math.max(0, value) : value;
}
export const gainToDb = (gain: number) => gain <= 0 ? -60 : Math.max(-60, 20 * Math.log10(gain));
export const dbToGain = (db: number) => db <= -60 ? 0 : 10 ** (db / 20);
/** Expand only enabled property audio curves; both mixers consume the same sampled envelope. */
export function volumeCurveSamples(clip: Clip): Array<{
    time: number;
    value: number;
}> {
    const curve = clip.propertyCurves?.volume;
    if (!curve)
        return clip.volumeKeys;
    if (!curve.enabled)
        return [];
    const from = clip.sourceIn, to = from + clip.duration * clip.rate;
    const times = new Set([from, to, ...curve.keys.filter(key => key.time >= from && key.time <= to).map(key => key.time)]);
    for (const key of curve.keys)
        if (["hold", "inverse-hold"].includes(key.interpolation) && key.time >= from && key.time <= to) {
            times.add(Math.min(to, key.time + 1e-7));
            const next = curve.keys[curve.keys.indexOf(key) + 1];
            if (next && next.time <= to)
                times.add(Math.max(from, next.time - 1e-7));
        }
    const valueAt = (time: number) => propertyValue(clip, "volume", time, clip.volume);
    const subdivide = (a: number, b: number, depth = 0) => { if (depth > 14 || times.size >= 2048 || b - a < 1e-6)
        return; const va = valueAt(a), vb = valueAt(b); if ([0.25, 0.5, 0.75].some(u => Math.abs(valueAt(a + (b - a) * u) - (va + (vb - va) * u)) > 0.0005)) {
        const mid = (a + b) / 2;
        times.add(mid);
        subdivide(a, mid, depth + 1);
        subdivide(mid, b, depth + 1);
    } };
    const boundaries = [...times].sort((a, b) => a - b);
    for (let i = 1; i < boundaries.length; i++)
        subdivide(boundaries[i - 1], boundaries[i]);
    return [...times].sort((a, b) => a - b).map(time => ({ time, value: propertyValue(clip, "volume", time, clip.volume) }));
}
export function editPropertiesAt(clip: Clip, time: number, patch: Partial<Transform> & {
    volume?: number;
}): Partial<Clip> {
    const transform = { ...clip.transform }, curves = structuredClone(clip.propertyCurves ?? {});
    let volume = clip.volume;
    for (const [name, number] of Object.entries(patch) as Array<[
        PropertyName,
        number
    ]>) {
        const existing = curves[name];
        const legacy = name === "volume" ? clip.volumeKeys.map(key => ({ ...key, interpolation: "linear" as const })) : clip.transformKeys.map(key => ({ id: crypto.randomUUID(), time: key.time, value: key[name], interpolation: "linear" as const }));
        const curve: PropertyCurve | undefined = existing ?? (legacy.length ? { enabled: true, keys: legacy } : undefined);
        if (curve?.enabled) {
            const at = curve.keys.find(key => Math.abs(key.time - time) < 1e-6);
            const delta=at?number-at.value:0,dt=at?time-at.time:0;
            curves[name] = { ...curve, keys: [...curve.keys.filter(key => key.id !== at?.id), { ...at, id: at?.id ?? crypto.randomUUID(), time, value: number, interpolation: at?.interpolation ?? "linear",inHandle:at?.inHandle&&{time:at.inHandle.time+dt,value:at.inHandle.value+delta},outHandle:at?.outHandle&&{time:at.outHandle.time+dt,value:at.outHandle.value+delta} }].sort((a, b) => a.time - b.time) };
        }
        else if (name === "volume")
            volume = number;
        else
            transform[name] = number;
    }
    return { transform, volume, propertyCurves: curves };
}
