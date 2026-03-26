export const DEFAULT_CONTEXT_WINDOW = 8192;

export function resolveModelContextWindow(
  model: string,
  modelContextWindows: Record<string, number>
) {
  return modelContextWindows[model] ?? DEFAULT_CONTEXT_WINDOW;
}

export function resolveMaxConfiguredTokens(
  allowedModels: string[],
  modelContextWindows: Record<string, number>
) {
  return allowedModels.reduce(
    (maxTokens, model) =>
      Math.max(maxTokens, resolveModelContextWindow(model, modelContextWindows)),
    DEFAULT_CONTEXT_WINDOW
  );
}
