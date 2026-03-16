# Nemotron OpenRouter Service

Веб-сервис на `Next.js`, который принимает запросы к своей API, отправляет их в OpenRouter на модель `nvidia/nemotron-3-super-120b-a12b:free` и возвращает ответ клиенту.

В проекте есть:

- `POST /api/chat` для обычного JSON-ответа
- `POST /api/chat/stream` для потокового ответа через SSE
- demo UI на `/` для ручной проверки запросов из браузера
- защита API через `Authorization: Bearer <SERVICE_API_KEY>`

## Как это работает

1. Клиент отправляет запрос в ваш сервис.
2. Сервис проверяет `SERVICE_API_KEY`.
3. Сервер использует `OPENROUTER_API_KEY` и вызывает OpenRouter.
4. Сервис возвращает нормализованный ответ клиенту.

`OPENROUTER_API_KEY` хранится только на сервере и не уходит в браузер.

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
OPENROUTER_HTTP_REFERER=http://localhost:3000
OPENROUTER_X_TITLE=OpenRouter Nemotron Service
```

### Что означает каждая переменная

- `OPENROUTER_API_KEY`  
  Ваш ключ OpenRouter. Обязателен.

- `SERVICE_API_KEY`  
  Ваш собственный ключ для доступа к API этого сервиса. Обязателен.

- `OPENROUTER_MODEL`  
  Модель OpenRouter. По умолчанию используется `nvidia/nemotron-3-super-120b-a12b:free`.

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
4. Выберите режим:
   - `JSON`
   - `Stream (SSE)`
5. При необходимости включите `Enable reasoning`.
6. Нажмите `Send request`.

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

### POST /api/chat

Возвращает обычный JSON-ответ.

Пример запроса:

```http
POST /api/chat
Authorization: Bearer <SERVICE_API_KEY>
Content-Type: application/json
```

```json
{
  "messages": [
    {
      "role": "user",
      "content": "Say hello in one sentence."
    }
  ],
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
  "id": "gen-123",
  "model": "nvidia/nemotron-3-super-120b-a12b:free",
  "provider": "openrouter",
  "usage": {
    "prompt_tokens": 12,
    "completion_tokens": 20,
    "total_tokens": 32
  },
  "reply": "Hello from the service.",
  "reasoning": {}
}
```

### POST /api/chat/stream

Возвращает поток `text/event-stream`.

Тело запроса такое же, как у `/api/chat`.

События потока:

- `meta` — метаданные потока, приходит в начале
- `delta` — очередная часть текста
- `done` — завершение потока
- `error` — ошибка

Пример событий:

```text
event: meta
data: {"model":"nvidia/nemotron-3-super-120b-a12b:free","provider":"openrouter"}

event: delta
data: {"content":"Hello"}

event: delta
data: {"content":" world"}

event: done
data: {"done":true}
```

## Формат запроса

Поддерживаемые поля:

- `messages` — обязательный массив сообщений
- `systemPrompt` — необязательный system prompt
- `temperature` — необязательное число от `0` до `2`
- `maxTokens` — необязательное целое число от `1` до `4096`
- `reasoning.enabled` — необязательный флаг
- `reasoning.effort` — `low`, `medium` или `high`

Сообщения в `messages` имеют вид:

```json
{
  "role": "user",
  "content": "Hello"
}
```

Поддерживаемые роли:

- `system`
- `user`
- `assistant`

## Примеры вызова

### curl для JSON

```bash
curl -X POST http://localhost:3000/api/chat ^
  -H "Authorization: Bearer YOUR_SERVICE_API_KEY" ^
  -H "Content-Type: application/json" ^
  -d "{\"messages\":[{\"role\":\"user\",\"content\":\"Tell me a joke.\"}]}"
```

### curl для SSE

```bash
curl -N -X POST http://localhost:3000/api/chat/stream ^
  -H "Authorization: Bearer YOUR_SERVICE_API_KEY" ^
  -H "Content-Type: application/json" ^
  -d "{\"messages\":[{\"role\":\"user\",\"content\":\"Count to five.\"}]}"
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
- `lib/` — конфиг, валидация, auth и OpenRouter-логика
- `scripts/` — вспомогательные скрипты

## Полезно знать

- После изменения `.env.local` нужно перезапускать dev-сервер.
- Если у вас появляется ошибка, связанная с `.next`, очистите кэш и запустите снова:

```bash
Remove-Item -Recurse -Force .next
npm run dev
```
