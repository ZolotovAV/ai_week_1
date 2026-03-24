# Agent Compliance Check Plan

## Goal
Verify that the application satisfies the requirement for a simple agent that:
- accepts a user request;
- sends it to an LLM through an API;
- receives a response;
- displays the result in the interface;
- encapsulates request/response logic inside a separate agent entity rather than a single direct API call.

## Final Decision Rules
- `Compliant`: all functional checks pass and the LLM interaction is wrapped in a dedicated agent abstraction.
- `Partially compliant`: the end-to-end flow works, but the agent abstraction is missing or weak.
- `Not compliant`: one or more core flow requirements fail.

## Shared Evidence To Inspect
- [components/chat-console.tsx](/C:/Users/Lenovo/Documents/AI%20Advent/1%20week/task%201/components/chat-console.tsx)
- [app/api/chat/route.ts](/C:/Users/Lenovo/Documents/AI%20Advent/1%20week/task%201/app/api/chat/route.ts)
- [app/api/chat/stream/route.ts](/C:/Users/Lenovo/Documents/AI%20Advent/1%20week/task%201/app/api/chat/stream/route.ts)
- [lib/openrouter.ts](/C:/Users/Lenovo/Documents/AI%20Advent/1%20week/task%201/lib/openrouter.ts)
- [lib/types.ts](/C:/Users/Lenovo/Documents/AI%20Advent/1%20week/task%201/lib/types.ts)
- [lib/config.ts](/C:/Users/Lenovo/Documents/AI%20Advent/1%20week/task%201/lib/config.ts)

## Agent Tasks

### Agent
`analyst`

### Goal
Translate the business requirement into precise architectural acceptance criteria.

### Files to inspect
- [components/chat-console.tsx](/C:/Users/Lenovo/Documents/AI%20Advent/1%20week/task%201/components/chat-console.tsx)
- [app/api/chat/route.ts](/C:/Users/Lenovo/Documents/AI%20Advent/1%20week/task%201/app/api/chat/route.ts)
- [lib/openrouter.ts](/C:/Users/Lenovo/Documents/AI%20Advent/1%20week/task%201/lib/openrouter.ts)

### Checks
- Map each requirement to a concrete code location.
- Confirm the minimum required flow: `user input -> local backend -> LLM API -> UI output`.
- Define what counts as a separate agent entity for this task.
- Flag ambiguous cases where a helper/service might be mistaken for an agent.

### Expected output
- A `Requirement Mapping` table with columns: `Requirement`, `Evidence`, `Status`, `Notes`.

---

### Agent
`backend_expert`

### Goal
Verify the server-side LLM invocation path and determine whether an agent abstraction exists in backend code.

### Files to inspect
- [app/api/chat/route.ts](/C:/Users/Lenovo/Documents/AI%20Advent/1%20week/task%201/app/api/chat/route.ts)
- [app/api/chat/stream/route.ts](/C:/Users/Lenovo/Documents/AI%20Advent/1%20week/task%201/app/api/chat/stream/route.ts)
- [lib/openrouter.ts](/C:/Users/Lenovo/Documents/AI%20Advent/1%20week/task%201/lib/openrouter.ts)
- [lib/config.ts](/C:/Users/Lenovo/Documents/AI%20Advent/1%20week/task%201/lib/config.ts)
- [lib/types.ts](/C:/Users/Lenovo/Documents/AI%20Advent/1%20week/task%201/lib/types.ts)

### Checks
- Confirm that the backend, not the browser, calls the external LLM API.
- Confirm that server-side secrets are used for the upstream request.
- Confirm that request validation and response normalization are present.
- Determine whether the code exposes a dedicated agent abstraction such as `agent.run`, `agent.respond`, `Agent`, `Assistant`, or equivalent.
- Mark the result as partial if the architecture is only `route -> service/helper -> upstream`.

### Expected output
- `Backend Findings` with one verdict per criterion and a short architecture summary.

---

### Agent
`frontend_expert`

### Goal
Verify the user-facing flow from prompt entry to rendering the model response.

### Files to inspect
- [components/chat-console.tsx](/C:/Users/Lenovo/Documents/AI%20Advent/1%20week/task%201/components/chat-console.tsx)
- [app/page.tsx](/C:/Users/Lenovo/Documents/AI%20Advent/1%20week/task%201/app/page.tsx)

### Checks
- Confirm that the user can enter a prompt and submit it.
- Confirm that the UI sends requests only to local API endpoints.
- Confirm that successful LLM output is rendered in the interface.
- Confirm that error states are rendered to the user.
- Confirm that the UI does not contain provider-specific upstream logic.

### Expected output
- `Frontend Findings` with pass/fail for input, submission, rendering, and error handling.

---

### Agent
`qa`

### Goal
Define execution scenarios that prove or disprove compliance.

### Files to inspect
- [components/chat-console.tsx](/C:/Users/Lenovo/Documents/AI%20Advent/1%20week/task%201/components/chat-console.tsx)
- [app/api/chat/route.ts](/C:/Users/Lenovo/Documents/AI%20Advent/1%20week/task%201/app/api/chat/route.ts)
- [app/api/chat/stream/route.ts](/C:/Users/Lenovo/Documents/AI%20Advent/1%20week/task%201/app/api/chat/stream/route.ts)

### Checks
- Happy path for JSON mode.
- Happy path for streaming mode.
- Invalid or missing service key.
- Empty prompt or invalid payload.
- Upstream error handling.
- Architectural smoke check for presence or absence of an explicit agent layer.

### Expected output
- `Test Scenarios` with steps and expected results.

---

### Agent
`senior_reviewer`

### Goal
Combine the findings into a final compliance verdict.

### Files to inspect
- Outputs from `analyst`, `backend_expert`, `frontend_expert`, and `qa`.
- Core implementation files when needed for tie-breaking.

### Checks
- Validate that the requirement interpretation is consistent across all findings.
- Decide whether the implementation contains a true agent abstraction or only transport/service logic.
- List blocking gaps preventing full compliance.
- Recommend the minimum changes required to reach `Compliant` if the result is partial or failing.

### Expected output
- `Final Verdict` with status, blocking issues, and required follow-up changes.

## Required Reporting Format
Each agent should report in the same structure:
- `Agent`
- `Goal`
- `Files inspected`
- `Checks performed`
- `Findings`
- `Verdict`

## Minimum Scenarios To Cover
1. User enters a prompt and submits it from the UI.
2. The request goes through a local backend endpoint.
3. The backend calls the external LLM API.
4. The LLM response is returned and rendered in the UI.
5. The request/response logic is encapsulated in a dedicated agent entity.
6. Failure cases do not break the user flow or expose secrets.

## Current Working Assumption
Based on the current codebase, the functional flow likely passes, but the implementation may only be `partially compliant` because the code clearly contains an LLM integration layer yet does not obviously define a dedicated agent abstraction.
