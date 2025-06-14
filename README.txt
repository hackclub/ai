ai.hackclub.com

An experimental service providing unlimited /chat/completions for free, for teens in Hack Club.
No API key needed.

Example usage:

curl -X POST https://ai.hackclub.com/chat/completions \
    -H "Content-Type: application/json" \
    -d '{
        "messages": [{"role": "user", "content": "Tell me a joke!"}]
    }'

Example output:
{
    "choices": [
        {
            "finish_reason": "stop",
            "index": 0,
            "logprobs": null,
            "message": {
                "content": "Here's one:\n\nWhat do you call a fake noodle?\n\n(Wait for it...)\n\nAn impasta!\n\nHope that made you laugh!",
                "role": "assistant"
            }
        }
    ],
    "created": 1749866054,
    "id": "chatcmpl-12345-6789-1011-1213-14151617",
    "model": "meta-llama/llama-4-maverick-17b-128e-instruct",
    "object": "chat.completion",
    "system_fingerprint": "fp_12345678",
    "usage_breakdown": null,
    "x_groq": {
        "id": "req_1234abcd5678"
    }
}
