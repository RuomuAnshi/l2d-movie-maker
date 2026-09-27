// src/utils/modelData.ts
// Cubism 2 的 model.json 顶层是 motions/expressions；
// Cubism 3/4/5 的 model3.json 则嵌套在 FileReferences.Motions / FileReferences.Expressions，
// 且字段名为 File / Name。这里统一成 UI 使用的结构。

export type ModelMotion = { name: string; file: string };
export type ModelExpression = { name: string; file: string };
export type ModelData = {
  motions: Record<string, ModelMotion[]>;
  expressions: ModelExpression[];
};

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function normalizeMotionList(group: string, value: unknown): ModelMotion[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) => {
      const record = asRecord(item);
      if (!record) return { name: `${group}-${index}`, file: "" };
      return {
        name: readString(record.name) ?? readString(record.Name) ?? `${group}-${index}`,
        file: readString(record.file) ?? readString(record.File) ?? "",
      };
    })
    .filter((motion) => motion.file.length > 0);
}

function collectMotions(source: UnknownRecord | null): Record<string, ModelMotion[]> {
  if (!source) return {};
  const motions: Record<string, ModelMotion[]> = {};
  for (const [group, list] of Object.entries(source)) {
    const normalized = normalizeMotionList(group, list);
    if (normalized.length > 0) {
      motions[group] = normalized;
    }
  }
  return motions;
}

function collectExpressions(value: unknown): ModelExpression[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) => {
      const record = asRecord(item);
      if (!record) return { name: `expression-${index}`, file: "" };
      return {
        name: readString(record.name) ?? readString(record.Name) ?? `expression-${index}`,
        file: readString(record.file) ?? readString(record.File) ?? "",
      };
    })
    .filter((expression) => expression.file.length > 0);
}

/** 把任意 Live2D 设置 JSON（model.json / model3.json）归一化为 UI 结构。 */
export function normalizeModelData(raw: unknown): ModelData {
  const root = asRecord(raw) ?? {};
  const fileReferences = asRecord(root.FileReferences);

  const topLevelMotions = collectMotions(asRecord(root.motions));
  const fileReferenceMotions = collectMotions(asRecord(fileReferences?.Motions));

  const topLevelExpressions = collectExpressions(root.expressions);
  const fileReferenceExpressions = collectExpressions(fileReferences?.Expressions);

  return {
    motions: Object.keys(topLevelMotions).length > 0 ? topLevelMotions : fileReferenceMotions,
    expressions: topLevelExpressions.length > 0 ? topLevelExpressions : fileReferenceExpressions,
  };
}

type RuntimeMotionManager = {
  definitions?: Record<string, unknown>;
  expressionManager?: { definitions?: unknown };
};

/** 兜底：从已加载模型的 internalModel 读取库解析出的动作/表情定义（对 model3.json 同样有效）。 */
export function readModelDataFromRuntime(model: unknown): ModelData | null {
  const internalModel = asRecord(model)?.internalModel;
  const motionManager = asRecord(internalModel)?.motionManager as RuntimeMotionManager | null;
  if (!motionManager) return null;

  const motions = collectMotions(asRecord(motionManager.definitions));
  const expressions = collectExpressions(motionManager.expressionManager?.definitions);

  if (Object.keys(motions).length === 0 && expressions.length === 0) return null;
  return { motions, expressions };
}

/** 优先使用 primary，缺动作或表情时用 fallback 补全。 */
export function withFallbackModelData(primary: ModelData, fallback: ModelData | null): ModelData {
  if (!fallback) return primary;
  return {
    motions: Object.keys(primary.motions).length > 0 ? primary.motions : fallback.motions,
    expressions: primary.expressions.length > 0 ? primary.expressions : fallback.expressions,
  };
}
