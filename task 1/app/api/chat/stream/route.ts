import { isAuthorized } from "@/lib/auth";
import { getServerConfig } from "@/lib/config";
import { jsonError, sseEvent } from "@/lib/http";
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
              model: config.model,
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
              break;
            }

            buffer += decoder.decode(value, { stream: true });
            const events = buffer.split("\n\n");
            buffer = events.pop() ?? "";

            for (const rawEvent of events) {
              const payloadLine = rawEvent
                .split("\n")
                .find((line) => line.startsWith("data:"));

              if (!payloadLine) {
                continue;
              }

              const data = payloadLine.slice(5).trim();
              if (data === "[DONE]") {
                controller.enqueue(encoder.encode(sseEvent("done", { done: true })));
                controller.close();
                return;
              }

              let parsedEvent: Record<string, unknown>;
              try {
                parsedEvent = JSON.parse(data) as Record<string, unknown>;
              } catch {
                continue;
              }

              const content = extractDelta(parsedEvent);
              if (content) {
                controller.enqueue(encoder.encode(sseEvent("delta", { content })));
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

function extractDelta(event: Record<string, unknown>) {
  const choices = event.choices;
  if (!Array.isArray(choices)) {
    return "";
  }

  const firstChoice = choices[0];
  if (!firstChoice || typeof firstChoice !== "object") {
    return "";
  }

  const delta = (firstChoice as { delta?: unknown }).delta;
  if (!delta || typeof delta !== "object") {
    return "";
  }

  const content = (delta as { content?: unknown }).content;
  return typeof content === "string" ? content : "";
}
