use serde::{Deserialize, Serialize};

// NOTE: HQ people, this is all you have to configure to add new models for use, and optionally the
// default COMPLETIONS_MODEL

/// List of every usable model, this is done to prevent unauthorized model usage and to not blow
/// the budget.
///
/// NAMING: [provider][model]
/// b for billion parameters is lowercased, as well as e
/// Follow CamelCase otherwise
#[non_exhaustive]
#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum CompletionModel {
    #[serde(rename = "qwen/qwen3-32b")]
    QwenQwen3_32b,

    #[serde(rename = "openai/gpt-oss-120b")]
    OpenAiOss120b,

    #[serde(rename = "openai/gpt-oss-20b")]
    OpenAiOss20b,

    #[serde(rename = "meta-llama/llama-4-maverick-17b-128e-instruct")]
    MetaLlamaLlama4Maverick17b128eInstruct,
}

// As per the docs, the default model should be Qwen. however we must respect the env var, which
// may fail
impl Default for CompletionModel {
    fn default() -> Self {
        // Get the env var, split by comma, take the first part if any
        let default = std::env::var("COMPLETIONS_MODEL")
            .ok()
            .and_then(|val| val.split(',').next().map(str::trim).map(String::from))
            .and_then(|first_model_str| {
                serde_plain::from_str::<CompletionModel>(&first_model_str).ok()
            })
            .unwrap_or(Self::QwenQwen3_32b);

        default
    }
}
