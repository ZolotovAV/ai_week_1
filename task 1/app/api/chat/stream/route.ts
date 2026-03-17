import { isAuthorized } from "@/lib/auth";
import { getServerConfig } from "@/lib/config";
import { jsonError, sseEvent } from "@/lib/http";
import { ModelSelectionError, resolveRequestedModel } from "@/lib/models";
import { openRouterStream, UpstreamError } from "@/lib/openrouter";
import { chatRequestSchema } from "@/lib/types";

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

  const parsed = chatRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return jsonError(400, "Invalid request payload.", parsed.error.flatten());
  }

  let selectedModel: string;

  try {
    selectedModel = resolveRequestedModel(
      parsed.data.model,
      config.allowedModels,
      config.defaultModel
    );
    parsed.data.model = selectedModel;
  } catch (error) {
    if (error instanceof ModelSelectionError) {
      return jsonError(400, error.message);
    }

    return jsonError(400, "Invalid model selection.");
  }

  try {
    const upstreamResponse = await openRouterStream(parsed.data);
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    let buffer = "";

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(
          encoder.encode(
            sseEvent("meta", {
              model: selectedModel,
              provider: "openrouter"
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
              flushBufferedEvents(buffer, controller, encoder);
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

              if (parsed.done) {
                controller.enqueue(encoder.encode(sseEvent("done", { done: true })));
                controller.close();
                return;
              }

              if (parsed.content) {
                controller.enqueue(encoder.encode(sseEvent("delta", { content: parsed.content })));
              }
            }
          }

          controller.enqueue(encoder.encode(sseEvent("done", { done: true })));
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
  } catch (error) {
    if (error instanceof UpstreamError) {
      return jsonError(error.status, error.message, error.details);
    }

    return jsonError(500, "Unexpected server error.");
  }
}

function splitSseEvents(buffer: string) {
  return buffer.split(/\r?\n\r?\n/);
}

function flushBufferedEvents(
  buffer: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder
) {
  const trimmedBuffer = buffer.trim();
  if (!trimmedBuffer) {
    return;
  }

  for (const rawEvent of splitSseEvents(trimmedBuffer)) {
    const parsed = parseUpstreamEvent(rawEvent);
    if (parsed?.content) {
      controller.enqueue(encoder.encode(sseEvent("delta", { content: parsed.content })));
    }
  }
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
    return { done: true, content: "" };
  }

  let parsedEvent: Record<string, unknown>;
  try {
    parsedEvent = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }

  return {
    done: false,
    content: extractDelta(parsedEvent)
  };
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
