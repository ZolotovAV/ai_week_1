import { parseAllowedModels } from "@/lib/models";

export type ServerConfig = {
  openRouterApiKey: string;
  serviceApiKey: string;
  defaultModel: string;
  allowedModels: string[];
  modelContextWindows: Record<string, number>;
  httpReferer?: string;
  appTitle?: string;
};

function parseModelContextWindows(rawContextWindows?: string) {
  if (!rawContextWindows?.trim()) {
    return {};
  }

  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(rawContextWindows);
  } catch {
    throw new Error("OPENROUTER_MODEL_CONTEXT_WINDOWS must be a valid JSON object.");
  }

  if (!parsedValue || typeof parsedValue !== "object" || Array.isArray(parsedValue)) {
    throw new Error("OPENROUTER_MODEL_CONTEXT_WINDOWS must be a JSON object.");
  }

  const normalizedEntries = Object.entries(parsedValue).flatMap(([model, value]) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new Error(
        `OPENROUTER_MODEL_CONTEXT_WINDOWS contains an invalid value for "${model}".`
      );
    }

    return [[model.trim(), Math.round(value)] as const];
  });

  return Object.fromEntries(normalizedEntries);
}

export function getServerConfig(): ServerConfig {
  const openRouterApiKey = process.env.OPENROUTER_API_KEY?.trim();
  const serviceApiKey = process.env.SERVICE_API_KEY?.trim();

  if (!openRouterApiKey) {
    throw new Error("Server is missing OPENROUTER_API_KEY.");
  }

  if (!serviceApiKey) {
    throw new Error("Server is missing SERVICE_API_KEY.");
  }

  const defaultModel =
    process.env.OPENROUTER_MODEL?.trim() || "nvidia/nemotron-3-super-120b-a12b:free";

  return {
    openRouterApiKey,
    serviceApiKey,
    defaultModel,
    allowedModels: parseAllowedModels(defaultModel, process.env.OPENROUTER_ALLOWED_MODELS),
    modelContextWindows: parseModelContextWindows(process.env.OPENROUTER_MODEL_CONTEXT_WINDOWS),
    httpReferer: process.env.OPENROUTER_HTTP_REFERER?.trim(),
    appTitle: process.env.OPENROUTER_X_TITLE?.trim()
  };
}
