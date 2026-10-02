import type { AudioTrack } from "./videoExporter";
export function sliceExportAudio(tracks: AudioTrack[], start: number, end: number): AudioTrack[] {
    return tracks.flatMap(track => { const from = Math.max(start, track.start), to = Math.min(end, track.start + track.duration); if (to <= from)
        return []; const offset = from - track.start; return [{ ...track, start: from - start, duration: to - from, sourceIn: (track.sourceIn ?? 0) + offset * (track.playbackRate ?? 1), gainEnvelopes: track.gainEnvelopes?.map(envelope => ({ ...envelope, keys: envelope.keys.map(key => ({ ...key, time: key.time - offset })), fadeInStart: envelope.fadeInStart - offset, fadeOutStart: envelope.fadeOutStart - offset })) }]; });
}
export function estimateFrameStorage(width: number, height: number, frames: number): number { return Math.ceil(width * height * 4 * frames); }
