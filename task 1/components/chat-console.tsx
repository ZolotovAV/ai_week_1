"use client";

import type { Dispatch, FormEvent, SetStateAction } from "react";
import { useEffect, useRef, useState } from "react";

import { DEFAULT_CONTEXT_WINDOW } from "@/lib/model-context";
import type { TokenGuardrailReason, TokenUsage } from "@/lib/types";

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
  maxTokensLimit: number;
};

type ApiErrorPayload = {
  details?: unknown;
  error?: string;
};

type ConversationMessage = {
  content: string;
  role: "assistant" | "user";
};

type ChatResponsePayload = {
  conversationId?: string;
  error?: string;
  details?: unknown;
  model?: string;
  reply?: string;
  tokenUsage?: TokenUsage;
  usage?: Record<string, unknown>;
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
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  const [loading, setLoading] = useState(false);
  const lastRestoreAttemptRef = useRef("");
  const [response, setResponse] = useState<ResponseState>({
    reply: "",
    status: "Idle",
    meta: "",
    error: ""
  });
  const selectedModelOption =
    availableModels.find((model) => model.id === selectedModel) ??
    availableModels.find((model) => model.isDefault) ??
    null;
  const selectedModelMaxTokens = selectedModelOption?.maxTokensLimit ?? DEFAULT_CONTEXT_WINDOW;
  const liveTokenBudget = estimateLiveTokenBudget({
    completionInstruction,
    conversationHistory,
    maxTokens,
    prompt,
    responseFormat,
    responseLength,
    selectedModelMaxTokens,
    stopSequence,
    systemPrompt
  });
  const requestedMaxTokens = liveTokenBudget.requestedMaxTokens;
  const isMaxTokensLimitExceeded =
    requestedMaxTokens !== null && requestedMaxTokens > liveTokenBudget.availableBudget;
  const exceededTokens = isMaxTokensLimitExceeded
    ? requestedMaxTokens - liveTokenBudget.availableBudget
    : 0;
  const submitButtonLabel = loading
    ? "Working..."
    : isMaxTokensLimitExceeded
      ? `Limit exceeded by ${formatTokenCount(exceededTokens)}`
      : "Send request";
  const latestResponseTokens = tokenUsage?.response.actual ?? tokenUsage?.response.estimated ?? null;
  const latestPromptActualTokens = tokenUsage?.request.prompt.actual ?? null;
  const guardrailInlineSummary = tokenUsage
    ? buildGuardrailInlineSummary(tokenUsage)
    : isMaxTokensLimitExceeded
      ? `Requested completion exceeds the remaining budget by ${formatTokenCount(exceededTokens)} tokens.`
      : `Available response budget: ${formatTokenCount(liveTokenBudget.availableBudget)} tokens.`;
  const tokenSummaryRows = [
    {
      detail: "Estimated prompt tokens from the current input.",
      metric: "Current request",
      value: formatTokenCount(liveTokenBudget.currentRequestTokens)
    },
    {
      detail: "Estimated tokens already carried from earlier user and assistant turns.",
      metric: "History",
      value: formatTokenCount(liveTokenBudget.historyTokens)
    },
    {
      detail: `Current estimate for the next prompt. Last actual: ${formatNullableTokenCount(latestPromptActualTokens)}.`,
      metric: "Next total",
      value: formatTokenCount(liveTokenBudget.promptTokensEstimated)
    },
    {
      detail: "Last response tokens. Updates after the model completes this request.",
      metric: "Model response",
      value: formatNullableTokenCount(latestResponseTokens)
    }
  ];

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
            setTokenUsage(null);
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

  useEffect(() => {
    const numericMaxTokens = Number(maxTokens);
    if (!Number.isFinite(numericMaxTokens) || numericMaxTokens <= selectedModelMaxTokens) {
      return;
    }

    setMaxTokens(String(selectedModelMaxTokens));
  }, [maxTokens, selectedModelMaxTokens]);

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
    setTokenUsage(null);
    setResponse({
      reply: "",
      status: "Context cleared",
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

    const payload = (await apiResponse.json().catch(() => null)) as ChatResponsePayload | null;

    if (!apiResponse.ok) {
      throw new Error(formatApiError(apiResponse.status, payload));
    }

    if (typeof payload?.conversationId === "string") {
      persistConversationId(payload.conversationId);
    }

    setConversationHistory((current) =>
      appendConversationTurn(current, submittedPrompt, payload?.reply ?? "")
    );
    setTokenUsage(resolveTokenUsage(payload?.tokenUsage, payload?.usage, payload?.reply ?? ""));
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
          (nextTokenUsage) => {
            setTokenUsage(nextTokenUsage);
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
          (nextTokenUsage) => {
            setTokenUsage(nextTokenUsage);
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
                max={String(selectedModelMaxTokens)}
                value={maxTokens}
                onChange={(event) => setMaxTokens(event.target.value)}
              />
              <small className="field-hint">
                Current model allows up to {formatTokenCount(selectedModelMaxTokens)} total
                tokens. Available response budget right now:{" "}
                {formatTokenCount(liveTokenBudget.availableBudget)}.
              </small>
              {isMaxTokensLimitExceeded ? (
                <small className="field-hint">
                  Requested max tokens exceed the current budget by{" "}
                  {formatTokenCount(exceededTokens)}.
                </small>
              ) : null}
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
                {submitButtonLabel}
              </button>
              <div className="action-support">
                <small className="field-hint action-summary">
                  Context: {conversationHistory.length} saved messages.
                </small>
                <button
                  className="secondary-action subtle-action"
                  type="button"
                  onClick={handleClearContext}
                  disabled={loading || restoringConversation || conversationHistory.length === 0}
                >
                  Clear context
                </button>
              </div>
              <small className="field-hint action-note">
                Clears saved history only. Request estimates are shown below.
              </small>
            </div>
          </div>
        </form>

        <section className="panel output-panel">
          <div className="status-line">
            <strong>{restoringConversation ? "Restoring context..." : response.status}</strong>
            {response.meta ? <span>{response.meta}</span> : null}
            {tokenUsage ? (
              <span className={`guardrail-pill guardrail-${tokenUsage.guardrail.status}`}>
                {formatGuardrailStatus(tokenUsage.guardrail.status)}
              </span>
            ) : null}
            <span className="status-detail">{guardrailInlineSummary}</span>
          </div>
          <section className="token-summary" aria-label="Token usage">
            <table className="token-table" aria-label="Token usage summary">
              <thead>
                <tr>
                  <th scope="col">Metric</th>
                  <th scope="col">Value</th>
                  <th scope="col">Detail</th>
                </tr>
              </thead>
              <tbody>
                {tokenSummaryRows.map((row) => (
                  <tr key={row.metric}>
                    <td className="token-metric">{row.metric}</td>
                    <td className="token-value">{row.value}</td>
                    <td className="token-detail">{row.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          {activeConversationId ? (
            <p className="field-hint output-meta token-footer">
              Conversation ID: <code>{activeConversationId}</code>
            </p>
          ) : null}
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
  onTokenUsage?: (tokenUsage: TokenUsage) => void,
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

    const tokenUsage = extractTokenUsage(parsed.data.tokenUsage);
    if (tokenUsage) {
      onTokenUsage?.(tokenUsage);
    }
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
    const tokenUsage =
      extractTokenUsage(parsed.data.tokenUsage)
      ?? resolveTokenUsage(undefined, parsed.data.usage, "");

    if (tokenUsage) {
      onTokenUsage?.(tokenUsage);
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
  onTokenUsage?: (tokenUsage: TokenUsage) => void,
  onConversationId?: (conversationId: string) => void
) {
  const trimmedBuffer = buffer.trim();
  if (!trimmedBuffer) {
    return;
  }

  for (const eventChunk of splitClientSseEvents(trimmedBuffer)) {
    applyParsedSseEvent(eventChunk, setResponse, onDelta, onTokenUsage, onConversationId);
  }
}

function readNumber(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }

  return value;
}

function extractTokenUsage(value: unknown) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as {
    guardrail?: unknown;
    request?: unknown;
    response?: unknown;
    totals?: unknown;
  };

  if (
    !record.request ||
    typeof record.request !== "object" ||
    !record.response ||
    typeof record.response !== "object" ||
    !record.totals ||
    typeof record.totals !== "object" ||
    !record.guardrail ||
    typeof record.guardrail !== "object"
  ) {
    return null;
  }

  return value as TokenUsage;
}

function resolveTokenUsage(
  tokenUsage: TokenUsage | undefined,
  usage: unknown,
  reply: string
): TokenUsage | null {
  if (tokenUsage) {
    return tokenUsage;
  }

  if (!usage || typeof usage !== "object") {
    return null;
  }

  const promptTokens = readNumber(
    (usage as { prompt_tokens?: unknown; promptTokens?: unknown }).prompt_tokens
      ?? (usage as { prompt_tokens?: unknown; promptTokens?: unknown }).promptTokens
  );
  const completionTokens = readNumber(
    (usage as { completion_tokens?: unknown; completionTokens?: unknown }).completion_tokens
      ?? (usage as { completion_tokens?: unknown; completionTokens?: unknown }).completionTokens
  );
  const totalTokens = readNumber(
    (usage as { total_tokens?: unknown; totalTokens?: unknown }).total_tokens
      ?? (usage as { total_tokens?: unknown; totalTokens?: unknown }).totalTokens
  );

  if (promptTokens === null && completionTokens === null && totalTokens === null) {
    return null;
  }

  const estimatedResponseTokens = reply.trim()
    ? Math.max(1, Math.ceil(reply.length / 4))
    : 0;

  return {
    request: {
      current: {
        estimated: 0
      },
      history: {
        estimated: 0
      },
      system: {
        estimated: 0
      },
      prompt: {
        estimated: promptTokens ?? 0,
        actual: promptTokens
      }
    },
    response: {
      requestedMax: null,
      availableBudget: 0,
      estimated: estimatedResponseTokens,
      actual: completionTokens
    },
    totals: {
      estimated: (promptTokens ?? 0) + estimatedResponseTokens,
      actual: totalTokens
    },
    guardrail: {
      status: "ok",
      reasons: [] as TokenGuardrailReason[],
      historyShare: 0,
      contextWindow: 0,
      estimatedContextUsageRatio: 0
    }
  };
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

function estimateLiveTokenBudget(input: {
  completionInstruction: string;
  conversationHistory: ConversationMessage[];
  maxTokens: string;
  prompt: string;
  responseFormat: string;
  responseLength: string;
  selectedModelMaxTokens: number;
  stopSequence: string;
  systemPrompt: string;
}) {
  const systemInstruction = buildSystemInstructionPreview({
    completionInstruction: input.completionInstruction,
    responseFormat: input.responseFormat,
    responseLength: input.responseLength,
    stopSequence: input.stopSequence,
    systemPrompt: input.systemPrompt
  });
  const messages: Array<ConversationMessage | { role: "system"; content: string }> = [
    ...(systemInstruction ? [{ role: "system" as const, content: systemInstruction }] : []),
    ...input.conversationHistory,
    { role: "user", content: input.prompt }
  ];
  const lastUserMessageIndex = messages.reduce(
    (lastIndex, message, index) => (message.role === "user" ? index : lastIndex),
    -1
  );
  let currentRequestTokens = 0;
  let historyTokens = 0;
  let systemTokens = 0;

  for (const [index, message] of messages.entries()) {
    const estimatedTokens = estimateMessageTokens(message.role, message.content);

    if (message.role === "system") {
      systemTokens += estimatedTokens;
      continue;
    }

    if (message.role === "assistant") {
      historyTokens += estimatedTokens;
      continue;
    }

    if (index === lastUserMessageIndex) {
      currentRequestTokens = estimatedTokens;
      continue;
    }

    historyTokens += estimatedTokens;
  }

  const promptTokensEstimated = currentRequestTokens + historyTokens + systemTokens + 2;
  const requestedMaxTokens = toFinitePositiveInteger(input.maxTokens);
  const availableBudget = Math.max(0, input.selectedModelMaxTokens - promptTokensEstimated);

  return {
    availableBudget,
    currentRequestTokens,
    historyTokens,
    promptTokensEstimated,
    requestedMaxTokens
  };
}

function buildSystemInstructionPreview(input: {
  completionInstruction: string;
  responseFormat: string;
  responseLength: string;
  stopSequence: string;
  systemPrompt: string;
}) {
  const instructions = [
    input.systemPrompt.trim() || undefined,
    input.responseFormat.trim()
      ? `Return the answer in this exact format: ${input.responseFormat.trim()}`
      : undefined,
    input.responseLength.trim()
      ? `Keep the entire answer within this limit: ${input.responseLength.trim()}`
      : undefined,
    input.completionInstruction.trim()
      ? `Finish the answer when this condition is met: ${input.completionInstruction.trim()}`
      : undefined,
    input.stopSequence.trim()
      ? `Stop generating immediately if you are about to output any of these sequences: ${JSON.stringify(input.stopSequence.trim())}`
      : undefined
  ].filter((instruction): instruction is string => Boolean(instruction));

  return instructions.length > 0 ? instructions.join("\n\n") : undefined;
}

function estimateMessageTokens(role: "assistant" | "system" | "user", content: string) {
  return 4 + estimateTextTokens(role) + estimateTextTokens(content);
}

function estimateTextTokens(text: string) {
  const normalized = text.trim();
  if (!normalized) {
    return 0;
  }

  const segments = normalized.match(/\p{L}+|\p{N}+|[^\s]/gu) ?? [];
  if (segments.length === 0) {
    return Math.max(1, Math.ceil(readUtf8ByteLength(normalized) / 4));
  }

  return segments.reduce((total, segment) => {
    if (/^[\p{L}\p{N}]+$/u.test(segment)) {
      return total + Math.max(1, Math.ceil(readUtf8ByteLength(segment) / 4));
    }

    return total + 1;
  }, 0);
}

function readUtf8ByteLength(value: string) {
  return new TextEncoder().encode(value).length;
}

function toFinitePositiveInteger(value: string) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return null;
  }

  return Math.round(numericValue);
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

function formatTokenCount(value: number) {
  return Intl.NumberFormat("en-US").format(value);
}

function formatNullableTokenCount(value: number | null) {
  return value === null ? "n/a" : formatTokenCount(value);
}

function formatGuardrailStatus(status: TokenUsage["guardrail"]["status"]) {
  if (status === "near_limit") {
    return "Near context limit";
  }

  if (status === "warning") {
    return "Watch context";
  }

  return "Context healthy";
}

function formatGuardrailReason(reason: TokenGuardrailReason) {
  switch (reason) {
    case "history_dominates_request":
      return "Earlier messages now outweigh the new request.";
    case "prompt_near_context_limit":
      return "This prompt is already getting large for the selected model.";
    case "total_near_context_limit":
      return "Prompt plus requested completion is close to the model context window.";
    case "requested_completion_exceeds_available_budget":
      return "Requested completion is larger than the remaining context budget.";
    default:
      return "Token pressure is affecting the agent.";
  }
}

function buildGuardrailInlineSummary(tokenUsage: TokenUsage) {
  const reasons = tokenUsage.guardrail.reasons;
  const historyShare = Math.round(tokenUsage.guardrail.historyShare * 100);

  if (reasons.length === 0) {
    return `Current prompt fits comfortably within the model context budget. ${formatTokenCount(tokenUsage.response.availableBudget)} response tokens remain available.`;
  }

  return `${reasons.map(formatGuardrailReason).join(" ")} History share: ${historyShare}%.`;
}
