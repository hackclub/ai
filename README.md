# hack club AI proxy

this is a lightweight LLM proxy, that amongst other things, implements:

- hack club auth
- API keys
- chat and embedding model support
- moderation model support
  - (OpenAI's one is free, but it needs an active balance to be able to use it. if you don't want to/can't add payment details to OpenAI's portal and buy credits, we've got you covered.)
- global analytics
- usage statistic logging
- (optional) sentry support
- coding tool (e.g. copilot, cursor) blocking
- spending limits
- replicate support (optional, behind a feature flag)
- posthog analytics + feature flags
- agent-readable discovery: `/openapi.json`, `/llms.txt`, `/sitemap.xml`, `/robots.txt`, JSON-LD on every page
- structured JSON errors (OpenAI-compatible, plus `error.hint` and `error.docs`)

is it the best code? probably not. but hey, it works!

you **must** have a reverse proxy (e.g. traefik) in front of the service to ensure that IPs aren't spoofed. we also highly recommend using openrouter, since it makes things like billing and provider ratelimits a lot less annoying, and also gives you much greater room to experiment and try out new models.

## env variables

see below.

```
# what model?
ALLOWED_EMBEDDING_MODELS=qwen/qwen3-embedding-8b,mistralai/codestral-embed-2505,openai/text-embedding-3-large
ALLOWED_IMAGE_MODELS=google/gemini-2.5-flash-image
ALLOWED_LANGUAGE_MODELS=qwen/qwen3-32b,moonshotai/kimi-k2-thinking,openai/gpt-oss-120b,moonshotai/kimi-k2-0905,qwen/qwen3-vl-235b-a22b-instruct,nvidia/nemotron-nano-12b-v2-vl,google/gemini-2.5-flash,openai/gpt-5-mini,deepseek/deepseek-v3.2-exp,deepseek/deepseek-r1-0528,z-ai/glm-4.6

# you should not commit these - although i hope you know that already!
OPENAI_API_KEY=
OPENAI_API_URL=https://openrouter.ai/api
OPENAI_MODERATION_API_KEY=
OPENAI_MODERATION_API_URL=https://api.openai.com/v1/moderations

# get these from https://account.hackclub.com
HACK_CLUB_CLIENT_ID=
HACK_CLUB_CLIENT_SECRET=

# check that users are ID verified?
ENFORCE_IDV=true

# postgres 18 database
# not needed for docker compose
DATABASE_URL=

BASE_URL=https://ai.hackclub.com
NODE_ENV=production # not needed for docker compose
PORT=54321 # not needed for docker compose

# openrouter provisioning key - get it from https://openrouter.ai/account
# this is used to view remaining credit balance
OPENROUTER_PROVISIONING_KEY=

# replicate - for image generation/stt/tts/etc
REPLICATE_API_KEY=
REPLICATE_SESSION_ID=
REPLICATE_USERNAME=

# posthog analytics + feature flags
POSTHOG_API_KEY=
POSTHOG_UI_HOST=https://us.posthog.com
POSTHOG_API_HOST=https://us.i.posthog.com/

# sentry.io support (optional)
SENTRY_DSN=
```

## machine-readable endpoints

everything below is public and unauthenticated. they're built at request time
from `env.BASE_URL` and the configured model lists, so they stay in sync with
whatever this deployment actually allows.

| path | what it is |
| --- | --- |
| `/openapi.json` (also `/.well-known/openapi.json`) | OpenAPI 3.1 description of the proxy API. built in `src/lib/openapi.ts`. |
| `/llms.txt` | [llmstxt.org](https://llmstxt.org) index of the site, for agents. |
| `/sitemap.xml` | indexable URLs. bump `SITE_LAST_MODIFIED` in `src/lib/site.ts` when public content changes. |
| `/robots.txt` | crawler policy + sitemap pointer. |

the homepage (and every other page) carries JSON-LD describing Hack Club and
this service - see `buildStructuredData` in `src/lib/site.ts`.

adding a proxy endpoint? add it to `src/lib/openapi.ts` too, and add a case to
`src/lib/openapi.test.ts`.

## errors

every error goes through `src/lib/errors.ts`, which renders one shape:

```json
{
  "error": {
    "message": "Authentication required",
    "type": "authentication_error",
    "code": "unauthorized",
    "status": 401,
    "hint": "Send `Authorization: Bearer sk-hc-v1-...`. Create a key at https://ai.hackclub.com/keys.",
    "docs": "https://docs.ai.hackclub.com/guide/authentication"
  },
  "request_id": "..."
}
```

`error.message`/`type`/`code` are the OpenAI error shape, so OpenAI-compatible
SDKs surface something useful. `hint` and `docs` are ours.

404s are content-negotiated: API paths and non-GET requests get that JSON,
browsers get a branded HTML page, and everything else (curl, crawlers, agents)
gets a short markdown body pointing at `/llms.txt` and `/openapi.json`.

## tests

```
bun test
```

`bunfig.toml` preloads `src/test/setup.ts`, which fills in placeholder env vars
so tests that import a route don't trip `src/env.ts`'s validation. no database
is needed.

## tech stack

- bun as the runtime
- hono for the server
- postgres for the database
- drizzle for the ORM
- alpine + htmx + `hono/jsx` for the frontend
  - developing HCAI? turn on alpine + htmx in the layout if you need to use them!
- sentry for error tracking (optional)
- openrouter as the main LLM provider
- replicate for image generation + speech to text + text to speech + other models
- posthog for analytics + feature flags
- biome for code formatting + linting
- openai for moderation API
