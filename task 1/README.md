# Nemotron OpenRouter Service

Веб-сервис на `Next.js`, который принимает запросы к своей API, отправляет их в OpenRouter на модель `nvidia/nemotron-3-super-120b-a12b:free` и возвращает ответ клиенту.

В проекте есть:

- `GET /api/models` для списка доступных моделей OpenRouter
- `POST /api/chat` для обычного JSON-ответа
- `POST /api/chat/stream` для потокового ответа через SSE
- `GET /api/conversations/:conversationId` для загрузки сохранённой истории
- `DELETE /api/conversations/:conversationId` для удаления сохранённого диалога
- выделенный модуль `lib/chat-agent.ts`, который инкапсулирует request/response lifecycle
- demo UI на `/` для ручной проверки запросов из браузера
- защита API через `Authorization: Bearer <SERVICE_API_KEY>`

## Как это работает

1. Клиент отправляет запрос в ваш сервис.
2. API route выполняет только HTTP-обвязку: проверяет `SERVICE_API_KEY`, парсит JSON и валидирует payload.
3. `chatAgent` выбирает разрешённую модель, собирает system-инструкции и подготавливает upstream-запрос.
4. Сервер использует `OPENROUTER_API_KEY`, вызывает OpenRouter и получает обычный или потоковый ответ.
5. `chatAgent` нормализует ответ и возвращает его клиенту в JSON или `text/event-stream`.

`OPENROUTER_API_KEY` хранится только на сервере и не уходит в браузер.

## Архитектура агента

- `app/api/chat` и `app/api/chat/stream` остаются тонкими маршрутами и отвечают только за HTTP concerns.
- `lib/chat-agent.ts` содержит общую агентную оркестрацию для обычного и потокового режима.
- `lib/openrouter.ts` используется как низкоуровневый транспорт к OpenRouter и маппинг upstream-ошибок.

## Требования

- `Node.js 20+`
- `npm`

## Установка

Установить зависимости:

```bash
npm install
```

## Настройка окружения

В проекте используется файл `.env.local`.

Пример:

```env
OPENROUTER_API_KEY=
SERVICE_API_KEY=your_service_api_key
OPENROUTER_MODEL=nvidia/nemotron-3-super-120b-a12b:free
OPENROUTER_ALLOWED_MODELS=nvidia/nemotron-3-super-120b-a12b:free,openai/gpt-4o-mini,meta-llama/llama-3.3-70b-instruct
OPENROUTER_MODEL_CONTEXT_WINDOWS={"nvidia/nemotron-3-super-120b-a12b:free":8192,"openai/gpt-4o-mini":128000,"meta-llama/llama-3.3-70b-instruct":131072}
OPENROUTER_HTTP_REFERER=http://localhost:3000
OPENROUTER_X_TITLE=OpenRouter Nemotron Service
```

### Что означает каждая переменная

- `OPENROUTER_API_KEY`  
  Ваш ключ OpenRouter. Обязателен.

- `SERVICE_API_KEY`  
  Ваш собственный ключ для доступа к API этого сервиса. Обязателен.

- `OPENROUTER_MODEL`  
  Модель OpenRouter по умолчанию. Используется, если клиент не передал поле `model`.

- `OPENROUTER_ALLOWED_MODELS`  
  Список разрешённых моделей через запятую. UI получает этот список с сервера и позволяет выбирать только эти модели.

- `OPENROUTER_MODEL_CONTEXT_WINDOWS`  
  JSON-объект с окнами контекста по моделям. Используется для локального estimate-подсчёта токенов и soft guardrails в агенте. Если для модели нет записи, агент использует консервативный fallback `8192`.

- `OPENROUTER_HTTP_REFERER`  
  Необязательный заголовок для OpenRouter. Для локальной разработки можно оставить `http://localhost:3000`.

- `OPENROUTER_X_TITLE`  
  Необязательное имя приложения, которое отправляется в OpenRouter.

## Генерация SERVICE_API_KEY

Сгенерировать безопасный ключ можно так:

```bash
npm run generate:service-key
```

Команда выведет строку вида:

```env
SERVICE_API_KEY=svc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Скопируйте это значение в `.env.local`.

## Запуск

Запуск в режиме разработки:

```bash
npm run dev
```

После запуска приложение будет доступно по адресу:

```text
http://localhost:3000
```

Production build:

```bash
npm run build
npm start
```

## Использование через браузер

Откройте:

```text
http://localhost:3000
```

На странице:

1. Вставьте значение `SERVICE_API_KEY` в поле `Service API key`.
2. Заполните `System prompt` при необходимости.
3. Введите пользовательский запрос в `User prompt`.
4. Выберите `OpenRouter model` из серверного списка разрешённых моделей.
5. При необходимости задайте `Response format`, `Length limit`, `Stop sequence` и `Completion instruction`.
6. Выберите режим:
   - `JSON`
   - `Stream (SSE)`
7. При необходимости включите `Enable reasoning`.
8. Нажмите `Send request`.

Если получите `401 Unauthorized`, это означает, что ключ в форме не совпадает со значением `SERVICE_API_KEY` в `.env.local`.

Если вы меняли `.env.local`, перезапустите `npm run dev`.

## API

Оба endpoint требуют заголовок:

```http
Authorization: Bearer <SERVICE_API_KEY>
```

И `Content-Type`:

```http
Content-Type: application/json
```

### GET /api/models

Возвращает список моделей, которые разрешено выбирать из UI и отправлять через API.

Пример ответа:

```json
{
  "defaultModel": "nvidia/nemotron-3-super-120b-a12b:free",
  "models": [
    {
      "id": "nvidia/nemotron-3-super-120b-a12b:free",
      "label": "nvidia/nemotron-3-super-120b-a12b:free",
      "isDefault": true
    },
    {
      "id": "openai/gpt-4o-mini",
      "label": "openai/gpt-4o-mini",
      "isDefault": false
    }
  ]
}
```

### POST /api/chat

Возвращает обычный JSON-ответ. Внутри route передаёт уже валидированный запрос в `chatAgent.respond(...)`.

Пример запроса:

```http
POST /api/chat
Authorization: Bearer <SERVICE_API_KEY>
Content-Type: application/json
```

```json
{
  "conversationId": "optional-uuid-for-existing-dialog",
  "prompt": "Say hello in one sentence.",
  "model": "openai/gpt-4o-mini",
  "systemPrompt": "You are concise.",
  "temperature": 0.7,
  "maxTokens": 256,
  "reasoning": {
    "enabled": true,
    "effort": "medium"
  }
}
```

Пример ответа:

```json
{
  "conversationId": "b5ea0f1e-4d4d-4c2f-8f93-99c7be3ef001",
  "id": "gen-123",
  "model": "nvidia/nemotron-3-super-120b-a12b:free",
  "provider": "openrouter",
  "usage": {
    "prompt_tokens": 12,
    "completion_tokens": 20,
    "total_tokens": 32
  },
  "tokenUsage": {
    "request": {
      "current": { "estimated": 10 },
      "history": { "estimated": 24 },
      "system": { "estimated": 8 },
      "prompt": { "estimated": 44, "actual": 12 }
    },
    "response": {
      "requestedMax": 256,
      "availableBudget": 8148,
      "estimated": 18,
      "actual": 20
    },
    "totals": {
      "estimated": 300,
      "actual": 32
    },
    "guardrail": {
      "status": "warning",
      "reasons": ["history_dominates_request"],
      "historyShare": 0.71,
      "contextWindow": 8192,
      "estimatedContextUsageRatio": 0.04
    }
  },
  "reply": "Hello from the service.",
  "reasoning": {}
}
```

### POST /api/chat/stream

Возвращает поток `text/event-stream`. Внутри route использует тот же агентный слой через `chatAgent.stream(...)`.

Тело запроса такое же, как у `/api/chat`.

События потока:

- `meta` — метаданные потока и стартовый `tokenUsage` estimate, приходит в начале
- `usage` — актуальные usage-данные провайдера и обновлённый `tokenUsage`
- `delta` — очередная часть текста
- `done` — завершение потока
- `error` — ошибка

Пример событий:

```text
event: meta
data: {"conversationId":"b5ea0f1e-4d4d-4c2f-8f93-99c7be3ef001","model":"nvidia/nemotron-3-super-120b-a12b:free","provider":"openrouter","tokenUsage":{"request":{"current":{"estimated":10},"history":{"estimated":24},"system":{"estimated":8},"prompt":{"estimated":44,"actual":null}},"response":{"requestedMax":256,"availableBudget":8148,"estimated":null,"actual":null},"totals":{"estimated":300,"actual":null},"guardrail":{"status":"warning","reasons":["history_dominates_request"],"historyShare":0.71,"contextWindow":8192,"estimatedContextUsageRatio":0.04}}}

event: usage
data: {"usage":{"promptTokens":12,"completionTokens":20,"totalTokens":32},"tokenUsage":{"request":{"current":{"estimated":10},"history":{"estimated":24},"system":{"estimated":8},"prompt":{"estimated":44,"actual":12}},"response":{"requestedMax":256,"availableBudget":8148,"estimated":18,"actual":20},"totals":{"estimated":300,"actual":32},"guardrail":{"status":"warning","reasons":["history_dominates_request"],"historyShare":0.71,"contextWindow":8192,"estimatedContextUsageRatio":0.04}}}

event: delta
data: {"content":"Hello"}

event: delta
data: {"content":" world"}

event: done
data: {"done":true}
```

## Подсчёт токенов и влияние на поведение агента

Агент теперь считает и возвращает три группы метрик:

- токены текущего пользовательского запроса;
- токены истории диалога, реально отправленной в модель;
- токены ответа модели.

Перед запросом к OpenRouter агент рассчитывает `estimated` значения локально. После ответа он дополняет их `actual` usage-значениями провайдера, если они доступны.

Эти метрики влияют на поведение агента через soft guardrails:

- `ok` — контекст комфортный;
- `warning` — история начинает доминировать или prompt становится тяжёлым;
- `near_limit` — prompt вместе с ожидаемым ответом близок к лимиту окна контекста.

Guardrails ничего не обрезают автоматически, но показывают в UI, когда история начинает сильнее влиять на ответ, чем текущий запрос, и когда ответ может упереться в доступный бюджет контекста.

## Формат запроса

Поддерживаемые поля:

- `prompt` — обязательный текст текущего пользовательского запроса
- `conversationId` — необязательный UUID существующего диалога; если передан, агент подтянет сохранённую историю и учтёт её в token usage
- `model` — необязательный id модели OpenRouter из серверного allowlist
- `systemPrompt` — необязательный system prompt
- `responseFormat` — необязательное явное описание формата ответа
- `responseLength` — необязательное ограничение на длину ответа
- `stopSequences` — необязательный массив stop sequence для upstream-запроса
- `completionInstruction` — необязательная явная инструкция, когда завершить ответ
- `temperature` — необязательное число от `0` до `2`
- `maxTokens` — необязательное целое число от `1` до максимума, доступного для выбранной модели из серверной конфигурации
- `reasoning.enabled` — необязательный флаг
- `reasoning.effort` — `low`, `medium` или `high`

Пример минимального тела запроса:

```json
{
  "prompt": "Hello"
}
```

История сообщений не передаётся в теле запроса. Она хранится на сервере и подмешивается агентом автоматически, если клиент передал `conversationId`.

## Один и тот же запрос с разными ограничениями

Ниже один и тот же пользовательский запрос:

```json
{
  "prompt": "Tell me about the benefits of server-side API keys.",
  "model": "nvidia/nemotron-3-super-120b-a12b:free"
}
```

### 1. Явно задать формат ответа

```json
{
  "prompt": "Tell me about the benefits of server-side API keys.",
  "model": "nvidia/nemotron-3-super-120b-a12b:free",
  "responseFormat": "Return Markdown with exactly three bullet points. Each bullet must contain a short title, a colon, and one sentence."
}
```

### 2. Добавить ограничение на длину ответа

```json
{
  "prompt": "Tell me about the benefits of server-side API keys.",
  "model": "nvidia/nemotron-3-super-120b-a12b:free",
  "responseLength": "No more than 45 words total."
}
```

### 3. Добавить условие завершения ответа

Вариант со `stop sequence`:

```json
{
  "prompt": "Tell me about the benefits of server-side API keys.",
  "model": "nvidia/nemotron-3-super-120b-a12b:free",
  "stopSequences": ["<END>"]
}
```

Вариант с явной инструкцией:

```json
{
  "prompt": "Tell me about the benefits of server-side API keys.",
  "model": "nvidia/nemotron-3-super-120b-a12b:free",
  "completionInstruction": "End the response immediately after the third bullet point."
}
```

Можно комбинировать эти поля в одном запросе:

```json
{
  "prompt": "Tell me about the benefits of server-side API keys.",
  "model": "nvidia/nemotron-3-super-120b-a12b:free",
  "responseFormat": "Return Markdown with exactly three bullet points.",
  "responseLength": "No more than 45 words total.",
  "stopSequences": ["<END>"],
  "completionInstruction": "End the response immediately after the third bullet point."
}
```

## Примеры вызова

### curl для JSON

```bash
curl -X POST http://localhost:3000/api/chat ^
  -H "Authorization: Bearer YOUR_SERVICE_API_KEY" ^
  -H "Content-Type: application/json" ^
  -d "{\"prompt\":\"Tell me a joke.\"}"
```

### curl для SSE

```bash
curl -N -X POST http://localhost:3000/api/chat/stream ^
  -H "Authorization: Bearer YOUR_SERVICE_API_KEY" ^
  -H "Content-Type: application/json" ^
  -d "{\"prompt\":\"Count to five.\"}"
```

## Ошибки

Типовые ответы:

- `400` — невалидный JSON или неправильная структура запроса
- `401` — неверный или отсутствующий `SERVICE_API_KEY`
- `429` — лимит OpenRouter
- `500` — ошибка конфигурации сервера
- `502` — ошибка upstream-провайдера
- `504` — таймаут запроса к OpenRouter

## Структура проекта

- `app/` — страницы и API routes Next.js
- `components/` — клиентские UI-компоненты
- `lib/` — конфиг, валидация, auth, агентная оркестрация и OpenRouter-транспорт
- `scripts/` — вспомогательные скрипты

## Полезно знать

- После изменения `.env.local` нужно перезапускать dev-сервер.
- Если у вас появляется ошибка, связанная с `.next`, очистите кэш и запустите снова:

```bash
Remove-Item -Recurse -Force .next
npm run dev
```
