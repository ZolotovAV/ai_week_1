"use client";

import type { Dispatch, FormEvent, SetStateAction } from "react";
import { useEffect, useRef, useState } from "react";

type Mode = "json" | "stream";

type ResponseState = {
  reply: string;
  status: string;
  meta: string;
  error: string;
};

type ModelOption = {
  id: string;
  label: string;
  isDefault: boolean;
};

type ApiErrorPayload = {
  details?: unknown;
  error?: string;
};

type ConversationMessage = {
  content: string;
  role: "assistant" | "user";
};

type ChatRequestPayload = {
  completionInstruction?: string;
  conversationId?: string;
  maxTokens?: number;
  model?: string;
  prompt: string;
  reasoning?:
    | {
        enabled: true;
        effort: string;
      }
    | undefined;
  responseFormat?: string;
  responseLength?: string;
  stopSequences?: string[];
  systemPrompt?: string;
  temperature?: number;
};

const SERVICE_KEY_STORAGE = "nemotron-service-api-key";
const CONVERSATION_ID_STORAGE = "nemotron-conversation-id";

export function ChatConsole() {
  const [serviceKey, setServiceKey] = useState("");
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [modelsError, setModelsError] = useState("");
  const [prompt, setPrompt] = useState("Write a short greeting from a web service.");
  const [systemPrompt, setSystemPrompt] = useState(
    "You are a concise assistant speaking in clear English."
  );
  const [responseFormat, setResponseFormat] = useState("");
  const [responseLength, setResponseLength] = useState("");
  const [completionInstruction, setCompletionInstruction] = useState("");
  const [stopSequence, setStopSequence] = useState("");
  const [mode, setMode] = useState<Mode>("json");
  const [reasoningEnabled, setReasoningEnabled] = useState(false);
  const [reasoningEffort, setReasoningEffort] = useState("medium");
  const [temperature, setTemperature] = useState("0.7");
  const [maxTokens, setMaxTokens] = useState("512");
  const [activeConversationId, setActiveConversationId] = useState("");
  const [conversationHistory, setConversationHistory] = useState<ConversationMessage[]>([]);
  const [restoringConversation, setRestoringConversation] = useState(false);
  const [sessionPromptTokens, setSessionPromptTokens] = useState(0);
  const [loading, setLoading] = useState(false);
  const lastRestoreAttemptRef = useRef("");
  const [response, setResponse] = useState<ResponseState>({
    reply: "",
    status: "Idle",
    meta: "",
    error: ""
  });

  useEffect(() => {
    const savedKey = window.sessionStorage.getItem(SERVICE_KEY_STORAGE);
    const savedConversationId = window.localStorage.getItem(CONVERSATION_ID_STORAGE);

    if (savedKey) {
      setServiceKey(savedKey);
    }

    if (savedConversationId) {
      setActiveConversationId(savedConversationId);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadModels() {
      try {
        const response = await fetch("/api/models");
        const payload = (await response.json().catch(() => null)) as
          | {
              defaultModel?: string;
              models?: ModelOption[];
              error?: string;
            }
          | null;

        if (!response.ok) {
          throw new Error(payload?.error ?? "Failed to load model list.");
        }

        const models = payload?.models ?? [];
        if (!cancelled) {
          setAvailableModels(models);
          setSelectedModel(payload?.defaultModel ?? models[0]?.id ?? "");
          setModelsError(models.length === 0 ? "Server returned no available models." : "");
        }
      } catch (error) {
        if (!cancelled) {
          setModelsError(
            error instanceof Error ? error.message : "Failed to load models from the server."
          );
        }
      }
    }

    void loadModels();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const normalizedServiceKey = serviceKey.trim();
    if (!normalizedServiceKey || !activeConversationId) {
      return;
    }

    const restoreAttemptKey = `${normalizedServiceKey}:${activeConversationId}`;
    if (lastRestoreAttemptRef.current === restoreAttemptKey) {
      return;
    }

    let cancelled = false;
    lastRestoreAttemptRef.current = restoreAttemptKey;

    async function restoreConversation() {
      setRestoringConversation(true);
      setResponse((current) => ({
        ...current,
        status: current.reply ? current.status : "Restoring context...",
        error: ""
      }));

      try {
        const apiResponse = await fetch(`/api/conversations/${activeConversationId}`, {
          headers: buildHeaders(normalizedServiceKey)
        });

        const payload = (await apiResponse.json().catch(() => null)) as
          | {
              conversationId?: string;
              messages?: ConversationMessage[];
              error?: string;
              details?: unknown;
            }
          | null;

        if (apiResponse.status === 404) {
          if (!cancelled) {
            clearPersistedConversationId();
            setActiveConversationId("");
            setConversationHistory([]);
            setResponse({
              reply: "",
              status: "Idle",
              meta: "",
              error: ""
            });
          }
          return;
        }

        if (!apiResponse.ok) {
          throw new Error(formatApiError(apiResponse.status, payload));
        }

        if (!cancelled) {
          setConversationHistory(payload?.messages ?? []);
          setResponse((current) => ({
            ...current,
            status: "Idle",
            error: ""
          }));
        }
      } catch (error) {
        if (!cancelled) {
          setResponse((current) => ({
            ...current,
            status: "Idle",
            error: `Failed to restore saved conversation. ${toClientErrorMessage(error)}`
          }));
        }
      } finally {
        if (!cancelled) {
          setRestoringConversation(false);
        }
      }
    }

    void restoreConversation();

    return () => {
      cancelled = true;
    };
  }, [activeConversationId, serviceKey]);

  function persistConversationId(conversationId: string) {
    setActiveConversationId(conversationId);
    const normalizedServiceKey = serviceKey.trim();
    if (normalizedServiceKey) {
      lastRestoreAttemptRef.current = `${normalizedServiceKey}:${conversationId}`;
    }
    window.localStorage.setItem(CONVERSATION_ID_STORAGE, conversationId);
  }

  function clearPersistedConversationId() {
    window.localStorage.removeItem(CONVERSATION_ID_STORAGE);
  }

  function resetConversationState() {
    clearPersistedConversationId();
    setActiveConversationId("");
    setConversationHistory([]);
    lastRestoreAttemptRef.current = "";
    setSessionPromptTokens(0);
    setResponse({
      reply: "",
      status: "Idle",
      meta: "",
      error: ""
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedServiceKey = serviceKey.trim();
    const normalizedPrompt = prompt.trim();

    if (!normalizedServiceKey) {
      setResponse({
        reply: "",
        status: "Failed",
        meta: "",
        error: "Enter SERVICE_API_KEY from .env.local before sending a request."
      });
      return;
    }

    if (!normalizedPrompt) {
      setResponse({
        reply: "",
        status: "Failed",
        meta: "",
        error: "Enter a user prompt before sending a request."
      });
      return;
    }

    const requestBody = buildRequestBody({
      activeConversationId,
      completionInstruction,
      maxTokens,
      prompt: normalizedPrompt,
      reasoningEffort,
      reasoningEnabled,
      responseFormat,
      responseLength,
      selectedModel,
      stopSequence,
      systemPrompt,
      temperature
    });

    setLoading(true);
    setResponse({
      reply: "",
      status: mode === "stream" ? "Streaming..." : "Waiting for model...",
      meta: "",
      error: ""
    });

    window.sessionStorage.setItem(SERVICE_KEY_STORAGE, normalizedServiceKey);

    try {
      if (mode === "json") {
        await submitJson(normalizedServiceKey, normalizedPrompt, requestBody);
      } else {
        await submitStream(normalizedServiceKey, normalizedPrompt, requestBody);
      }
    } catch (error) {
      const message = toClientErrorMessage(error);
      setResponse((current) => ({
        ...current,
        status: "Failed",
        error: message
      }));
    } finally {
      setLoading(false);
    }
  }

  async function handleClearContext() {
    if (loading || restoringConversation) {
      return;
    }

    const normalizedServiceKey = serviceKey.trim();

    if (!activeConversationId) {
      resetConversationState();
      return;
    }

    if (!normalizedServiceKey) {
      setResponse((current) => ({
        ...current,
        status: "Failed",
        error: "Enter SERVICE_API_KEY before clearing a saved conversation."
      }));
      return;
    }

    try {
      const apiResponse = await fetch(`/api/conversations/${activeConversationId}`, {
        method: "DELETE",
        headers: buildHeaders(normalizedServiceKey)
      });

      if (!apiResponse.ok) {
        const payload = (await apiResponse.json().catch(() => null)) as ApiErrorPayload | null;
        throw new Error(formatApiError(apiResponse.status, payload));
      }

      resetConversationState();
    } catch (error) {
      setResponse((current) => ({
        ...current,
        status: "Failed",
        error: toClientErrorMessage(error)
      }));
    }
  }

  async function submitJson(
    serviceKey: string,
    submittedPrompt: string,
    requestBody: ChatRequestPayload
  ) {
    const apiResponse = await fetch("/api/chat", {
      method: "POST",
      headers: buildHeaders(serviceKey),
      body: JSON.stringify(requestBody)
    });

    const payload = (await apiResponse.json().catch(() => null)) as
      | {
          conversationId?: string;
          reply?: string;
          model?: string;
          usage?: Record<string, unknown>;
          error?: string;
          details?: unknown;
        }
      | null;

    if (!apiResponse.ok) {
      throw new Error(formatApiError(apiResponse.status, payload));
    }

    if (typeof payload?.conversationId === "string") {
      persistConversationId(payload.conversationId);
    }

    setConversationHistory((current) =>
      appendConversationTurn(current, submittedPrompt, payload?.reply ?? "")
    );
    const promptTokens = extractPromptTokens(payload?.usage);
    if (promptTokens !== null) {
      setSessionPromptTokens((current) => current + promptTokens);
    }
    setResponse({
      reply: payload?.reply ?? "",
      status: "Completed",
      meta: payload?.model ? `Model: ${payload.model}` : "",
      error: ""
    });
  }

  async function submitStream(
    serviceKey: string,
    submittedPrompt: string,
    requestBody: ChatRequestPayload
  ) {
    const apiResponse = await fetch("/api/chat/stream", {
      method: "POST",
      headers: buildHeaders(serviceKey),
      body: JSON.stringify(requestBody)
    });

    if (!apiResponse.ok || !apiResponse.body) {
      const payload = (await apiResponse.json().catch(() => null)) as ApiErrorPayload | null;
      throw new Error(formatApiError(apiResponse.status, payload));
    }

    const reader = apiResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let assistantReply = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        flushClientSseBuffer(
          buffer,
          setResponse,
          (content) => {
            assistantReply += content;
          },
          (promptTokens) => {
            setSessionPromptTokens((current) => current + promptTokens);
          },
          (conversationId) => {
            persistConversationId(conversationId);
          }
        );
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const parts = splitClientSseEvents(buffer);
      buffer = parts.pop() ?? "";

      for (const eventChunk of parts) {
        applyParsedSseEvent(
          eventChunk,
          setResponse,
          (content) => {
            assistantReply += content;
          },
          (promptTokens) => {
            setSessionPromptTokens((current) => current + promptTokens);
          },
          (conversationId) => {
            persistConversationId(conversationId);
          }
        );
      }
    }

    setConversationHistory((current) =>
      appendConversationTurn(current, submittedPrompt, assistantReply)
    );
  }

  return (
    <main className="shell">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">OpenRouter Proxy Service</p>
          <h1>Nemotron over your own API, with JSON and streaming responses.</h1>
          <p className="lede">
            This demo UI calls your secured Next.js backend. The backend owns the
            OpenRouter key, applies the selected model, and exposes a stable contract for
            clients.
          </p>
        </div>
        <div className="endpoint-card">
          <code>GET /api/models</code>
          <code>POST /api/chat</code>
          <code>POST /api/chat/stream</code>
          <span>Auth: Bearer service key</span>
        </div>
      </section>

      <section className="workspace">
        <form className="panel controls-panel" onSubmit={handleSubmit}>
          <div className="control-row control-row-primary">
            <label className="field-card field-span-2">
              <span>Service API key</span>
              <input
                autoComplete="off"
                type="password"
                value={serviceKey}
                onChange={(event) => setServiceKey(event.target.value)}
                placeholder="Bearer token for this service"
                required
              />
              <small className="field-hint">
                Use the exact <code>SERVICE_API_KEY</code> value from <code>.env.local</code>. If
                you changed it, restart <code>npm run dev</code>.
              </small>
            </label>

            <label className="field-card field-span-2">
              <span>OpenRouter model</span>
              <select
                value={selectedModel}
                onChange={(event) => setSelectedModel(event.target.value)}
                disabled={availableModels.length === 0}
              >
                {availableModels.length === 0 ? (
                  <option value="">No models available</option>
                ) : (
                  availableModels.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                      {model.isDefault ? " (default)" : ""}
                    </option>
                  ))
                )}
              </select>
              <small className="field-hint">
                The list comes from the server allowlist. Only configured models can be used.
              </small>
              {modelsError ? <small className="error">{modelsError}</small> : null}
            </label>

            <label className="field-card">
              <span>Mode</span>
              <select value={mode} onChange={(event) => setMode(event.target.value as Mode)}>
                <option value="json">JSON</option>
                <option value="stream">Stream (SSE)</option>
              </select>
            </label>
          </div>

          <div className="control-row control-row-secondary">
            <label className="field-card field-span-2">
              <span>System prompt</span>
              <textarea
                value={systemPrompt}
                onChange={(event) => setSystemPrompt(event.target.value)}
                rows={4}
              />
            </label>

            <label className="field-card field-span-2">
              <span>User prompt</span>
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                rows={4}
                required
              />
            </label>

            <label className="field-card">
              <span>Response format</span>
              <textarea
                className="compact-textarea"
                value={responseFormat}
                onChange={(event) => setResponseFormat(event.target.value)}
                rows={4}
                placeholder="Example: Return valid JSON with keys title, summary, and tags."
              />
              <small className="field-hint">
                Adds an explicit instruction describing the required output structure.
              </small>
            </label>
          </div>

          <div className="control-row control-row-tertiary">
            <label className="field-card">
              <span>Temperature</span>
              <input
                type="number"
                step="0.1"
                min="0"
                max="2"
                value={temperature}
                onChange={(event) => setTemperature(event.target.value)}
              />
            </label>

            <label className="field-card">
              <span>Max tokens</span>
              <input
                type="number"
                min="1"
                max="4096"
                value={maxTokens}
                onChange={(event) => setMaxTokens(event.target.value)}
              />
            </label>

            <label className="field-card">
              <span>Length limit</span>
              <input
                type="text"
                value={responseLength}
                onChange={(event) => setResponseLength(event.target.value)}
                placeholder="Example: No more than 60 words."
              />
            </label>

            <label className="field-card">
              <span>Stop sequence</span>
              <input
                type="text"
                value={stopSequence}
                onChange={(event) => setStopSequence(event.target.value)}
                placeholder="Example: END"
              />
            </label>

            <label className="field-card field-span-2">
              <span>Completion instruction</span>
              <textarea
                className="compact-textarea"
                value={completionInstruction}
                onChange={(event) => setCompletionInstruction(event.target.value)}
                rows={3}
                placeholder="Example: End the response right after the final bullet point."
              />
              <small className="field-hint">
                Use this when you want an explicit finish condition in addition to or instead of a
                stop sequence.
              </small>
            </label>

            <div className="field-card toggle-card">
              <span>Reasoning</span>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={reasoningEnabled}
                  onChange={(event) => setReasoningEnabled(event.target.checked)}
                />
                <span>Enable reasoning</span>
              </label>
            </div>

            <label className="field-card">
              <span>Reasoning effort</span>
              <select
                value={reasoningEffort}
                onChange={(event) => setReasoningEffort(event.target.value)}
                disabled={!reasoningEnabled}
              >
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </select>
            </label>

            <div className="action-card">
              <button type="submit" disabled={loading || restoringConversation}>
                {loading ? "Working..." : "Send request"}
              </button>
              <button
                className="secondary-action"
                type="button"
                onClick={handleClearContext}
                disabled={loading || restoringConversation || conversationHistory.length === 0}
              >
                Clear context
              </button>
              <small className="field-hint">
                Context messages: {conversationHistory.length}
              </small>
              <small className="field-hint">Prompt tokens in context: {sessionPromptTokens}</small>
              {activeConversationId ? (
                <small className="field-hint">
                  Conversation ID: <code>{activeConversationId}</code>
                </small>
              ) : null}
            </div>
          </div>
        </form>

        <section className="panel output-panel">
          <div className="status-line">
            <strong>{restoringConversation ? "Restoring context..." : response.status}</strong>
            {response.meta ? <span>{response.meta}</span> : null}
          </div>
          <div className="output-content">{buildOutputText(response, restoringConversation)}</div>
          {response.error ? <p className="error">{response.error}</p> : null}
        </section>
      </section>
    </main>
  );
}

function buildHeaders(serviceKey: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${serviceKey}`
  };
}

function toClientErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected client error.";

  if (message.startsWith("Unauthorized.")) {
    return "401 Unauthorized: the key in the form does not match SERVICE_API_KEY from .env.local.";
  }

  return message;
}

function formatApiError(status: number, payload: ApiErrorPayload | null) {
  const message = payload?.error ?? `Request failed with status ${status}.`;
  const details = formatErrorDetails(payload?.details);

  return details ? `${message} Details: ${details}` : message;
}

function formatErrorDetails(details: unknown) {
  if (typeof details === "string") {
    return details;
  }

  if (!details || typeof details !== "object") {
    return "";
  }

  return Object.entries(details as Record<string, unknown>)
    .flatMap(([key, value]) => {
      if (value === undefined || value === null || value === "") {
        return [];
      }

      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return [`${key}: ${String(value)}`];
      }

      return [`${key}: ${JSON.stringify(value)}`];
    })
    .join("; ");
}

function parseSseEvent(chunk: string) {
  const lines = chunk.split(/\r?\n/);
  let event = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  try {
    return {
      event,
      data: JSON.parse(dataLines.join("\n")) as Record<string, unknown>
    };
  } catch {
    return null;
  }
}

function splitClientSseEvents(buffer: string) {
  return buffer.split(/\r?\n\r?\n/);
}

function applyParsedSseEvent(
  eventChunk: string,
  setResponse: Dispatch<SetStateAction<ResponseState>>,
  onDelta?: (content: string) => void,
  onUsage?: (promptTokens: number) => void,
  onConversationId?: (conversationId: string) => void
) {
  const parsed = parseSseEvent(eventChunk);
  if (!parsed) {
    return;
  }

  if (parsed.event === "meta") {
    if (typeof parsed.data.conversationId === "string") {
      onConversationId?.(parsed.data.conversationId);
    }

    setResponse((current) => ({
      ...current,
      meta: parsed.data.model ? `Model: ${parsed.data.model}` : current.meta
    }));
  }

  if (parsed.event === "delta") {
    const content = typeof parsed.data.content === "string" ? parsed.data.content : "";
    onDelta?.(content);
    setResponse((current) => ({
      ...current,
      reply: current.reply + content
    }));
  }

  if (parsed.event === "usage") {
    const promptTokens = extractPromptTokens(parsed.data);
    if (promptTokens !== null) {
      onUsage?.(promptTokens);
    }
  }

  if (parsed.event === "error") {
    throw new Error(
      typeof parsed.data.error === "string" ? parsed.data.error : "Streaming upstream error."
    );
  }

  if (parsed.event === "done") {
    setResponse((current) => ({
      ...current,
      status: "Completed"
    }));
  }
}

function flushClientSseBuffer(
  buffer: string,
  setResponse: Dispatch<SetStateAction<ResponseState>>,
  onDelta?: (content: string) => void,
  onUsage?: (promptTokens: number) => void,
  onConversationId?: (conversationId: string) => void
) {
  const trimmedBuffer = buffer.trim();
  if (!trimmedBuffer) {
    return;
  }

  for (const eventChunk of splitClientSseEvents(trimmedBuffer)) {
    applyParsedSseEvent(eventChunk, setResponse, onDelta, onUsage, onConversationId);
  }
}

function extractPromptTokens(value: unknown) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const promptTokens = (value as { prompt_tokens?: unknown; promptTokens?: unknown }).prompt_tokens
    ?? (value as { prompt_tokens?: unknown; promptTokens?: unknown }).promptTokens;

  if (typeof promptTokens !== "number" || !Number.isFinite(promptTokens) || promptTokens < 0) {
    return null;
  }

  return promptTokens;
}

function appendConversationTurn(
  history: ConversationMessage[],
  userPrompt: string,
  assistantReply: string
) {
  const nextHistory: ConversationMessage[] = [...history, { role: "user", content: userPrompt }];

  if (assistantReply.trim()) {
    nextHistory.push({ role: "assistant", content: assistantReply });
  }

  return nextHistory;
}

function buildRequestBody(input: {
  activeConversationId: string;
  completionInstruction: string;
  maxTokens: string;
  prompt: string;
  reasoningEffort: string;
  reasoningEnabled: boolean;
  responseFormat: string;
  responseLength: string;
  selectedModel: string;
  stopSequence: string;
  systemPrompt: string;
  temperature: string;
}): ChatRequestPayload {
  const numericTemperature = Number(input.temperature);
  const numericMaxTokens = Number(input.maxTokens);

  return {
    prompt: input.prompt,
    conversationId: input.activeConversationId || undefined,
    model: input.selectedModel || undefined,
    systemPrompt: input.systemPrompt.trim() || undefined,
    responseFormat: input.responseFormat.trim() || undefined,
    responseLength: input.responseLength.trim() || undefined,
    completionInstruction: input.completionInstruction.trim() || undefined,
    stopSequences: input.stopSequence.trim() ? [input.stopSequence.trim()] : undefined,
    temperature: Number.isFinite(numericTemperature) ? numericTemperature : undefined,
    maxTokens: Number.isFinite(numericMaxTokens) ? numericMaxTokens : undefined,
    reasoning: input.reasoningEnabled
      ? {
          enabled: true,
          effort: input.reasoningEffort
        }
      : undefined
  };
}

function buildOutputText(response: ResponseState, restoringConversation: boolean) {
  if (response.reply) {
    return response.reply;
  }

  if (restoringConversation) {
    return "Loading the saved conversation from the server.";
  }

  if (response.status === "Completed" && !response.error) {
    return "The model returned an empty response.";
  }

  return "The model response will appear here.";
}
