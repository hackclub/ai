import { type } from "arktype";
import { allowedEmbeddingModels, allowedLanguageModels } from "./env";

const ModelSchema = type({
  id: type("string").describe(
    `The ID of the model you want to use - e.g. ${allowedLanguageModels[0]}`,
  ),
  "canonical_slug?": type("string").describe(
    "The canonical slug of the model, used for linking to the model page",
  ),
  "hugging_face_id?": type("string").describe(
    "The Hugging Face ID of the model, if available",
  ),
  "name?": type("string").describe("The name of the model"),
  "created?": type("number.integer").describe(
    "The unix timestamp of when the model was created",
  ),
  "description?": type("string").describe("A description of the model"),
  "context_length?": type("number.integer").describe(
    "The maximum context length of the model",
  ),
  "architecture?": type({
    "modality?": type("string").describe(
      "The modality of the model (e.g. text->text)",
    ),
    "input_modalities?": type("string[]").describe(
      "The input modalities supported by the model",
    ),
    "output_modalities?": type("string[]").describe(
      "The output modalities supported by the model",
    ),
    "tokenizer?": type("string").describe("The tokenizer used by the model"),
    "instruct_type?": type("string|null").describe(
      "The instruction type of the model",
    ),
  }).describe("The architecture of the model"),
  "pricing?": type({
    "prompt?": type("string").describe("The price per prompt token"),
    "completion?": type("string").describe("The price per completion token"),
    "request?": type("string").describe("The price per request"),
    "image?": type("string").describe("The price per image"),
    "web_search?": type("string").describe("The price per web search"),
    "internal_reasoning?": type("string").describe(
      "The price per internal reasoning token",
    ),
    "input_cache_read?": type("string").describe(
      "The price per input cache read",
    ),
    "input_cache_write?": type("string").describe(
      "The price per input cache write",
    ),
  }).describe("The pricing of the model"),
  "top_provider?": type({
    "context_length?": type("number.integer").describe(
      "The maximum context length of the model",
    ),
    "max_completion_tokens?": type("number.integer|null").describe(
      "The maximum completion tokens of the model",
    ),
    "is_moderated?": type("boolean").describe("Whether the model is moderated"),
  }).describe("The top provider of the model"),
  "per_request_limits?": type("unknown").describe(
    "The per-request limits of the model",
  ),
  "supported_parameters?": type("string[]").describe(
    "The supported parameters of the model",
  ),
  "default_parameters?": type("unknown").describe(
    "The default parameters of the model",
  ),
});

export const ModelsResponseSchema = type({
  data: ModelSchema.array().describe("The list of available models"),
});

export const StatsSchema = type({
  totalRequests: type("number.integer").describe(
    "The total number of requests",
  ),
  totalTokens: type("number.integer").describe("The total number of tokens"),
  totalPromptTokens: type("number.integer").describe(
    "The total number of prompt tokens",
  ),
  totalCompletionTokens: type("number.integer").describe(
    "The total number of completion tokens",
  ),
});

const TextContentSchema = type({
  type: type("'text'").describe("The type of the content part"),
  text: type("string").describe("The text content"),
});

const ImageContentSchema = type({
  type: type("'image_url'").describe("The type of the content part"),
  image_url: type({
    url: type("string").describe("The URL of the image"),
    "detail?": type("string").describe("The detail level of the image"),
  }).describe("The image URL details"),
});

const ContentPartSchema = TextContentSchema.or(ImageContentSchema);

const MessageSchema = type({
  role: type("string").describe("The role of the message sender"),
  content: type("string")
    .or(ContentPartSchema.array())
    .describe("The content of the message"),
});

export const ChatCompletionRequestSchema = type({
  model: type("string").describe(
    `The ID of the model you want to use - e.g. ${allowedLanguageModels[0]}`,
  ),
  messages: MessageSchema.array().describe(
    "The messages to generate a completion for",
  ),
  "stream?": type("boolean").describe(
    "Whether to stream the response. Defaults to false.",
  ),
  "temperature?": type("number").describe(
    "The sampling temperature. Defaults to 1.0.",
  ),
  "max_tokens?": type("number|null").describe(
    "The maximum number of tokens to generate. Defaults to null (unlimited).",
  ),
  "top_p?": type("number").describe(
    "The nucleus sampling probability. Defaults to 1.0.",
  ),
  "user?": type("string").describe("The user ID. Internally set."),
});

export const ChatCompletionResponseSchema = type({
  id: type("string").describe("The ID of the chat completion"),
  "provider?": type("string").describe("The provider of the model"),
  model: type("string").describe("The model used for the completion"),
  object: type("string").describe("The object type (always 'chat.completion')"),
  created: type("number.integer").describe(
    "The unix timestamp of when the completion was created",
  ),
  choices: type({
    "logprobs?": type("null").describe("Log probability information"),
    finish_reason: type("string").describe(
      "The reason the completion finished",
    ),
    "native_finish_reason?": type("string").describe(
      "The native finish reason from the provider",
    ),
    index: type("number.integer").describe("The index of the choice"),
    message: type({
      role: type("string").describe("The role of the message sender"),
      content: type("string").describe("The content of the message"),
      "refusal?": type("null").describe("Refusal message, if any"),
      "reasoning?": type("string").describe(
        "Reasoning content, if enabled and available",
      ),
    }).describe("The generated message"),
    "reasoning_details?": type({
      type: type("string").describe("The type of reasoning detail"),
      text: type("string").describe("The reasoning text"),
      index: type("number.integer").describe("The index of the detail"),
      "format?": type("string|null").describe("The format of the detail"),
    })
      .array()
      .describe("Detailed reasoning steps"),
  })
    .array()
    .describe("The list of completion choices"),
  "system_fingerprint?": type("string").describe(
    "The system fingerprint of the model",
  ),
  usage: type({
    prompt_tokens: type("number.integer").describe(
      "The number of prompt tokens used",
    ),
    completion_tokens: type("number.integer").describe(
      "The number of completion tokens used",
    ),
    total_tokens: type("number.integer").describe(
      "The total number of tokens used",
    ),
    "queue_time?": type("number").describe("The time spent in the queue"),
    "prompt_time?": type("number").describe(
      "The time spent processing the prompt",
    ),
    "completion_time?": type("number").describe(
      "The time spent generating the completion",
    ),
    "total_time?": type("number").describe("The total time taken"),
  }).describe("Token usage statistics"),
});

export const EmbeddingsRequestSchema = type({
  model: type("string").describe(
    `The ID of the model you want to use - e.g. ${allowedEmbeddingModels[0]}`,
  ),
  input: type("string|string[]").describe(
    "The input text to generate embeddings for",
  ),
});

export const EmbeddingsResponseSchema = type({
  object: type("string").describe("The object type (always 'list')"),
  data: type({
    object: type("string").describe("The object type (always 'embedding')"),
    embedding: type("number[]").describe("The embedding vector"),
    index: type("number.integer").describe("The index of the embedding"),
  })
    .array()
    .describe("The list of embeddings"),
  model: type("string").describe("The model used for the embeddings"),
  usage: type({
    prompt_tokens: type("number.integer").describe(
      "The number of prompt tokens used",
    ),
    total_tokens: type("number.integer").describe(
      "The total number of tokens used",
    ),
  }).describe("Token usage statistics"),
  "provider?": type("string").describe("The provider of the mode (e.g. Groq)"),
  "id?": type("string").describe("The ID of the embeddings"),
});

export const ModerationRequestSchema = type({
  input: type("string|string[]")
    .or(
      type({
        type: type("'text'"),
        text: type("string"),
      })
        .or({
          type: type("'image_url'"),
          image_url: type({
            url: type("string"),
          }),
        })
        .array(),
    )
    .describe("The input text or image to classify"),
  "model?": type("string").describe(
    "The model to use for moderation. Defaults to omni-moderation-latest.",
  ),
});

export const ModerationResponseSchema = type({
  id: type("string").describe(
    "The unique identifier for the moderation request",
  ),
  model: type("string").describe("The model used for moderation"),
  results: type({
    flagged: type("boolean").describe(
      "Whether the content violates OpenAI's usage policies",
    ),
    categories: type("unknown").describe(
      "A dictionary of category names and boolean flags",
    ),
    category_scores: type("unknown").describe(
      "A dictionary of category names and scores",
    ),
    "category_applied_input_types?": type("unknown").describe(
      "A dictionary of category names and applied input types",
    ),
  })
    .array()
    .describe("The list of moderation results"),
});
