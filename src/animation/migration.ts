import type { Clip } from "../components/timeline/clipTypes";
import type { AnimationDocument, ParameterTrack } from "./types";
import { combineSourceGroups } from "./engine";
import { importMaterial } from "./importers";
export type ResolvedMaterial = { text: string; targets: string[] };
export async function migrateLegacyClips(
  document: AnimationDocument,
  motions: Clip[],
  expressions: Clip[],
  resolve: (
    name: string,
    kind: "motion" | "expression",
  ) => Promise<ResolvedMaterial[]>,
): Promise<AnimationDocument> {
  let result = document;
  const clips = [
    ...motions.map((clip) => ({ clip, kind: "motion" as const })),
    ...expressions.map((clip) => ({ clip, kind: "expression" as const })),
  ].sort((a, b) => a.clip.start - b.clip.start);
  for (const { clip, kind } of clips) {
    const materials = await resolve(clip.name, kind);
    if (!materials.length)
      throw new Error(`缺失素材：${clip.name}。请重新选择对应模型后重试导入。`);
    const previousIds = new Set(result.groups.map((g) => g.id));
    for (const material of materials) {
      const tracks: ParameterTrack[] = result.tracks.filter((t) =>
        material.targets.includes(t.definition.target),
      );
      result = importMaterial(
        result,
        tracks,
        material.text,
        kind,
        clip.name,
        clip.start,
        clip.duration,
      );
    }
    result = combineSourceGroups(
      result,
      result.groups.filter((g) => !previousIds.has(g.id)).map((g) => g.id),
    );
  }
  return result;
}
