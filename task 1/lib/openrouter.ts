import type { ServerConfig } from "@/lib/config";

type OpenRouterErrorPayload = {
  error?: {
    message?: string;
    code?: number | string;
    metadata?: unknown;
  };
};

type ParsedOpenRouterError = {
  details?: Record<string, unknown>;
  message: string;
};

export class UpstreamError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
    this.details = details;
  }
}

export async function requestOpenRouter(config: ServerConfig, body: Record<string, unknown>) {
  let response: Response;

  try {
    response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openRouterApiKey}`,
        "Content-Type": "application/json",
        ...(config.httpReferer ? { "HTTP-Referer": config.httpReferer } : {}),
        ...(config.appTitle ? { "X-Title": config.appTitle } : {})
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000)
    });
  } catch (error) {
    throw mapUnexpectedUpstreamError(error);
  }

  if (!response.ok) {
    const { details, message } = await parseOpenRouterError(response);
    const mappedStatus =
      response.status === 429 ? 429 : response.status >= 500 ? 502 : response.status;
    throw new UpstreamError(mappedStatus, message, details);
  }

  return response;
}

function mapUnexpectedUpstreamError(error: unknown) {
  if (error instanceof UpstreamError) {
    return error;
  }

  if (error instanceof DOMException && error.name === "TimeoutError") {
    return new UpstreamError(504, "OpenRouter request timed out.");
  }

  if (error instanceof Error) {
    return new UpstreamError(502, error.message);
  }

  return new UpstreamError(502, "Unexpected upstream failure.");
}

async function parseOpenRouterError(response: Response): Promise<ParsedOpenRouterError> {
  const responseText = await response.text();
  const trimmedText = responseText.trim();
  const baseDetails: Record<string, unknown> = {
    upstreamStatus: response.status,
    upstreamStatusText: response.statusText
  };

  if (!trimmedText) {
    return {
      message: `OpenRouter request failed with ${response.status}.`,
      details: baseDetails
    };
  }

  try {
    const payload = JSON.parse(trimmedText) as OpenRouterErrorPayload;
    return {
      message: payload.error?.message ?? `OpenRouter request failed with ${response.status}.`,
      details: {
        ...baseDetails,
        ...(payload.error?.metadata &&
        typeof payload.error.metadata === "object" &&
        !Array.isArray(payload.error.metadata)
          ? (payload.error.metadata as Record<string, unknown>)
          : payload.error?.metadata !== undefined
            ? { metadata: payload.error.metadata }
            : {}),
        ...(payload.error?.code !== undefined ? { upstreamCode: payload.error.code } : {})
      }
    };
  } catch {
    return {
      message: `OpenRouter request failed with ${response.status}.`,
      details: {
        ...baseDetails,
        upstreamBody: trimmedText
      }
    };
  }
}
