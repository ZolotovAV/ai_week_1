import { resolveModelContextWindow } from "@/lib/model-context";

export type ModelOption = {
  id: string;
  label: string;
  isDefault: boolean;
  maxTokensLimit: number;
};

export class ModelSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelSelectionError";
  }
}

export function parseAllowedModels(defaultModel: string, rawAllowedModels?: string) {
  const seen = new Set<string>();
  const allowedModels = [defaultModel, ...(rawAllowedModels?.split(",") ?? [])]
    .map((model) => model.trim())
    .filter((model) => {
      if (!model || seen.has(model)) {
        return false;
      }

      seen.add(model);
      return true;
    });

  return allowedModels;
}

export function buildModelCatalog(
  defaultModel: string,
  allowedModels: string[],
  modelContextWindows: Record<string, number>
): ModelOption[] {
  return allowedModels.map((modelId) => ({
    id: modelId,
    label: modelId,
    isDefault: modelId === defaultModel,
    maxTokensLimit: resolveModelContextWindow(modelId, modelContextWindows)
  }));
}

export function resolveRequestedModel(
  requestedModel: string | undefined,
  allowedModels: string[],
  defaultModel: string
) {
  const normalizedRequestedModel = requestedModel?.trim();
  if (!normalizedRequestedModel) {
    return defaultModel;
  }

  if (!allowedModels.includes(normalizedRequestedModel)) {
    throw new ModelSelectionError(
      `Model "${normalizedRequestedModel}" is not allowed. Choose one of the configured OpenRouter models.`
    );
  }

  return normalizedRequestedModel;
}
