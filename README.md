# Hack Club AI

Free AI APIs for Hack Clubbers: every model on OpenRouter, plus image
generation, embeddings, web search, OCR and Replicate, behind one
OpenAI-compatible API.

**[ai.hackclub.com](https://ai.hackclub.com)** · [Documentation](https://docs.ai.hackclub.com)

## Getting started

1. Sign in at [ai.hackclub.com](https://ai.hackclub.com) with your Hack Club account.
2. Create an API key.
3. Point any OpenAI SDK at `https://ai.hackclub.com/proxy/v1`.

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://ai.hackclub.com/proxy/v1",
    api_key="sk-hc-v1-...",
)

reply = client.chat.completions.create(
    model="google/gemini-3-flash-preview",
    messages=[{"role": "user", "content": "Hi!"}],
)
print(reply.choices[0].message.content)
```

Or with `curl`:

```bash
curl https://ai.hackclub.com/proxy/v1/chat/completions \
  -H "Authorization: Bearer $HACK_CLUB_AI_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "google/gemini-3-flash-preview", "messages": [{"role": "user", "content": "Hi!"}]}'
```

Usage is free up to a daily allowance. The dashboard shows what you have
spent today and every request you have made.

## What's available

| Endpoint | What it does |
|---|---|
| `POST /proxy/v1/chat/completions`, `/responses` | Chat with any OpenRouter model |
| `POST /proxy/v1/embeddings` | Text embeddings |
| `POST /proxy/v1/images/generations` | Image generation |
| `POST /proxy/v1/exa/search`, `/contents`, `/findSimilar`, `/answer` | Web search with Exa |
| `POST /proxy/v1/ocr` | Documents and images to Markdown with Mistral OCR |
| `/proxy/v1/replicate/*` | Speech, music, video and image models on Replicate (beta) |
| `POST /proxy/v1/jev/systemone` | Jev, TypeSafe's System One model |
| `GET /proxy/v1/models` | The model listing |

See the [documentation](https://docs.ai.hackclub.com) for each endpoint's
parameters and examples.

## Contributing

The gateway is built with Bun, Elysia and SvelteKit, on PostgreSQL,
ClickHouse and Garage. To run it locally:

```bash
bun install --frozen-lockfile
cp .env.example .env   # fill in the provider keys
bun run db:up          # starts the datastores with Docker
bun run dev            # http://localhost:3000
```

[`docs/development.md`](docs/development.md) covers configuration, tests,
migrations and deployment, and
[`docs/architecture/storage-and-billing.md`](docs/architecture/storage-and-billing.md)
explains how requests are metered and billed.

Need help? Ask in the [Hack Club Slack](https://hackclub.com/slack).
