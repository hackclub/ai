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

is it the best code? probably not. but hey, it works!

you **must** have a reverse proxy (e.g. traefik) in front of the service to ensure that IPs aren't spoofed. we also highly recommend using openrouter, since it makes things like billing and provider ratelimits a lot less annoying, and also gives you much greater room to experiment and try out new models.

## env variables

see below.

```
# what model?
ALLOWED_EMBEDDING_MODELS=qwen/qwen3-embedding-8b,mistralai/codestral-embed-2505,openai/text-embedding-3-large
ALLOWED_LANGUAGE_MODELS=qwen/qwen3-32b,moonshotai/kimi-k2-thinking,openai/gpt-oss-120b,moonshotai/kimi-k2-0905,qwen/qwen3-vl-235b-a22b-instruct, nvidia/nemotron-nano-12b-v2-vl,google/gemini-2.5-flash,openai/gpt-5-mini,deepseek/deepseek-v3.2-exp,deepseek/deepseek-r1-0528,z-ai/glm-4.6,google/gemini-2.5-flash-image

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

SENTRY_DSN= # sentry.io support (optional)

# (optional) openrouter provisioning key - get it from https://openrouter.ai/account
# this is used to view remaining credit balance
OPENROUTER_PROVISIONING_KEY=
```

## tech stack

- bun as the runtime
- hono for the server
- postgres for the database
- drizzle for the ORM
- alpine + htmx + `hono/jsx` for the frontend
  - developing HCAI? turn on alpine + htmx in the layout if you need to use them!
- sentry for error tracking (optional)
