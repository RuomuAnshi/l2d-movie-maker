import type { Sequence } from "./types";

/** Non-drop-frame timecode. Frame arithmetic still uses the sequence's actual fps. */
export function formatTimecode(time: number, fps: number): string {
  const nominal = Math.max(1, Math.round(fps)), frame = Math.max(0, Math.round(time * fps));
  const seconds = Math.floor(frame / nominal);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60, frame % nominal].map((value) => String(value).padStart(2, "0")).join(":");
}

export function parseTimecode(value: string, fps: number): number {
  const input = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(input) && Number.isFinite(Number(input))) return Number(input);
  const match = /^(\d+):(\d{2}):(\d{2}):(\d{2,3})$/.exec(input);
  if (!match) throw new Error("请输入 时:分:秒:帧，或秒数。");
  const [hours, minutes, seconds, frames] = match.slice(1).map(Number), nominal = Math.max(1, Math.round(fps));
  if (!Number.isSafeInteger(hours) || minutes >= 60 || seconds >= 60 || frames >= nominal) throw new Error("时间码超出有效范围。");
  return ((hours * 3600 + minutes * 60 + seconds) * nominal + frames) / fps;
}

export function adjacentEditTime(sequence: Sequence, time: number, direction: -1 | 1): number {
  const cuts = [...new Set([0, ...sequence.tracks.flatMap((track) => track.clips.flatMap((clip) => [clip.start, clip.start + clip.duration]))])].sort((a, b) => a - b);
  return direction > 0 ? cuts.find((cut) => cut > time + 1e-7) ?? cuts[cuts.length - 1] : cuts.slice().reverse().find((cut) => cut < time - 1e-7) ?? 0;
}
