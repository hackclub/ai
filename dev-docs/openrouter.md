# OpenRouter

We use [OpenRouter](https://openrouter.ai/) to provide access to a variety of open-source large language models (LLMs) through a unified API. This allows us to offer users a wide range of model options without the need to manage multiple integrations ourselves.

For Gemini models specifically, we use OpenRouter's BYOK key feature to use our trial credits with Google Cloud for billing, but if we get ratelimited by Vertex AI or AI Studio, OpenRouter will automatically fall back to using the shared credits.

## Configuration

To set up OpenRouter, ensure the following environment variables are configured:

- `OPENAI_API_KEY`: Your OpenRouter API key.
- `OPENAI_API_URL`: `https://openrouter.ai/api/v1`.

We also have a $25/day key limit set on the OpenRouter account to prevent cases of abuse or bugs from completely depleting our credits. If we hit this limit often, we may consider increasing it or implementing additional safeguards.
