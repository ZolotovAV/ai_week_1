import { isAuthorized } from "@/lib/auth";
import { chatAgent } from "@/lib/chat-agent";
import { ConversationNotFoundError } from "@/lib/conversation-store";
import { getServerConfig } from "@/lib/config";
import { jsonError } from "@/lib/http";
import { resolveMaxConfiguredTokens } from "@/lib/model-context";
import { ModelSelectionError } from "@/lib/models";
import { UpstreamError } from "@/lib/openrouter";
import { createChatRequestSchema } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let config;

  try {
    config = getServerConfig();
  } catch (error) {
    return jsonError(500, error instanceof Error ? error.message : "Server configuration error.");
  }

  if (!isAuthorized(request.headers.get("authorization"), config.serviceApiKey)) {
    return jsonError(401, "Unauthorized.");
  }

  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return jsonError(400, "Request body must be valid JSON.");
  }

  const parsed = createChatRequestSchema(
    resolveMaxConfiguredTokens(config.allowedModels, config.modelContextWindows)
  ).safeParse(payload);
  if (!parsed.success) {
    return jsonError(400, "Invalid request payload.", parsed.error.flatten());
  }

  try {
    return await chatAgent.stream(config, parsed.data);
  } catch (error) {
    if (error instanceof ConversationNotFoundError) {
      return jsonError(404, error.message);
    }

    if (error instanceof ModelSelectionError) {
      return jsonError(400, error.message);
    }

    if (error instanceof UpstreamError) {
      console.error("POST /api/chat/stream upstream error", {
        details: error.details,
        message: error.message,
        status: error.status
      });
      return jsonError(error.status, error.message, error.details);
    }

    console.error("POST /api/chat/stream unexpected error", error);
    return jsonError(500, "Unexpected server error.");
  }
}
