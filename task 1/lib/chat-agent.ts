import {
  buildConversationSummaryPrompt,
  CONTEXT_COMPRESSION_SUMMARY_MAX_TOKENS,
  formatConversationSummary,
  normalizeModelSummary
} from "@/lib/context-compression";
import type { ServerConfig } from "@/lib/config";
import { conversationStore, ConversationNotFoundError } from "@/lib/conversation-store";
import { sseEvent } from "@/lib/http";
import { resolveRequestedModel } from "@/lib/models";
import { requestOpenRouter, UpstreamError } from "@/lib/openrouter";
import { estimateTokenUsage, finalizeTokenUsage, mergeUsage, normalizeUsage } from "@/lib/token-usage";
import type {
  ChatMessage,
  ChatRequest,
  CompressedConversationContext,
  ConversationContextSnapshot,
  ContextCompressionMeta,
  NormalizedUsage
} from "@/lib/types";

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

type PreparedAgentRequest = {
  conversationId: string;
  contextCompression: ContextCompressionMeta;
  messages: ChatMessage[];
  requestBody: Record<string, unknown>;
  selectedModel: string;
  summaryMessageIndices: number[];
};

type BuiltMessages = {
  messages: ChatMessage[];
  summaryMessageIndices: number[];
};

type SummaryRefreshCandidate = {
  coveredMessageCount: number;
  coveredMessageId: number;
  messages: Array<{
    content: string;
    role: "assistant" | "user";
  }>;
  previousSummary: string | null;
};

async function resolveConversationId(requestedConversationId?: string) {
  if (!requestedConversationId) {
    const createdConversation = await conversationStore.createConversation();
    return createdConversation.conversationId;
  }

  const exists = await conversationStore.conversationExists(requestedConversationId);
  if (!exists) {
    throw new ConversationNotFoundError(requestedConversationId);
  }

  return requestedConversationId;
}

function prepareRequest(
  config: ServerConfig,
  input: ChatRequest,
  conversationId: string,
  context: CompressedConversationContext,
  stream: boolean
): PreparedAgentRequest {
  const selectedModel = resolveRequestedModel(
    input.model,
    config.allowedModels,
    config.defaultModel
  );
  const { messages, summaryMessageIndices } = buildMessages(input, context);

  return {
    conversationId,
    contextCompression: context.contextCompression,
    messages,
    selectedModel,
    summaryMessageIndices,
    requestBody: {
      model: selectedModel,
      messages,
      stream,
      ...(input.stopSequences?.length ? { stop: input.stopSequences } : {}),
      ...(typeof input.temperature === "number" ? { temperature: input.temperature } : {}),
      ...(typeof input.maxTokens === "number" ? { max_tokens: input.maxTokens } : {}),
      ...(input.reasoning?.enabled
        ? {
            reasoning: {
              effort: input.reasoning.effort ?? "medium"
            }
          }
        : {})
    }
  };
}

function buildMessages(input: ChatRequest, context: CompressedConversationContext): BuiltMessages {
  const systemInstruction = buildSystemInstruction(input);
  const summaryMessageIndices: number[] = [];
  const conversationMessages: ChatMessage[] = [
    ...(context.effectiveSummary
      ? [
          {
            role: "assistant" as const,
            content: formatConversationSummary(context.effectiveSummary)
          }
        ]
      : []),
    ...context.tailMessages,
    { role: "user", content: input.prompt }
  ];

  if (context.effectiveSummary) {
    summaryMessageIndices.push(systemInstruction ? 1 : 0);
  }

  if (!systemInstruction) {
    return {
      messages: conversationMessages,
      summaryMessageIndices
    };
  }

  return {
    messages: [
      {
        role: "system",
        content: systemInstruction
      },
      ...conversationMessages
    ],
    summaryMessageIndices
  };
}

function buildSystemInstruction(input: ChatRequest) {
  const instructions = [
    input.systemPrompt?.trim(),
    input.responseFormat?.trim()
      ? `Return the answer in this exact format: ${input.responseFormat.trim()}`
      : undefined,
    input.responseLength?.trim()
      ? `Keep the entire answer within this limit: ${input.responseLength.trim()}`
      : undefined,
    input.completionInstruction?.trim()
      ? `Finish the answer when this condition is met: ${input.completionInstruction.trim()}`
      : undefined,
    input.stopSequences?.length
      ? `Stop generating immediately if you are about to output any of these sequences: ${input.stopSequences
          .map((sequence) => JSON.stringify(sequence))
          .join(", ")}`
      : undefined
  ].filter((instruction): instruction is string => Boolean(instruction));

  if (instructions.length === 0) {
    return undefined;
  }

  return instructions.join("\n\n");
}

async function requestConversationSummary(
  config: ServerConfig,
  candidate: SummaryRefreshCandidate
) {
  const response = await requestOpenRouter(config, {
    model: config.summaryModel,
    messages: [
      {
        role: "system",
        content:
          "You maintain a concise, factual memory summary for a conversation. Return plain text only."
      },
      {
        role: "user",
        content: buildConversationSummaryPrompt(candidate.previousSummary, candidate.messages)
      }
    ],
    stream: false,
    temperature: 0,
    max_tokens: CONTEXT_COMPRESSION_SUMMARY_MAX_TOKENS
  });
  const payload = (await response.json()) as OpenRouterSuccess;
  const reply = normalizeContent(payload.choices?.[0]?.message?.content);

  return normalizeModelSummary(reply);
}

async function refreshConversationSummaryWithModel(config: ServerConfig, conversationId: string) {
  const candidate = (await conversationStore.getSummaryRefreshCandidate(
    conversationId
  )) as SummaryRefreshCandidate | null;

  if (!candidate) {
    return;
  }

  const summary = await requestConversationSummary(config, candidate);
  if (!summary) {
    return;
  }

  await conversationStore.saveConversationSummary(
    conversationId,
    summary,
    candidate.coveredMessageId,
    candidate.coveredMessageCount
  );
}

async function syncConversationSummary(config: ServerConfig, conversationId: string) {
  try {
    await refreshConversationSummaryWithModel(config, conversationId);
  } catch (error) {
    console.error("Conversation summary refresh failed", {
      conversationId,
      error: error instanceof Error ? error.message : "Unknown summary refresh error."
    });
  }
}

function normalizeContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

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

function extractReasoning(message: OpenRouterMessage | undefined) {
  if (!message || typeof message !== "object") {
    return undefined;
  }

  if ("reasoning" in message) {
    return (message as { reasoning?: unknown }).reasoning;
  }

  return undefined;
}

function splitSseEvents(buffer: string) {
  return buffer.split(/\r?\n\r?\n/);
}

function extractMessageContent(value: Record<string, unknown>) {
  const content = value.content;

  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .flatMap((part) => {
      if (typeof part === "string") {
        return [part];
      }

      if (
        part &&
        typeof part === "object" &&
        "text" in part &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        return [(part as { text: string }).text];
      }

      return [];
    })
    .join("");
}

function extractDelta(event: Record<string, unknown>) {
  const choices = event.choices;
  if (!Array.isArray(choices)) {
    return extractMessageContent(event);
  }

  const firstChoice = choices[0];
  if (!firstChoice || typeof firstChoice !== "object") {
    return "";
  }

  const delta = (firstChoice as { delta?: unknown }).delta;
  if (delta && typeof delta === "object") {
    const deltaContent = extractMessageContent(delta as Record<string, unknown>);
    if (deltaContent) {
      return deltaContent;
    }
  }

  const message = (firstChoice as { message?: unknown }).message;
  if (message && typeof message === "object") {
    return extractMessageContent(message as Record<string, unknown>);
  }

  return "";
}

function parseUpstreamEvent(rawEvent: string) {
  const dataLines = rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());

  if (dataLines.length === 0) {
    return null;
  }

  const data = dataLines.join("\n");
  if (data === "[DONE]") {
    return { done: true, content: "", usage: null as NormalizedUsage | null };
  }

  let parsedEvent: Record<string, unknown>;
  try {
    parsedEvent = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }

  return {
    done: false,
    content: extractDelta(parsedEvent),
    usage: normalizeUsage(parsedEvent.usage)
  };
}

function flushBufferedEvents(buffer: string) {
  const trimmedBuffer = buffer.trim();
  if (!trimmedBuffer) {
    return {
      assistantReply: "",
      deltas: [] as string[],
      usage: null as NormalizedUsage | null
    };
  }

  let assistantReply = "";
  const deltas: string[] = [];
  let usage: NormalizedUsage | null = null;

  for (const rawEvent of splitSseEvents(trimmedBuffer)) {
    const parsed = parseUpstreamEvent(rawEvent);
    if (parsed?.content) {
      assistantReply += parsed.content;
      deltas.push(parsed.content);
    }

    if (parsed?.usage) {
      usage = mergeUsage(usage, parsed.usage);
    }
  }

  return {
    assistantReply,
    deltas,
    usage
  };
}

function withContextCompression<T extends Record<string, unknown>>(
  payload: T,
  usedContext: ConversationContextSnapshot,
  savedContext: ConversationContextSnapshot
) {
  return {
    ...payload,
    contextCompression: savedContext.contextCompression,
    summary: savedContext.summary,
    savedContext,
    usedContext
  };
}

function toContextSnapshot(context: CompressedConversationContext): ConversationContextSnapshot {
  return {
    contextCompression: context.contextCompression,
    summary: context.effectiveSummary
  };
}

export const chatAgent = {
  async respond(config: ServerConfig, input: ChatRequest) {
    const conversationId = await resolveConversationId(input.conversationId);
    await syncConversationSummary(config, conversationId);
    const context = await conversationStore.getCompressedContext(conversationId);
    const usedContext = toContextSnapshot(context);

    await conversationStore.appendMessage(conversationId, "user", input.prompt);

    const {
      contextCompression,
      messages,
      requestBody,
      selectedModel,
      summaryMessageIndices
    } = prepareRequest(
      config,
      input,
      conversationId,
      context,
      false
    );
    const estimatedTokenUsage = estimateTokenUsage({
      contextCompression,
      messages,
      model: selectedModel,
      modelContextWindows: config.modelContextWindows,
      requestedMaxTokens: input.maxTokens,
      summaryMessageIndices
    });
    const response = await requestOpenRouter(config, requestBody);
    const payload = (await response.json()) as OpenRouterSuccess;
    const message = payload.choices?.[0]?.message;
    const reply = normalizeContent(message?.content);
    const tokenUsage = finalizeTokenUsage(estimatedTokenUsage, normalizeUsage(payload.usage), reply);

    if (reply.trim()) {
      await conversationStore.appendMessage(conversationId, "assistant", reply);
      await syncConversationSummary(config, conversationId);
    }

    const savedContext = toContextSnapshot(
      await conversationStore.getCompressedContext(conversationId)
    );

    return withContextCompression(
      {
        conversationId,
        id: payload.id ?? null,
        model: payload.model ?? null,
        provider: payload.provider ?? "openrouter",
        usage: payload.usage ?? null,
        tokenUsage,
        reply,
        reasoning: input.reasoning?.enabled ? extractReasoning(message) : undefined
      },
      usedContext,
      savedContext
    );
  },

  async stream(config: ServerConfig, input: ChatRequest) {
    const conversationId = await resolveConversationId(input.conversationId);
    await syncConversationSummary(config, conversationId);
    const context = await conversationStore.getCompressedContext(conversationId);
    const usedContext = toContextSnapshot(context);

    await conversationStore.appendMessage(conversationId, "user", input.prompt);

    const {
      contextCompression,
      messages,
      requestBody,
      selectedModel,
      summaryMessageIndices
    } = prepareRequest(
      config,
      input,
      conversationId,
      context,
      true
    );
    const estimatedTokenUsage = estimateTokenUsage({
      contextCompression,
      messages,
      model: selectedModel,
      modelContextWindows: config.modelContextWindows,
      requestedMaxTokens: input.maxTokens,
      summaryMessageIndices
    });
    const upstreamResponse = await requestOpenRouter(config, requestBody);

    if (!upstreamResponse.body) {
      throw new UpstreamError(502, "Upstream returned an empty streaming body.");
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let buffer = "";
    let assistantReply = "";
    let assistantReplySaved = false;
    let latestUsage: NormalizedUsage | null = null;

    const persistAssistantReply = async () => {
      if (assistantReplySaved || !assistantReply.trim()) {
        return;
      }

      assistantReplySaved = true;
      await conversationStore.appendMessage(conversationId, "assistant", assistantReply);
      await syncConversationSummary(config, conversationId);
    };

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(
          encoder.encode(
            sseEvent("meta", {
              conversationId,
              model: selectedModel,
              provider: "openrouter",
              contextCompression: usedContext.contextCompression,
              summary: usedContext.summary,
              usedContext,
              tokenUsage: estimatedTokenUsage
            })
          )
        );

        const reader = upstreamResponse.body?.getReader();
        if (!reader) {
          controller.enqueue(
            encoder.encode(sseEvent("error", { error: "Upstream reader could not be created." }))
          );
          controller.close();
          return;
        }

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              const flushed = flushBufferedEvents(buffer);
              assistantReply += flushed.assistantReply;
              latestUsage = mergeUsage(latestUsage, flushed.usage);

              for (const delta of flushed.deltas) {
                controller.enqueue(encoder.encode(sseEvent("delta", { content: delta })));
              }

              if (latestUsage) {
                controller.enqueue(
                  encoder.encode(
                    sseEvent("usage", {
                      contextCompression: usedContext.contextCompression,
                      summary: usedContext.summary,
                      usedContext,
                      usage: latestUsage,
                      tokenUsage: finalizeTokenUsage(
                        estimatedTokenUsage,
                        latestUsage,
                        assistantReply
                      )
                    })
                  )
                );
              }

              break;
            }

            buffer += decoder.decode(value, { stream: true });
            const events = splitSseEvents(buffer);
            buffer = events.pop() ?? "";

            for (const rawEvent of events) {
              const parsed = parseUpstreamEvent(rawEvent);
              if (!parsed) {
                continue;
              }

              if (parsed.usage) {
                latestUsage = mergeUsage(latestUsage, parsed.usage);
                controller.enqueue(
                  encoder.encode(
                    sseEvent("usage", {
                      contextCompression: usedContext.contextCompression,
                      summary: usedContext.summary,
                      usedContext,
                      usage: latestUsage,
                      tokenUsage: finalizeTokenUsage(
                        estimatedTokenUsage,
                        latestUsage,
                        assistantReply + parsed.content
                      )
                    })
                  )
                );
              }

              if (parsed.done) {
                await persistAssistantReply();
                const savedContext = toContextSnapshot(
                  await conversationStore.getCompressedContext(conversationId)
                );
                controller.enqueue(
                  encoder.encode(
                    sseEvent("usage", {
                      contextCompression: savedContext.contextCompression,
                      savedContext,
                      summary: savedContext.summary,
                      usage: latestUsage,
                      tokenUsage: finalizeTokenUsage(
                        estimatedTokenUsage,
                        latestUsage,
                        assistantReply
                      )
                    })
                  )
                );
                controller.enqueue(
                  encoder.encode(
                    sseEvent("done", {
                      contextCompression: savedContext.contextCompression,
                      done: true,
                      savedContext,
                      summary: savedContext.summary
                    })
                  )
                );
                controller.close();
                return;
              }

              if (parsed.content) {
                assistantReply += parsed.content;
                controller.enqueue(encoder.encode(sseEvent("delta", { content: parsed.content })));
              }
            }
          }

          await persistAssistantReply();
          const savedContext = toContextSnapshot(
            await conversationStore.getCompressedContext(conversationId)
          );
          controller.enqueue(
            encoder.encode(
              sseEvent("usage", {
                contextCompression: savedContext.contextCompression,
                savedContext,
                summary: savedContext.summary,
                usage: latestUsage,
                tokenUsage: finalizeTokenUsage(estimatedTokenUsage, latestUsage, assistantReply)
              })
            )
          );
          controller.enqueue(
            encoder.encode(
              sseEvent("done", {
                contextCompression: savedContext.contextCompression,
                done: true,
                savedContext,
                summary: savedContext.summary
              })
            )
          );
          controller.close();
        } catch (error) {
          const message = error instanceof Error ? error.message : "Streaming pipeline failed.";
          controller.enqueue(encoder.encode(sseEvent("error", { error: message })));
          controller.close();
        } finally {
          reader.releaseLock();
        }
      }
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive"
      }
    });
  }
};
