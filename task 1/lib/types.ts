import { z } from "zod";

export const chatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().min(1).max(20000)
});

export const conversationMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(20000)
});

export const conversationIdSchema = z.string().uuid();

const reasoningSchema = z
  .object({
    enabled: z.boolean(),
    effort: z.enum(["low", "medium", "high"]).optional()
  })
  .optional();

const chatRequestBaseSchema = z.object({
  prompt: z.string().min(1).max(20000),
  conversationId: conversationIdSchema.optional(),
  model: z.string().min(1).max(200).optional(),
  systemPrompt: z.string().min(1).max(4000).optional(),
  responseFormat: z.string().min(1).max(2000).optional(),
  responseLength: z.string().min(1).max(300).optional(),
  stopSequences: z.array(z.string().min(1).max(200)).min(1).max(4).optional(),
  completionInstruction: z.string().min(1).max(1000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).optional(),
  reasoning: reasoningSchema
});

export function createChatRequestSchema(maxTokensLimit: number) {
  return chatRequestBaseSchema.extend({
    maxTokens: z.number().int().min(1).max(maxTokensLimit).optional()
  });
}

export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;
export type ChatRequest = z.infer<typeof chatRequestBaseSchema>;

export type ConversationSummary = {
  summary: string;
  coveredMessageCount: number;
  coveredMessageId: number;
  updatedAt: string;
};

export type ContextCompressionMeta = {
  enabled: boolean;
  summaryPresent: boolean;
  retainedMessages: number;
  compressedMessages: number;
  coveredMessageCount: number;
  summaryEstimatedTokens?: number;
};

export type CompressedConversationContext = {
  effectiveSummary: string | null;
  summary: ConversationSummary | null;
  tailMessages: ConversationMessage[];
  contextCompression: ContextCompressionMeta;
};

export type ConversationContextSnapshot = {
  contextCompression: ContextCompressionMeta;
  summary: string | null;
};

export type TokenGuardrailStatus = "ok" | "warning" | "near_limit";

export type TokenGuardrailReason =
  | "history_dominates_request"
  | "prompt_near_context_limit"
  | "total_near_context_limit"
  | "requested_completion_exceeds_available_budget";

export type NormalizedUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
};

export type TokenUsage = {
  request: {
    current: {
      estimated: number;
    };
    history: {
      estimated: number;
      summary?: {
        estimated: number;
      };
      tail?: {
        estimated: number;
      };
    };
    system: {
      estimated: number;
    };
    prompt: {
      estimated: number;
      actual: number | null;
    };
  };
  response: {
    requestedMax: number | null;
    availableBudget: number;
    estimated: number | null;
    actual: number | null;
  };
  totals: {
    estimated: number;
    actual: number | null;
  };
  guardrail: {
    status: TokenGuardrailStatus;
    reasons: TokenGuardrailReason[];
    historyShare: number;
    contextWindow: number;
    estimatedContextUsageRatio: number;
  };
  contextCompression?: ContextCompressionMeta;
};
