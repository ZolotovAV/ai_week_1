"use client";

import type { Dispatch, FormEvent, SetStateAction } from "react";
import { useEffect, useMemo, useState } from "react";

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

const SERVICE_KEY_STORAGE = "nemotron-service-api-key";

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
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<ResponseState>({
    reply: "",
    status: "Idle",
    meta: "",
    error: ""
  });

  useEffect(() => {
    const savedKey = window.sessionStorage.getItem(SERVICE_KEY_STORAGE);
    if (savedKey) {
      setServiceKey(savedKey);
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

  const requestBody = useMemo(() => {
    const numericTemperature = Number(temperature);
    const numericMaxTokens = Number(maxTokens);

    return {
      messages: [{ role: "user", content: prompt }],
      model: selectedModel || undefined,
      systemPrompt,
      responseFormat: responseFormat.trim() || undefined,
      responseLength: responseLength.trim() || undefined,
      completionInstruction: completionInstruction.trim() || undefined,
      stopSequences: stopSequence.trim() ? [stopSequence.trim()] : undefined,
      temperature: Number.isFinite(numericTemperature) ? numericTemperature : undefined,
      maxTokens: Number.isFinite(numericMaxTokens) ? numericMaxTokens : undefined,
      reasoning: reasoningEnabled
        ? {
            enabled: true,
            effort: reasoningEffort
          }
        : undefined
    };
  }, [
    completionInstruction,
    maxTokens,
    prompt,
    reasoningEffort,
    reasoningEnabled,
    selectedModel,
    responseFormat,
    responseLength,
    stopSequence,
    systemPrompt,
    temperature
  ]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedServiceKey = serviceKey.trim();

    if (!normalizedServiceKey) {
      setResponse({
        reply: "",
        status: "Failed",
        meta: "",
        error: "Enter SERVICE_API_KEY from .env.local before sending a request."
      });
      return;
    }

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
        await submitJson(normalizedServiceKey);
      } else {
        await submitStream(normalizedServiceKey);
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

  async function submitJson(serviceKey: string) {
    const apiResponse = await fetch("/api/chat", {
      method: "POST",
      headers: buildHeaders(serviceKey),
      body: JSON.stringify(requestBody)
    });

    const payload = (await apiResponse.json().catch(() => null)) as
      | {
          reply?: string;
          model?: string;
          usage?: Record<string, unknown>;
          error?: string;
        }
      | null;

    if (!apiResponse.ok) {
      throw new Error(payload?.error ?? `Request failed with status ${apiResponse.status}.`);
    }

    setResponse({
      reply: payload?.reply ?? "",
      status: "Completed",
      meta: payload?.model ? `Model: ${payload.model}` : "",
      error: ""
    });
  }

  async function submitStream(serviceKey: string) {
    const apiResponse = await fetch("/api/chat/stream", {
      method: "POST",
      headers: buildHeaders(serviceKey),
      body: JSON.stringify(requestBody)
    });

    if (!apiResponse.ok || !apiResponse.body) {
      const payload = (await apiResponse.json().catch(() => null)) as { error?: string } | null;
      throw new Error(payload?.error ?? `Streaming failed with status ${apiResponse.status}.`);
    }

    const reader = apiResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        flushClientSseBuffer(buffer, setResponse);
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const parts = splitClientSseEvents(buffer);
      buffer = parts.pop() ?? "";

      for (const eventChunk of parts) {
        applyParsedSseEvent(eventChunk, setResponse);
      }
    }
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

      <section className="grid">
        <form className="panel form-panel" onSubmit={handleSubmit}>
          <label>
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

          <label>
            <span>System prompt</span>
            <textarea
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
              rows={3}
            />
          </label>

          <label>
            <span>User prompt</span>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={8}
              required
            />
          </label>

          <label>
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

          <label>
            <span>Response format</span>
            <textarea
              className="compact-textarea"
              value={responseFormat}
              onChange={(event) => setResponseFormat(event.target.value)}
              rows={3}
              placeholder="Example: Return valid JSON with keys title, summary, and tags."
            />
            <small className="field-hint">
              Adds an explicit instruction describing the required output structure.
            </small>
          </label>

          <div className="options-row constraint-row">
            <label>
              <span>Length limit</span>
              <input
                type="text"
                value={responseLength}
                onChange={(event) => setResponseLength(event.target.value)}
                placeholder="Example: No more than 60 words."
              />
            </label>

            <label>
              <span>Stop sequence</span>
              <input
                type="text"
                value={stopSequence}
                onChange={(event) => setStopSequence(event.target.value)}
                placeholder="Example: END"
              />
            </label>
          </div>

          <label>
            <span>Completion instruction</span>
            <textarea
              className="compact-textarea"
              value={completionInstruction}
              onChange={(event) => setCompletionInstruction(event.target.value)}
              rows={2}
              placeholder="Example: End the response right after the final bullet point."
            />
            <small className="field-hint">
              Use this when you want an explicit finish condition in addition to or instead of a
              stop sequence.
            </small>
          </label>

          <div className="options-row">
            <label>
              <span>Mode</span>
              <select value={mode} onChange={(event) => setMode(event.target.value as Mode)}>
                <option value="json">JSON</option>
                <option value="stream">Stream (SSE)</option>
              </select>
            </label>

            <label>
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

            <label>
              <span>Max tokens</span>
              <input
                type="number"
                min="1"
                max="4096"
                value={maxTokens}
                onChange={(event) => setMaxTokens(event.target.value)}
              />
            </label>
          </div>

          <div className="options-row reasoning-row">
            <label className="toggle">
              <input
                type="checkbox"
                checked={reasoningEnabled}
                onChange={(event) => setReasoningEnabled(event.target.checked)}
              />
              <span>Enable reasoning</span>
            </label>

            <label>
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
          </div>

          <button type="submit" disabled={loading}>
            {loading ? "Working..." : "Send request"}
          </button>
        </form>

        <section className="panel output-panel">
          <div className="status-line">
            <strong>{response.status}</strong>
            {response.meta ? <span>{response.meta}</span> : null}
          </div>
          <pre>{buildOutputText(response)}</pre>
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

  if (message === "Unauthorized.") {
    return "401 Unauthorized: the key in the form does not match SERVICE_API_KEY from .env.local.";
  }

  return message;
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
      data: JSON.parse(dataLines.join("\n")) as Record<string, string>
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
  setResponse: Dispatch<SetStateAction<ResponseState>>
) {
  const parsed = parseSseEvent(eventChunk);
  if (!parsed) {
    return;
  }

  if (parsed.event === "meta") {
    setResponse((current) => ({
      ...current,
      meta: parsed.data.model ? `Model: ${parsed.data.model}` : current.meta
    }));
  }

  if (parsed.event === "delta") {
    setResponse((current) => ({
      ...current,
      reply: current.reply + (parsed.data.content ?? "")
    }));
  }

  if (parsed.event === "error") {
    throw new Error(parsed.data.error ?? "Streaming upstream error.");
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
  setResponse: Dispatch<SetStateAction<ResponseState>>
) {
  const trimmedBuffer = buffer.trim();
  if (!trimmedBuffer) {
    return;
  }

  for (const eventChunk of splitClientSseEvents(trimmedBuffer)) {
    applyParsedSseEvent(eventChunk, setResponse);
  }
}

function buildOutputText(response: ResponseState) {
  if (response.reply) {
    return response.reply;
  }

  if (response.status === "Completed" && !response.error) {
    return "The model returned an empty response.";
  }

  return "The model response will appear here.";
}
