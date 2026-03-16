import { isAuthorized } from "@/lib/auth";
import { getServerConfig } from "@/lib/config";
import { jsonError } from "@/lib/http";
import { requestChatCompletion, UpstreamError } from "@/lib/openrouter";
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
    const completion = await requestChatCompletion(parsed.data);
    return Response.json(completion);
  } catch (error) {
    if (error instanceof UpstreamError) {
      return jsonError(error.status, error.message, error.details);
    }

    return jsonError(500, "Unexpected server error.");
  }
}
