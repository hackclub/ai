//! Serialization and deserialization of OpenAI API requests
//! written by Eli Ozcan, definitions follow https://console.groq.com/docs/api-reference as of
//! Sunday August 10th, 2025

use serde::{Deserialize, Serialize};
use serde_json::Value;

use self::message::ChatCompletionMessage;

pub mod functions;
pub mod message;
pub mod tools;

/// The main request payload, made to include standard Groq/OpenAI parameters
/// This loosely follows the spec, and fills in the gaps when nessicary.
///
/// Runtime defaults have already been specified in the Serialization definition and Default impls
/// for each item. The default impls may call an env lookup. make sure that is safe
///
/// See https://console.groq.com/docs/api-reference#chat for all supported fields
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct OpenAiRequest {
    /// List of messages
    pub messages: Vec<ChatCompletionMessage>,

    /// The model to call
    pub model: Option<String>,

    /// A list of domains to exclude from the search results when the model uses a web search tool.
    #[deprecated(note = "Deprecated: Use search_settings.exclude_domains instead.")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exclude_domains: Option<Value>,

    /// A list of domains to include in the search results when the model uses a web search tool.
    #[deprecated(note = "Deprecated: Use search_settings.include_domains instead.")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_domains: Option<Value>,

    /// Range: -2 - 2
    /// This is not yet supported by any of our models. Number between -2.0 and 2.0. Positive values penalize new tokens based on their existing frequency in the text so far, decreasing the model's likelihood to repeat the same line verbatim.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frequency_penalty: Option<f32>,

    /// Controls which (if any) function is called by the model. none means the model will not call a function and instead generates a message. auto means the model can pick between generating a message or calling a function. Specifying a particular function via {"name": "my_function"} forces the model to call that function.
    /// none is the default when no functions are present. auto is the default if functions are present.
    #[deprecated(note = "Deprecated in favor of tool_choice.")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub function_call: Option<functions::FunctionCall>,

    /// A list of functions the model may generate JSON inputs for.
    #[deprecated(note = "Deprecated in favor of tools.")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub functions: Option<Vec<functions::Function>>,

    /// Whether to include reasoning in the response. If true, the response will include a reasoning field. If false, the model's reasoning will not be included in the response. This field is mutually exclusive with reasoning_format.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_reasoning: Option<bool>,

    /// This is not yet supported by any of our models. Modify the likelihood of specified tokens appearing in the completion.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logit_bias: Option<Value>,

    /// This is not yet supported by any of our models. Whether to return log probabilities of the output tokens or not. If true, returns the log probabilities of each output token returned in the content of message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logprops: Option<bool>,

    /// The maximum number of tokens that can be generated in the chat completion. The total length of input tokens and generated tokens is limited by the model's context length.
    pub max_completion_tokens: Option<u32>,

    /// The maximum number of tokens that can be generated in the chat completion. The total length of input tokens and generated tokens is limited by the model's context length.
    #[deprecated(note = "Deprecated in favor of max_completion_tokens.")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,

    /// This parameter is not currently supported
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,

    /// How many chat completion choices to generate for each input message. Note that the current moment, only n=1 is supported. Other values will result in a 400 response.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub n: Option<u8>,

    /// Whether to enable parallel function calling during tool use.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parallel_tool_calls: Option<bool>,

    /// This is not yet supported by any of our models. Number between -2.0 and 2.0. Positive values penalize new tokens based on whether they appear in the text so far, increasing the model's likelihood to talk about new topics.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presence_penalty: Option<f32>,

    /// qwen3 models support the following values Set to 'none' to disable reasoning. Set to 'default' or null to let Qwen reason.
    /// openai/gpt-oss-20b and openai/gpt-oss-120b support 'low', 'medium', or 'high'. 'medium' is the default value.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<ReasoningEffort>,

    /// Specifies how to output reasoning tokens This field is mutually exclusive with include_reasoning.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_format: Option<ReasoningFormat>,

    /// An object specifying the format that the model must output. Setting to { "type": "json_schema", "json_schema": {...} } enables Structured Outputs which ensures the model will match your supplied JSON schema. json_schema response format is only available on supported models. Setting to { "type": "json_object" } enables the older JSON mode, which ensures the message the model generates is valid JSON. Using json_schema is preferred for models that support it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_format: Option<String>,

    /// Settings for web search functionality when the model uses a web search tool.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search_settings: Option<SearchSettings>,

    /// If specified, our system will make a best effort to sample deterministically, such that repeated requests with the same seed and parameters should return the same result. Determinism is not guaranteed, and you should refer to the system_fingerprint response parameter to monitor changes in the backend.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seed: Option<i32>,

    // NOTE: For HQ: This is removed to prevent lots of spending
    /*
      /// The service tier to use for the request. Defaults to on_demand.
      ///
      /// auto will automatically select the highest tier available within the rate limits of your organization.
      /// flex uses the flex tier, which will succeed or fail quickly
      #[serde(skip_serializing_if = "Option::is_none")]
      pub service_tier: Option<ServiceTier>,
    */
    /// Up to 4 sequences where the API will stop generating further tokens. The returned text will not contain the stop sequence.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop: Option<StopSequence>,

    /// This parameter is not currently supported.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub store: Option<bool>,

    /// If set, partial message deltas will be sent. Tokens will be sent as data-only [server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events#event_stream_format) as they become available, with the stream terminated by a `data: [DONE]` message. [Example code](https://console.groq.com/docs/text-chat#streaming-a-chat-completion).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream: Option<bool>,

    /// Options for streaming response. Only set this when you set `stream: true`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_options: Option<StreamOptions>,

    /// What sampling temperature to use, between 0 and 2. Higher values like 0.8 will make the output more random, while lower values like 0.2 will make it more focused and deterministic. We generally recommend altering this or top_p but not both.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,

    /// Controls which (if any) tool is called by the model. none means the model will not call any tool and instead generates a message. auto means the model can pick between generating a message or calling one or more tools. required means the model must call one or more tools. Specifying a particular tool via {"type": "function", "function": {"name": "my_function"}} forces the model to call that tool.
    /// none is the default when no tools are present. auto is the default if tools are present.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_choice: Option<tools::ToolChoice>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<tools::Tool>>,

    /// This is not yet supported by any of our models. An integer between 0 and 20 specifying the number of most likely tokens to return at each token position, each with an associated log probability. logprobs must be set to true if this parameter is used.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_logprobs: Option<u16>,

    /// An alternative to sampling with temperature, called nucleus sampling, where the model considers the results of the tokens with top_p probability mass. So 0.1 means only the tokens comprising the top 10% probability mass are considered. We generally recommend altering this or temperature but not both.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f32>,

    /// A unique identifier representing your end-user, which can help us monitor and detect abuse.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningEffort {
    // qwen3
    None,
    Default,

    // gpt-oss
    Low,
    Medium,
    High,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningFormat {
    Hidden,
    Raw,
    Parsed,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum ResponseFormat {
    #[default]
    Text,
    JsonSchema {
        /// Structured Outputs configuration options, including a JSON Schema.
        #[serde(skip_serializing_if = "Option::is_none")]
        json_schema: Option<JsonSchema>,
    },
    JsonObject,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct JsonSchema {
    /// A description of what the response format is for, used by the model to determine how to respond in the format.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    /// The name of the response format. Must be a-z, A-Z, 0-9, or contain underscores and dashes, with a maximum length of 64.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,

    /// The schema for the response format, described as a JSON Schema object. Learn how to build JSON schemas [here](https://json-schema.org).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema: Option<Value>,

    /// Whether to enable strict schema adherence when generating the output. If set to true, the model will always follow the exact schema defined in the schema field. Only a subset of JSON Schema is supported when strict is true.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strict: Option<bool>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SearchSettings {
    /// Name of country to prioritize search results from (e.g., "united states", "germany", "france").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub country: Option<String>,

    /// A list of domains to exclude from the search results.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exclude_domains: Option<Vec<Value>>,

    /// A list of domains to include in the search results.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_domains: Option<Vec<Value>>,

    /// Whether to include images in the search results.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_images: Option<bool>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "snake_case")]
pub enum ServiceTier {
    #[default]
    Auto,
    OnDemand,
    Flex,
    Performance,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(untagged)]
pub enum StopSequence {
    String(String),
    Array(Vec<String>),
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct StreamOptions {
    /// If set, an additional chunk will be streamed before the data: [DONE] message. The usage field on this chunk shows the token usage statistics for the entire request, and the choices field will always be an empty array. All other chunks will also include a usage field, but with a null value.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_usage: Option<bool>,
}
