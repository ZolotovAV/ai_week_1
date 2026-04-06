import { isAuthorized } from "@/lib/auth";
import { getServerConfig } from "@/lib/config";
import { conversationStore, ConversationNotFoundError } from "@/lib/conversation-store";
import { jsonError } from "@/lib/http";
import { conversationIdSchema } from "@/lib/types";

type ContextCompressionMeta = {
  compressedMessages?: number;
  coveredMessageCount?: number;
  enabled?: boolean;
  estimateIsApproximate?: boolean;
  retainedMessages?: number;
  summaryPresent?: boolean;
};

type ContextSnapshotPayload = {
  contextCompression?: ContextCompressionMeta | null;
  summary?: string | null;
};

type CompressedConversationPayload = {
  contextCompression?: ContextCompressionMeta | null;
  effectiveSummary?: string | null;
  summary?: { content?: string; summary?: string } | null;
  tailMessages?: unknown;
};

type CompressionCapableStore = typeof conversationStore & {
  getCompressedContext?: (conversationId: string) => Promise<CompressedConversationPayload>;
};

function buildFallbackCompressionMeta(messageCount: number): ContextCompressionMeta {
  return {
    compressedMessages: 0,
    coveredMessageCount: 0,
    enabled: false,
    estimateIsApproximate: false,
    retainedMessages: messageCount,
    summaryPresent: false
  };
}

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
    const compressionStore = conversationStore as CompressionCapableStore;

    if (typeof compressionStore.getCompressedContext === "function") {
      const compressedContext = await compressionStore.getCompressedContext(conversationId);
      const compressedRecord = compressedContext as CompressedConversationPayload;
      const messages = Array.isArray(compressedRecord.tailMessages)
        ? compressedRecord.tailMessages
        : [];
      const summary =
        typeof compressedRecord.effectiveSummary === "string"
          ? compressedRecord.effectiveSummary
          : typeof compressedRecord.summary?.content === "string"
            ? compressedRecord.summary.content
            : typeof compressedRecord.summary?.summary === "string"
              ? compressedRecord.summary.summary
              : undefined;

      return Response.json({
        conversationId,
        messages,
        savedContext: {
          contextCompression:
            compressedContext.contextCompression ?? buildFallbackCompressionMeta(messages.length),
          summary: summary ?? null
        },
        summary,
        contextCompression:
          compressedContext.contextCompression ?? buildFallbackCompressionMeta(messages.length)
      });
    }

    const messages = await conversationStore.getConversationMessages(conversationId);

    return Response.json({
      conversationId,
      messages,
      savedContext: {
        contextCompression: buildFallbackCompressionMeta(messages.length),
        summary: null
      },
      contextCompression: buildFallbackCompressionMeta(messages.length)
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
