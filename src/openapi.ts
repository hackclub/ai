import { type } from "arktype";

export const ModelSchema = type({
    id: "string",
});

export const ModelsResponseSchema = type({
    data: ModelSchema.array(),
});

export const StatsSchema = type({
    totalRequests: "number.integer",
    totalTokens: "number.integer",
    totalPromptTokens: "number.integer",
    totalCompletionTokens: "number.integer",
});

export const TextContentSchema = type({
    type: "'text'",
    text: "string",
});

export const ImageContentSchema = type({
    type: "'image_url'",
    image_url: {
        url: "string",
        "detail?": "string",
    },
});

export const ContentPartSchema = TextContentSchema.or(ImageContentSchema);

export const MessageSchema = type({
    role: "string",
    content: type("string").or(ContentPartSchema.array()),
});

export const ChatCompletionRequestSchema = type({
    model: "string",
    messages: MessageSchema.array(),
    "stream?": "boolean",
    "temperature?": "number",
    "max_tokens?": "number|null",
    "top_p?": "number",
});

export const ChatCompletionResponseSchema = type({
    id: "string",
    "provider?": "string",
    model: "string",
    object: "string",
    created: "number.integer",
    choices: type({
        "logprobs?": "null",
        finish_reason: "string",
        "native_finish_reason?": "string",
        index: "number.integer",
        message: type({
            role: "string",
            content: "string",
            "refusal?": "null",
        }),
    }).array(),
    "system_fingerprint?": "string",
    usage: type({
        prompt_tokens: "number.integer",
        completion_tokens: "number.integer",
        total_tokens: "number.integer",
    }),
});

export const EmbeddingsRequestSchema = type({
    model: "string",
    input: "string|string[]",
});

export const EmbeddingsResponseSchema = type({
    object: "string",
    data: type({
        object: "string",
        embedding: "number[]",
        index: "number.integer",
    }).array(),
    model: "string",
    usage: type({
        prompt_tokens: "number.integer",
        total_tokens: "number.integer",
    }),
    "provider?": "string",
    "id?": "string",
});
