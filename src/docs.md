# API Documentation

This is a lightweight AI proxy providing access to language models and embeddings through an OpenAI-compatible API.

## Quick Start

### Get an API key

Create an API key from your [dashboard](/dashboard). Give it a descriptive name and make sure not to share it!

<video controls width="100%" src="https://hc-cdn.hel1.your-objectstorage.com/s/v3/620e1c22bd7dd2b81ca871353636f8d0afa27fed_screen_recording_2025-11-19_at_21.40.33.mp4" class="shadow-md rounded-md" autoplay muted></video>

### Make your first request

Now you're ready to make your first request! Here's an example using curl and JavaScript.

#### Bash

```bash
curl {{BASE_URL}}/proxy/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "{{FIRST_LANGUAGE_MODEL}}",
    "messages": [
      {"role": "user", "content": "Tell me a joke."}
    ]
  }'
```

#### JavaScript (OpenAI SDK)

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'YOUR_API_KEY',
  baseURL: '{{BASE_URL}}/proxy/v1',
});

const response = await client.chat.completions.create({
  model: '{{FIRST_LANGUAGE_MODEL}}',
  messages: [
    { role: 'user', content: 'Tell me a joke.' }
  ],
});

console.log(response.choices[0].message.content);
```

#### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(
    api_key="YOUR_API_KEY",
    base_url="{{BASE_URL}}/proxy/v1"
)

response = client.chat.completions.create(
    model="{{FIRST_LANGUAGE_MODEL}}",
    messages=[
        {"role": "user", "content": "Tell me a joke."}
    ]
)

print(response.choices[0].message["content"])
```

## Authentication

All API requests require authentication using an API key in the Authorization header as a Bearer token:

```
Authorization: Bearer YOUR_API_KEY
```

API keys can be created and managed from your dashboard. You can have up to 50 active API keys.

## API endpoints

### Chat completions

`POST /proxy/v1/chat/completions`

Create a chat completion for the given conversation (aka prompting the AI). Supports streaming and non-streaming modes.

#### Request body
```json
{
  "model": "string",              // Required: Model ID
  "messages": [                   // Required: Array of messages
    {
      "role": "user|assistant|system",
      "content": "string"
    }
  ],
  "stream": false,                // Optional: Enable streaming
  "temperature": 1.0,             // Optional: 0-2, controls randomness
  "max_tokens": null,             // Optional: Max tokens to generate
  "top_p": 1.0                    // Optional: Nucleus sampling
}
```

#### Example response
```json
{
  "id": "chatcmpl-123",
  "object": "chat.completion",
  "created": 1677652288,
  "model": "{{FIRST_LANGUAGE_MODEL}}",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Why did the scarecrow win an award? Because he was outstanding in his field!"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 20,
    "completion_tokens": 15,
    "total_tokens": 35
  }
}
```

### Embeddings

`POST /proxy/v1/embeddings`

Generate vector embeddings from text input. You can then store these embeddings in a vector database (like Pinecone or [pgvector](https://github.com/pgvector/pgvector)).

#### Example request
```bash
curl {{BASE_URL}}/proxy/v1/embeddings \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "{{FIRST_EMBEDDING_MODEL}}",
    "input": "The quick brown fox jumps over the lazy dog"
  }'
```

### Get available models

`GET /proxy/v1/models`

List all available models. No authentication required.

#### Example request
```bash
curl {{BASE_URL}}/proxy/v1/models
```

#### Example response

This endpoint is OpenAI compatible, so the response format is the same as the [OpenAI models endpoint](https://platform.openai.com/docs/api-reference/models/list).

### Token stats

`GET /proxy/v1/stats`

Get token usage statistics for your account.

#### Example request
```bash
curl {{BASE_URL}}/proxy/v1/stats \
  -H "Authorization: Bearer YOUR_API_KEY"
```

#### Example response
```json
{
  "totalRequests": 123456,
  "totalTokens": 7890,
  "totalPromptTokens": 1234,
  "totalCompletionTokens": 5678
}
```

## Rules

- **For teens.** This service is for teens 18 and under only. Hack Club is a charity - please do not abuse this service.
- **No coding agents.** For now, you are not allowed to use this service with coding agents like Cursor.
- **No proxies.** You are not allowed to use this service to create proxies or other tools that allow others to access the API without them also abiding by these rules.
- **No resale.** You are not allowed to resell this service or use it to create a service that resells AI to others.
- **Follow the Code of Conduct.** You are not allowed to use this service to create tools that intentionally violate the [Code of Conduct](https://hackclub.com/conduct). And don't try to generate explicit imagery or text, malware, or other harmful content.
