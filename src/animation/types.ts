export type Interpolation = "linear" | "hold" | "inverse-hold" | "bezier";
export type Point = { time: number; value: number };
export type Keyframe = Point & {
  id: string;
  interpolation: Interpolation;
  inHandle?: Point;
  outHandle?: Point;
  sourceId?: string;
  sourceKeyId?: string;
};
export type ParameterDefinition = {
  target: string;
  characterId: string;
  partId: string;
  parameterId: string;
  name: string;
  group: string;
  kind: "parameter" | "opacity";
  effect?: "blink" | "lip";
  min: number;
  max: number;
  defaultValue: number;
};
export type ParameterTrack = {
  definition: ParameterDefinition;
  baseValue: number;
  animated: boolean;
  keys: Keyframe[];
};
export type SourceGroup = {
  id: string;
  name: string;
  kind: "motion" | "expression";
  sourceAssetId?: string;
  start: number;
  duration: number;
  sourceDuration: number;
  offset: number;
  speed: number;
  curves: Record<string, Keyframe[]>;
  originalCurves?: Record<string, Keyframe[]>;
};
export type AnimationDocument = {
  tracks: ParameterTrack[];
  groups: SourceGroup[];
  seed: number;
};
export const emptyAnimation = (): AnimationDocument => ({
  tracks: [],
  groups: [],
  seed: 1729,
});
export const targetId = (character: string, part: string, parameter: string) =>
  JSON.stringify([character, part, parameter]);
