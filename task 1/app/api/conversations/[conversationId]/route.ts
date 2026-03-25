import { isAuthorized } from "@/lib/auth";
import { getServerConfig } from "@/lib/config";
import { conversationStore, ConversationNotFoundError } from "@/lib/conversation-store";
import { jsonError } from "@/lib/http";
import { conversationIdSchema } from "@/lib/types";

export const runtime = "nodejs";

async function getValidatedConversationId(rawConversationId: string) {
  const parsed = conversationIdSchema.safeParse(rawConversationId);

  if (!parsed.success) {
    throw new Error("Invalid conversation id.");
  }

  return parsed.data;
}

function getConfigOrError() {
  try {
    return {
      config: getServerConfig(),
      error: null
    };
  } catch (error) {
    return {
      config: null,
      error: jsonError(
        500,
        error instanceof Error ? error.message : "Server configuration error."
      )
    };
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ conversationId: string }> }
) {
  const { config, error } = getConfigOrError();
  if (error || !config) {
    return error;
  }

  if (!isAuthorized(request.headers.get("authorization"), config.serviceApiKey)) {
    return jsonError(401, "Unauthorized.");
  }

  try {
    const { conversationId: rawConversationId } = await context.params;
    const conversationId = await getValidatedConversationId(rawConversationId);
    const messages = await conversationStore.getConversationMessages(conversationId);

    return Response.json({
      conversationId,
      messages
    });
  } catch (error) {
    if (error instanceof ConversationNotFoundError) {
      return jsonError(404, error.message);
    }

    if (error instanceof Error && error.message === "Invalid conversation id.") {
      return jsonError(400, error.message);
    }

    console.error("GET /api/conversations/[conversationId] unexpected error", error);
    return jsonError(500, "Unexpected server error.");
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ conversationId: string }> }
) {
  const { config, error } = getConfigOrError();
  if (error || !config) {
    return error;
  }

  if (!isAuthorized(request.headers.get("authorization"), config.serviceApiKey)) {
    return jsonError(401, "Unauthorized.");
  }

  try {
    const { conversationId: rawConversationId } = await context.params;
    const conversationId = await getValidatedConversationId(rawConversationId);

    await conversationStore.deleteConversation(conversationId);
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof Error && error.message === "Invalid conversation id.") {
      return jsonError(400, error.message);
    }

    console.error("DELETE /api/conversations/[conversationId] unexpected error", error);
    return jsonError(500, "Unexpected server error.");
  }
}
