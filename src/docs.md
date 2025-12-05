# API Documentation

This is a lightweight AI proxy providing access to language models and
embeddings through an OpenAI-compatible API.

> All generations are powered by [OpenRouter](https://openrouter.ai) under the
> hood. Request and response formats match OpenRouter's specifics. The below
> documentation is a simplification of the OpenRouter API, please consult the
> [OpenRouter docs](https://openrouter.ai/docs) for more in-depth information on
> request semantics.

## Quick Start

### Get an API key

Create an API key from your [dashboard](/dashboard). Give it a descriptive name
and make sure not to share it!

<video width="100%" src="https://hc-cdn.hel1.your-objectstorage.com/s/v3/620e1c22bd7dd2b81ca871353636f8d0afa27fed_screen_recording_2025-11-19_at_21.40.33.mp4" class="shadow-md rounded-md" autoplay muted loop></video>

### Make your first request

Now you're ready to make your first request! Here's an example using curl and
the official OpenRouter SDKs for JavaScript and Python.

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

#### JavaScript (OpenRouter TypeScript SDK)

```javascript
import { OpenRouter } from "@openrouter/sdk";

const client = new OpenRouter({
  apiKey: "YOUR_API_KEY",
  baseURL: "{{BASE_URL}}/proxy/v1",
  // Optional, but recommended
  // defaultHeaders: {
  //   "HTTP-Referer": "https://your-app-url.example",
  //   "X-Title": "Your App Name",
  // },
});

const response = await client.chat.send({
  model: "{{FIRST_LANGUAGE_MODEL}}",
  messages: [
    { role: "user", content: "Tell me a joke." },
  ],
  stream: false,
});

console.log(response.choices[0].message.content);
```

#### Python (OpenRouter Python SDK)

```python
from openrouter import OpenRouter

client = OpenRouter(
    api_key="YOUR_API_KEY",
    server_url="{{BASE_URL}}/proxy/v1",
)

response = client.chat.send(
    model="{{FIRST_LANGUAGE_MODEL}}",
    messages=[
        {"role": "user", "content": "Tell me a joke."}
    ],
    stream=False,
)

print(response.choices[0].message.content)
```

## Authentication

All API requests require authentication using an API key in the Authorization
header as a Bearer token:

```
Authorization: Bearer YOUR_API_KEY
```

API keys can be created and managed from your dashboard. You can have up to 50
active API keys.

## API endpoints

### Chat completions

`POST /proxy/v1/chat/completions`

Create a chat completion for the given conversation (aka prompting the AI).
Supports streaming and non-streaming modes.

#### Request body

```json
{
  "model": "string", // Required: Model ID
  "messages": [ // Required: Array of messages
    {
      "role": "user|assistant|system",
      "content": "string"
    }
  ],
  "stream": false, // Optional: Enable streaming
  "temperature": 1.0, // Optional: 0-2, controls randomness
  "max_tokens": null, // Optional: Max tokens to generate
  "top_p": 1.0 // Optional: Nucleus sampling
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

#### Image generation

You can generate images via the same chat completions endpoint using
OpenRouter’s image-capable models, such as:

- `google/gemini-2.5-flash-image` (aka Nano Banana)
- `google/gemini-3-pro-image-preview` (aka Nano Banana 3 Pro)

##### Example request (image generation via this proxy)

For image generation the best way to do it is via curl or any `requests` library in your language.

Curl:

```bash
curl {{BASE_URL}}/proxy/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "google/gemini-2.5-flash-image-preview",
    "messages": [
      {
        "role": "user",
        "content": "Make a picture of somebody touching grass (i do not know what it is like)"
      }
    ],
    "modalities": ["image", "text"],
    "image_config": {
      "aspect_ratio": "16:9"
    },
    "stream": false
  }'
```

Python:
```python
import base64
import io
import requests

headers = {
    "Authorization": f"Bearer {AI_API_KEY}",
    "Content-Type": "application/json"
}

payload = {
    "model": "google/gemini-2.5-flash-image",
    "messages": [
        {
            "role": "user",
            "content": prompt
        }
    ],
    "modalities": ["image", "text"],
    "image_config": {
        "aspect_ratio": "16:9"
    }
}

response = requests.post(URL, headers=headers, json=payload)
result = response.json()

if result.get("choices"):
    message = result["choices"][0]["message"]
    if message.get("images"):
        # Assuming one image
        image_url = message["images"][0]["image_url"]["url"]  # Base64 data URL

        try:
            # Handle data URI prefix
            if "," in image_url:
                base64_data = image_url.split(",")[1]
            else:
                base64_data = image_url

            image_bytes = base64.b64decode(base64_data)
            image_file = io.BytesIO(image_bytes)
            return
        except (base64.binascii.Error, IndexError) as e:
            print(f"Error decoding base64: {e}")
            return
```

Refer to the
[OpenRouter image docs](https://openrouter.ai/docs/guides/overview/multimodal/image-generation#image-aspect-ratio-configuration)
for more information on the specific allowed parameters.

##### Example image response shape

When generating images, the API returns the usual chat completion structure, but
the assistant message includes an `images` field. Each image is represented as
an `image_url` object, and the `url` is a base64 data URL (typically PNG).

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "Here is your image of grass, the experience.",
        "images": [
          {
            "type": "image_url",
            "image_url": {
              "url": "data:image/png;base64,..."
            }
          }
        ]
      },
      "finish_reason": "stop"
    }
  ]
}
```

#### PDF inputs

You can send PDF documents to any model. PDFs can be sent as **direct URLs** or
**base64-encoded data URLs**.

- **URL support**: Send publicly accessible PDFs directly without encoding
- **Base64 support**: Required for local files or private documents

When a model supports file input natively, the PDF is passed directly to the
model. Otherwise, OpenRouter will parse the file (with Mistral!) and pass the parsed results to
the model.

##### PDF processing engines

Configure PDF processing using the `plugins` parameter:

| Engine        | Description                               | Cost                  |
| ------------- | ----------------------------------------- | --------------------- |
| `pdf-text`    | Best for well-structured PDFs             | Free                  |
| `mistral-ocr` | Best for scanned documents or PDFs with images | $2 per 1,000 pages |
| `native`      | Uses model's built-in file processing     | Charged as input tokens |

If you don't specify an engine, OpenRouter defaults to the model's native
capability first, then falls back to `mistral-ocr`.

##### Example: PDF via URL

```bash
curl {{BASE_URL}}/proxy/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "{{FIRST_LANGUAGE_MODEL}}",
    "messages": [
      {
        "role": "user",
        "content": [
          {"type": "text", "text": "What are the main points in this document?"},
          {
            "type": "file",
            "file": {
              "filename": "bitcoin.pdf",
              "file_data": "https://bitcoin.org/bitcoin.pdf"
            }
          }
        ]
      }
    ],
    "plugins": [
      {
        "id": "file-parser",
        "pdf": {"engine": "pdf-text"}
      }
    ]
  }'
```

##### Example: Base64-encoded PDF (Python)

```python
import base64
import requests

def encode_pdf(path):
    with open(path, "rb") as f:
        return f"data:application/pdf;base64,{base64.b64encode(f.read()).decode()}"

response = requests.post(
    "{{BASE_URL}}/proxy/v1/chat/completions",
    headers={
        "Authorization": "Bearer YOUR_API_KEY",
        "Content-Type": "application/json"
    },
    json={
        "model": "{{FIRST_LANGUAGE_MODEL}}",
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": "Summarize this document"},
                {
                    "type": "file",
                    "file": {
                        "filename": "document.pdf",
                        "file_data": encode_pdf("path/to/document.pdf")
                    }
                }
            ]
        }],
        "plugins": [{"id": "file-parser", "pdf": {"engine": "mistral-ocr"}}]
    }
)
```

##### Reusing file annotations (skip parsing costs)

When you send a PDF, the response may include `annotations` in the assistant
message. Include these in subsequent requests to skip re-parsing:

```python
response = requests.post(url, headers=headers, json={...})
result = response.json()

annotations = result["choices"][0]["message"].get("annotations")

follow_up = requests.post(url, headers=headers, json={
    "model": "{{FIRST_LANGUAGE_MODEL}}",
    "messages": [
        {"role": "user", "content": [...]},  # Original message with PDF
        {
            "role": "assistant",
            "content": result["choices"][0]["message"]["content"],
            "annotations": annotations  # Include these to skip re-parsing!
        },
        {"role": "user", "content": "Can you elaborate on point 2?"}
    ]
})
```

### Embeddings

`POST /proxy/v1/embeddings`

Generate vector embeddings from text input. You can then store these embeddings
in a vector database (like Pinecone or
[pgvector](https://github.com/pgvector/pgvector)).

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

#### Python (OpenRouter SDK)

```python
from openrouter import OpenRouter

client = OpenRouter(
    api_key="YOUR_API_KEY",
)

response = client.embeddings.generate(
    model="{{FIRST_EMBEDDING_MODEL}}",
    input="The quick brown fox jumps over the lazy dog",
)

embedding_vector = response.data[0].embedding
print(len(embedding_vector), "dimensions")
```

### Get available language models

`GET /proxy/v1/models`

List all available language models. No authentication required.

#### Example request

```bash
curl {{BASE_URL}}/proxy/v1/models
```

#### Example response

This endpoint is OpenAI compatible, so the response format is the same as the
[OpenAI models endpoint](https://platform.openai.com/docs/api-reference/models/list).

### Get available embedding models

`GET /proxy/v1/embeddings/models`

List all available embedding models. No authentication required.

#### Example request

```bash
curl {{BASE_URL}}/proxy/v1/embeddings/models
```

#### Example response

This endpoint is OpenRouter compatible, so the response format is the same as the
[OpenRouter models endpoint](https://openrouter.ai/docs/api/api-reference/embeddings/list-embeddings-models?explorer=true).

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

### Moderations

`POST /proxy/v1/moderations`

Classify if text or image is potentially inappropriate (e.g. hate speech,
violence, NSFW etc.).

#### Example request

```bash
curl {{BASE_URL}}/proxy/v1/moderations \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "input": "I want to kill them."
  }'
```

#### Example response

```json
{
  "id": "modr-5558",
  "model": "omni-moderation-latest",
  "results": [
    {
      "flagged": true,
      "categories": {
        "harassment": false,
        "harassment/threatening": false,
        "sexual": false,
        "hate": false,
        "hate/threatening": false,
        "illicit": false,
        "illicit/violent": false,
        "self-harm/intent": false,
        "self-harm/instructions": false,
        "self-harm": false,
        "sexual/minors": false,
        "violence": true,
        "violence/graphic": false
      },
      "category_scores": {
        "harassment": 0.00931199284235665,
        "harassment/threatening": 0.0010557750118175314,
        "sexual": 0.00022343624199449989,
        "hate": 0.0012502891624031056,
        "hate/threatening": 0.00001941131867789626,
        "illicit": 0.003784135086979151,
        "illicit/violent": 0.000025315637215092633,
        "self-harm/intent": 0.00022388481049310266,
        "self-harm/instructions": 2.5466403947055455e-6,
        "self-harm": 0.000014768038336604361,
        "sexual/minors": 0.00022343624199449989,
        "violence": 0.92988795999336092,
        "violence/graphic": 4.264746818557914e-6
      },
      "category_applied_input_types": {
        "harassment": ["text"],
        "harassment/threatening": ["text"],
        "sexual": ["text"],
        "hate": ["text"],
        "hate/threatening": ["text"],
        "illicit": ["text"],
        "illicit/violent": ["text"],
        "self-harm/intent": ["text"],
        "self-harm/instructions": ["text"],
        "self-harm": ["text"],
        "sexual/minors": ["text"],
        "violence": ["text"],
        "violence/graphic": ["text"]
      }
    }
  ]
}
```

## Rules

- **For teens.** This service is for teens 18 and under only. Hack Club is a
  charity - please do not abuse this service.
- **No coding agents.** For now, you are not allowed to use this service with
  coding agents like Cursor.
- **No proxies.** You are not allowed to use this service to create proxies or
  other tools that allow others to access the API without them also abiding by
  these rules.
- **No resale.** You are not allowed to resell this service or use it to create
  a service that resells AI to others.
- **Follow the Code of Conduct.** You are not allowed to use this service to
  create tools that intentionally violate the
  [Code of Conduct](https://hackclub.com/conduct). And don't try to generate
  explicit imagery or text, malware, or other harmful content.

## Rate limiting

Rate limits fall into one of two buckets:

- **Chat completions/embeddings:** 150 requests per 30 minutes per user
- **Moderations:** 300 requests per minute per user

