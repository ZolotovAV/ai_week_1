import type {
  ChatMessage,
  ContextCompressionMeta,
  NormalizedUsage,
  TokenGuardrailReason,
  TokenGuardrailStatus,
  TokenUsage
} from "@/lib/types";
import { DEFAULT_CONTEXT_WINDOW, resolveModelContextWindow } from "@/lib/model-context";
const DEFAULT_RESPONSE_BUDGET = 512;
const MESSAGE_OVERHEAD_TOKENS = 4;
const REPLY_OVERHEAD_TOKENS = 2;

type EstimateTokenUsageInput = {
  messages: ChatMessage[];
  model: string;
  modelContextWindows: Record<string, number>;
  requestedMaxTokens?: number;
  summaryMessageIndices?: number[];
  contextCompression?: ContextCompressionMeta;
};

function clampRatio(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  if (value >= 1) {
    return 1;
  }

  return value;
}

export function estimateTextTokens(text: string) {
  const normalized = text.trim();
  if (!normalized) {
    return 0;
  }

  const segments = normalized.match(/\p{L}+|\p{N}+|[^\s]/gu) ?? [];
  if (segments.length === 0) {
    return Math.max(1, Math.ceil(Buffer.byteLength(normalized, "utf8") / 4));
  }

  return segments.reduce((total, segment) => {
    if (/^[\p{L}\p{N}]+$/u.test(segment)) {
      return total + Math.max(1, Math.ceil(Buffer.byteLength(segment, "utf8") / 4));
    }

    return total + 1;
  }, 0);
}

export function estimateMessageTokensForRole(role: ChatMessage["role"], content: string) {
  return MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(role) + estimateTextTokens(content);
}

function estimateMessageTokens(message: ChatMessage) {
  return estimateMessageTokensForRole(message.role, message.content);
}

function toFiniteTokenCount(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }

  return Math.round(value);
}

function buildGuardrail(
  promptTokensEstimated: number,
  currentRequestTokens: number,
  historyTokens: number,
  requestedMaxTokens: number | null,
  contextWindow: number
) {
  const requestAndHistoryTokens = currentRequestTokens + historyTokens;
  const historyShare =
    requestAndHistoryTokens > 0 ? historyTokens / requestAndHistoryTokens : 0;
  const estimatedTotalWithRequestedCompletion =
    promptTokensEstimated + (requestedMaxTokens ?? 0);
  const estimatedContextUsageRatio = clampRatio(
    estimatedTotalWithRequestedCompletion / contextWindow
  );
  const availableBudget = Math.max(0, contextWindow - promptTokensEstimated);
  const reasons: TokenGuardrailReason[] = [];
  let status: TokenGuardrailStatus = "ok";

  if (historyShare >= 0.6) {
    status = "warning";
    reasons.push("history_dominates_request");
  }

  if (promptTokensEstimated >= contextWindow * 0.7) {
    status = "warning";
    reasons.push("prompt_near_context_limit");
  }

  if (estimatedTotalWithRequestedCompletion >= contextWindow * 0.85) {
    status = "near_limit";
    reasons.push("total_near_context_limit");
  }

  if (requestedMaxTokens !== null && requestedMaxTokens > availableBudget) {
    status = "near_limit";
    reasons.push("requested_completion_exceeds_available_budget");
  }

  return {
    availableBudget,
    estimatedContextUsageRatio,
    historyShare,
    reasons,
    status
  };
}

export function normalizeUsage(usage: unknown): NormalizedUsage | null {
  if (!usage || typeof usage !== "object") {
    return null;
  }

  const usageValue = usage as {
    completion_tokens?: unknown;
    completionTokens?: unknown;
    prompt_tokens?: unknown;
    promptTokens?: unknown;
    total_tokens?: unknown;
    totalTokens?: unknown;
  };

  const normalized: NormalizedUsage = {
    promptTokens: toFiniteTokenCount(usageValue.prompt_tokens ?? usageValue.promptTokens),
    completionTokens: toFiniteTokenCount(
      usageValue.completion_tokens ?? usageValue.completionTokens
    ),
    totalTokens: toFiniteTokenCount(usageValue.total_tokens ?? usageValue.totalTokens)
  };

  if (
    normalized.promptTokens === null &&
    normalized.completionTokens === null &&
    normalized.totalTokens === null
  ) {
    return null;
  }

  return normalized;
}

export function mergeUsage(
  current: NormalizedUsage | null,
  incoming: NormalizedUsage | null
): NormalizedUsage | null {
  if (!current) {
    return incoming;
  }

  if (!incoming) {
    return current;
  }

  return {
    promptTokens: incoming.promptTokens ?? current.promptTokens,
    completionTokens: incoming.completionTokens ?? current.completionTokens,
    totalTokens: incoming.totalTokens ?? current.totalTokens
  };
}

export function estimateTokenUsage({
  messages,
  model,
  modelContextWindows,
  requestedMaxTokens,
  summaryMessageIndices = [],
  contextCompression
}: EstimateTokenUsageInput): TokenUsage {
  const contextWindow = resolveModelContextWindow(model, modelContextWindows);
  const summaryMessageIndexSet = new Set(summaryMessageIndices);
  let lastUserMessageIndex = -1;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUserMessageIndex = index;
      break;
    }
  }

  let currentRequestTokens = 0;
  let historyTokens = 0;
  let historySummaryTokens = 0;
  let historyTailTokens = 0;
  let systemTokens = 0;

  for (const [index, message] of messages.entries()) {
    const estimatedTokens = estimateMessageTokens(message);

    if (message.role === "system") {
      systemTokens += estimatedTokens;
      continue;
    }

    if (message.role === "assistant") {
      historyTokens += estimatedTokens;
      if (summaryMessageIndexSet.has(index)) {
        historySummaryTokens += estimatedTokens;
      } else {
        historyTailTokens += estimatedTokens;
      }
      continue;
    }

    if (message.role === "user" && index === lastUserMessageIndex) {
      currentRequestTokens = estimatedTokens;
      continue;
    }

    historyTokens += estimatedTokens;
    historyTailTokens += estimatedTokens;
  }

  const promptEstimated = currentRequestTokens + historyTokens + systemTokens + REPLY_OVERHEAD_TOKENS;
  const normalizedRequestedMax =
    typeof requestedMaxTokens === "number" && Number.isFinite(requestedMaxTokens)
      ? Math.max(0, Math.round(requestedMaxTokens))
      : null;
  const guardrail = buildGuardrail(
    promptEstimated,
    currentRequestTokens,
    historyTokens,
    normalizedRequestedMax,
    contextWindow
  );

  return {
    request: {
      current: {
        estimated: currentRequestTokens
      },
      history: {
        estimated: historyTokens,
        summary: {
          estimated: historySummaryTokens
        },
        tail: {
          estimated: historyTailTokens
        }
      },
      system: {
        estimated: systemTokens
      },
      prompt: {
        estimated: promptEstimated,
        actual: null
      }
    },
    response: {
      requestedMax: normalizedRequestedMax,
      availableBudget: guardrail.availableBudget,
      estimated: null,
      actual: null
    },
    totals: {
      estimated: promptEstimated + (normalizedRequestedMax ?? DEFAULT_RESPONSE_BUDGET),
      actual: null
    },
    guardrail: {
      status: guardrail.status,
      reasons: guardrail.reasons,
      historyShare: guardrail.historyShare,
      contextWindow,
      estimatedContextUsageRatio: guardrail.estimatedContextUsageRatio
    },
    contextCompression
  };
}

export function finalizeTokenUsage(
  tokenUsage: TokenUsage,
  usage: NormalizedUsage | null,
  reply: string
): TokenUsage {
  const responseEstimated = reply.trim() ? estimateTextTokens(reply) + REPLY_OVERHEAD_TOKENS : 0;
  const promptActual = usage?.promptTokens ?? null;
  const responseActual = usage?.completionTokens ?? null;
  const totalActual =
    usage?.totalTokens
    ?? (promptActual !== null && responseActual !== null ? promptActual + responseActual : null);

  return {
    ...tokenUsage,
    request: {
      ...tokenUsage.request,
      prompt: {
        ...tokenUsage.request.prompt,
        actual: promptActual
      }
    },
    response: {
      ...tokenUsage.response,
      estimated: responseEstimated,
      actual: responseActual
    },
    totals: {
      ...tokenUsage.totals,
      actual: totalActual
    }
  };
}
