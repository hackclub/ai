# ai.hackclub.com

> An experimental service providing unlimited /chat/completions for free, for
> teens in Hack Club. No API key needed.

## Example usage

```sh
curl -X POST https://ai.hackclub.com/chat/completions \
    -H "Content-Type: application/json" \
    -d '{
        "messages": [{"role": "user", "content": "Tell me a joke!"}]
    }'
```

## Running for yourself

### Realistic 1 to 1

The actual service uses Groq and `qwen/qwen-32b` at the moment, so you will need
to make a free groq account, set these env vars at runtime:

```sh
COMPLETIONS_MODEL=qwen/qwen3-32b,openai/gpt-oss-120b,openai/gpt-oss-20b,meta-llama/llama-4-maverick-17b-128e-instruct
COMPLETIONS_URL=https://api.groq.com/openai/v1/chat/completions
KEY=gsk_....

DB_URL="this is optional"
```

### Local Ollama instance

```sh
VALID_MODELS=whatever,whatever2
COMPLETIONS_URL=localhost:8000 # or what your ollama instance uses
KEY= # no key required, but set it to an empty string

DB_URL="this is optional"
```
