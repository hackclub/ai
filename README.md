# hack club AI proxy

this is a lightweight LLM proxy, that amongst other things, implements:

- slack auth
- API keys
- chat and embedding model support
- global analytics
- usage statistic logging

is it the best code? probably not. but hey, it works!

you **must** have a reverse proxy (e.g. traefik) in front of the service to ensure that IPs aren't spoofed. we also highly recommend using openrouter, since it makes things like billing and provider ratelimits a lot less annoying, and also gives you much greater room to experiment and try out new models.

## env variables

see below.

```
ALLOWED_EMBEDDING_MODELS=qwen/qwen3-embedding-8b,mistralai/codestral-embed-2505,openai/text-embedding-3-large
ALLOWED_LANGUAGE_MODELS=qwen/qwen3-32b,moonshotai/kimi-k2-thinking,openai/gpt-oss-120b,moonshotai/kimi-k2-0905,qwen/qwen3-vl-235b-a22b-instruct, nvidia/nemotron-nano-12b-v2-vl,google/gemini-2.5-flash,openai/gpt-5-mini,deepseek/deepseek-v3.2-exp,deepseek/deepseek-r1-0528,z-ai/glm-4.6,google/gemini-2.5-flash-image
BASE_URL=https://ai.hackclub.com
NODE_ENV=production

# you should not commit these - although i hope you know that already!
OPENAI_API_KEY=
OPENAI_API_URL=https://openrouter.ai/api

# get these from https://api.slack.com/apps
SLACK_CLIENT_ID=221053565.9914775278545
SLACK_CLIENT_SECRET=
SLACK_TEAM_ID=T0266FRGM
```
