ai.hackclub.com

An experimental service providing unlimited /chat/completions for free, for teens in Hack Club.
No API key needed.

Example usage:

curl -X POST https://ai.hackclub.com/chat/completions \
    -H "Content-Type: application/json" \
    -d '{
        "messages": [{"role": "user", "content": "Tell me a joke!"}]
    }'