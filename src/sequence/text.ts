import { evaluateClipTransform } from "./engine";
import type { Clip, ProjectAsset, ProjectDocument } from "./types";

export type ScheduledText = {
  id: string;
  start: number;
  duration: number;
  text: string;
  speakerName?: string;
};

function speakerName(asset?: ProjectAsset): string | undefined {
  if (asset?.metadata?.showSpeaker === false) return undefined;
  const speaker = asset?.metadata?.speaker;
  return typeof speaker === "string" && speaker.trim() ? speaker.trim() : undefined;
}

/** The scene renderer includes the speaker label without modifying the saved body. */
export function renderClipText(clip: Clip, asset?: ProjectAsset): string {
  const text = clip.text ?? asset?.name ?? "";
  const speaker = speakerName(asset);
  return speaker ? `${speaker}\n${text}` : text;
}

/** Flatten visible text into the chosen sequence's clock for subtitle export. */
export function resolveTextSchedule(project: ProjectDocument, sequenceId = project.rootSequenceId): ScheduledText[] {
  const result: ScheduledText[] = [];
  const visibleRanges = (clip: Clip, offset: number, rate: number, start: number, end: number): Array<[number, number]> => {
    const atSource = (source: number) => ((source - clip.sourceIn) / clip.rate + clip.start - offset) / rate;
    const boundaries = [start, end, ...clip.transformKeys.map(key => atSource(key.time)).filter(time => time > start && time < end)].sort((a, b) => a - b);
    const ranges: Array<[number, number]> = [];
    for (let index = 1; index < boundaries.length; index++) {
      const left = boundaries[index - 1], right = boundaries[index];
      if (right <= left) continue;
      const source = clip.sourceIn + (offset + (left + right) / 2 * rate - clip.start) * clip.rate;
      if (evaluateClipTransform(clip, source).opacity <= 0) continue;
      const previous = ranges[ranges.length - 1];
      if (previous && Math.abs(previous[1] - left) < 1e-9) previous[1] = right;
      else ranges.push([left, right]);
    }
    return ranges;
  };
  const walk = (id: string, offset: number, rate: number, windowStart: number, windowEnd: number, path: string[], ancestors: Set<string>) => {
    if (ancestors.has(id)) throw new Error("不能解析循环嵌套序列的文字。");
    const sequence = project.sequences[id];
    if (!sequence) return;
    if (!Number.isFinite(rate) || rate <= 0) throw new Error("文字片段的嵌套播放速率无效。");
    const nextAncestors = new Set(ancestors).add(id);
    for (const track of [...sequence.tracks].sort((a, b) => a.order - b.order)) {
      if (track.hidden) continue;
      for (const clip of track.clips) {
        if (!clip.sequenceId && clip.kind !== "text") continue;
        if (!Number.isFinite(clip.rate) || clip.rate <= 0) throw new Error(`片段“${clip.name}”的播放速率无效。`);
        const start = Math.max(windowStart, (clip.start - offset) / rate);
        const end = Math.min(windowEnd, (clip.start + clip.duration - offset) / rate);
        if (end <= start) continue;
        for (const [visibleStart, visibleEnd] of visibleRanges(clip, offset, rate, start, end)) {
          if (clip.sequenceId) {
            const childOffset = clip.sourceIn + (offset - clip.start) * clip.rate;
            walk(clip.sequenceId, childOffset, rate * clip.rate, visibleStart, visibleEnd, [...path, clip.id], nextAncestors);
          } else {
            const asset = clip.assetId ? project.assets[clip.assetId] : undefined;
            const text = clip.text ?? asset?.name ?? "";
            if (!text.trim()) continue;
            result.push({ id: path.length === 1 ? clip.id : [...path, clip.id].join("/"), start: visibleStart, duration: visibleEnd - visibleStart, text, speakerName: speakerName(asset) });
          }
        }
      }
    }
  };
  walk(sequenceId, 0, 1, 0, Infinity, [sequenceId], new Set());

  // A keyed parent can reveal the same text in several windows. Keep every
  // window and use independent IDs when a hidden interval separates them.
  const grouped = new Map<string, ScheduledText[]>();
  for (const item of result.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))) {
    const entries = grouped.get(item.id) ?? [];
    const previous = entries[entries.length - 1];
    if (previous && Math.abs(previous.start + previous.duration - item.start) < 1e-9) previous.duration = item.start + item.duration - previous.start;
    else entries.push(item);
    grouped.set(item.id, entries);
  }
  return [...grouped.values()].flatMap(entries => entries.map((item, index) => ({ ...item, id: entries.length > 1 ? `${item.id}/visible:${index}` : item.id })))
    .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}
