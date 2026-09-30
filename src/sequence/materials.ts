import type { ProjectAsset } from "./types";

/** A source identifies the dragged file, independently of the destination model. */
export type MaterialSource = {
  id: string;
  name: string;
  kind: "motion" | "expression";
  sourceModel: string;
  parts: Array<{ partId: string; uri: string; text?: string }>;
};

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** Validate external drag payloads and return a copy so callers cannot mutate them. */
export function parseMaterialSource(value: unknown): MaterialSource {
  if (!record(value) || !nonempty(value.id) || !nonempty(value.name) || !nonempty(value.sourceModel)
    || (value.kind !== "motion" && value.kind !== "expression") || !Array.isArray(value.parts) || !value.parts.length) {
    throw new Error("动作或表情素材来源无效。");
  }
  const ids = new Set<string>();
  const parts = value.parts.map((part: unknown) => {
    if (!record(part) || !nonempty(part.partId) || ids.has(part.partId) || typeof part.uri !== "string"
      || (part.text !== undefined && !nonempty(part.text)) || (!nonempty(part.uri) && !nonempty(part.text))) {
      throw new Error("动作或表情素材的部件来源无效。");
    }
    ids.add(part.partId);
    return { partId: part.partId, uri: part.uri, ...(typeof part.text === "string" ? { text: part.text } : {}) };
  });
  return { id: value.id, name: value.name, kind: value.kind, sourceModel: value.sourceModel, parts };
}

/** Saved animation sources keep their original text and need no server port on reopening. */
export function materialSourceToAsset(value: MaterialSource): ProjectAsset {
  const source = parseMaterialSource(value);
  if (source.parts.some((part) => !nonempty(part.text))) throw new Error("保存动作或表情素材前必须读取全部源文件。");
  return {
    id: source.id, kind: source.kind, name: source.name, uri: "",
    metadata: {
      sourceModel: source.sourceModel,
      materialParts: JSON.stringify(source.parts.map((part) => ({ partId: part.partId, uri: "", text: part.text }))),
    },
  };
}

export function materialSourceFromAsset(asset: ProjectAsset): MaterialSource | null {
  if (asset.kind !== "motion" && asset.kind !== "expression") return null;
  let parts: unknown;
  try {
    if (typeof asset.metadata?.materialParts !== "string") throw new Error("missing parts");
    parts = JSON.parse(asset.metadata.materialParts);
  } catch { throw new Error(`素材“${asset.name}”的源文件数据无效。`); }
  return parseMaterialSource({ id: asset.id, name: asset.name, kind: asset.kind, sourceModel: asset.metadata?.sourceModel, parts });
}
