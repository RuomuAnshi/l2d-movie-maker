import { useRef, useState } from "react";
import { CommandHistory, reconcileSourceEdits } from "./engine";
import { emptyAnimation, type AnimationDocument } from "./types";
import type { Clip, SubtitleClip } from "../components/timeline/clipTypes";
type EditState = {
  animation: AnimationDocument;
  audio: Clip[];
  subtitles: SubtitleClip[];
};
export function useTimelineDocument(
  audio: Clip[],
  subtitles: SubtitleClip[],
  setAudio: (clips: Clip[]) => void,
  setSubtitles: (clips: SubtitleClip[]) => void,
) {
  const [animation, setAnimation] = useState<AnimationDocument>(emptyAnimation);
  const animationRef = useRef(animation),
    history = useRef(new CommandHistory<EditState>()),
    gesture = useRef<EditState | null>(null);
  const gestureSource = useRef<EditState | null>(null);
  const latest = useRef<EditState>({ animation, audio, subtitles });
  latest.current = { animation, audio, subtitles };
  const beginEdit = () => {
    if (!gesture.current) {
      gesture.current = structuredClone(latest.current);
      gestureSource.current = latest.current;
    }
  };
  const endEdit = (force = false) => {
    const source = gestureSource.current,
      current = latest.current;
    if (
      gesture.current &&
      (force ||
        !source ||
        source.animation !== current.animation ||
        source.audio !== current.audio ||
        source.subtitles !== current.subtitles)
    )
      history.current.commit(gesture.current);
    gesture.current = null;
    gestureSource.current = null;
  };
  const changeAnimation = (value: AnimationDocument) => {
    const next = reconcileSourceEdits(animationRef.current, value);
    animationRef.current = next;
    latest.current = { ...latest.current, animation: next };
    setAnimation(next);
  };
  const restore = (state: EditState) => {
    changeAnimation(state.animation);
    setAudio(state.audio);
    setSubtitles(state.subtitles);
  };
  const undo = () => restore(history.current.undo(latest.current));
  const redo = () => restore(history.current.redo(latest.current));
  const resetHistory = () => {
    history.current = new CommandHistory<EditState>();
    gesture.current = null;
    gestureSource.current = null;
  };
  return {
    animation,
    animationRef,
    changeAnimation,
    beginEdit,
    endEdit,
    undo,
    redo,
    resetHistory,
  };
}
