# Token Accounting Plan

## Summary

- Add server-side token accounting for the current request, conversation history, and model response.
- Return both local `estimated` counts and provider `actual` usage when available.
- Surface soft guardrails in the UI so token pressure visibly affects agent behavior without trimming history.

## Implementation

- Add `lib/token-usage.ts` for token estimation, usage normalization, and guardrail derivation.
- Extend `ServerConfig` with `OPENROUTER_MODEL_CONTEXT_WINDOWS`.
- Return `tokenUsage` from `POST /api/chat` and include it in `meta` / `usage` events for `POST /api/chat/stream`.
- Update the chat console to display current-request tokens, history tokens, prompt totals, response tokens, and guardrail explanations.

## Guardrails

- `warning` when history share is high or prompt size is becoming large for the selected model.
- `near_limit` when prompt plus requested completion approaches the configured context window.
- No automatic truncation or blocking in v1; the agent explains pressure instead.

## Verification

- Validate JSON mode with and without history.
- Validate SSE mode with estimate-first and actual-usage updates.
- Validate missing upstream usage fallback.
- Validate model context window fallback to `8192`.
