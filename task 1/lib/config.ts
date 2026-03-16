type ServerConfig = {
  openRouterApiKey: string;
  serviceApiKey: string;
  model: string;
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

  return {
    openRouterApiKey,
    serviceApiKey,
    model: process.env.OPENROUTER_MODEL?.trim() || "nvidia/nemotron-3-super-120b-a12b:free",
    httpReferer: process.env.OPENROUTER_HTTP_REFERER?.trim(),
    appTitle: process.env.OPENROUTER_X_TITLE?.trim()
  };
}
