import { getServerConfig } from "@/lib/config";
import type { ChatMessage, ChatRequest } from "@/lib/types";

type OpenRouterMessage = {
  content?: unknown;
  reasoning?: unknown;
};

type OpenRouterSuccess = {
  id?: string;
  model?: string;
  provider?: string;
  usage?: Record<string, unknown>;
  choices?: Array<{
    message?: OpenRouterMessage;
  }>;
};

type OpenRouterErrorPayload = {
  error?: {
    message?: string;
    code?: number | string;
    metadata?: unknown;
  };
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

export async function requestChatCompletion(input: ChatRequest) {
  try {
    const response = await fetchOpenRouter(input, false);
    const payload = (await response.json()) as OpenRouterSuccess;
    const message = payload.choices?.[0]?.message;

    return {
      id: payload.id ?? null,
      model: payload.model ?? null,
      provider: payload.provider ?? "openrouter",
      usage: payload.usage ?? null,
      reply: normalizeContent(message?.content),
      reasoning: input.reasoning?.enabled ? extractReasoning(message) : undefined
    };
  } catch (error) {
    throw mapUnexpectedUpstreamError(error);
  }
}

export async function openRouterStream(input: ChatRequest) {
  try {
    const response = await fetchOpenRouter(input, true);
    if (!response.body) {
      throw new UpstreamError(502, "Upstream returned an empty streaming body.");
    }

    return response;
  } catch (error) {
    throw mapUnexpectedUpstreamError(error);
  }
}

async function fetchOpenRouter(input: ChatRequest, stream: boolean) {
  const config = getServerConfig();
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
      body: JSON.stringify({
        model: config.model,
        messages: buildMessages(input),
        stream,
        ...(typeof input.temperature === "number" ? { temperature: input.temperature } : {}),
        ...(typeof input.maxTokens === "number" ? { max_tokens: input.maxTokens } : {}),
        ...(input.reasoning?.enabled
          ? {
              reasoning: {
                effort: input.reasoning.effort ?? "medium"
              }
            }
          : {})
      }),
      signal: AbortSignal.timeout(60_000)
    });
  } catch (error) {
    throw mapUnexpectedUpstreamError(error);
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as OpenRouterErrorPayload | null;
    const message = payload?.error?.message ?? `OpenRouter request failed with ${response.status}.`;
    const mappedStatus = response.status === 429 ? 429 : response.status >= 500 ? 502 : 502;
    throw new UpstreamError(mappedStatus, message, payload?.error?.metadata);
  }

  return response;
}

function buildMessages(input: ChatRequest): ChatMessage[] {
  if (!input.systemPrompt) {
    return input.messages;
  }

  return [
    {
      role: "system",
      content: input.systemPrompt
    },
    ...input.messages
  ];
}

function normalizeContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .flatMap((part) => {
        if (typeof part === "string") {
          return [part];
        }

        if (
          part &&
          typeof part === "object" &&
          "type" in part &&
          "text" in part &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string"
        ) {
          return [(part as { text: string }).text];
        }

        return [];
      })
      .join("");
  }

  return "";
}

function extractReasoning(message: OpenRouterMessage | undefined) {
  if (!message || typeof message !== "object") {
    return undefined;
  }

  if ("reasoning" in message) {
    return (message as { reasoning?: unknown }).reasoning;
  }

  return undefined;
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
