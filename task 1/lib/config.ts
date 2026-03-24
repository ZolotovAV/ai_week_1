import { parseAllowedModels } from "@/lib/models";

export type ServerConfig = {
  openRouterApiKey: string;
  serviceApiKey: string;
  defaultModel: string;
  allowedModels: string[];
  httpReferer?: string;
  appTitle?: string;
};

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
    httpReferer: process.env.OPENROUTER_HTTP_REFERER?.trim(),
    appTitle: process.env.OPENROUTER_X_TITLE?.trim()
  };
}
