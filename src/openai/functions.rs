//! Deprecated functions API, separated from tools for clarity

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(untagged)]
pub enum FunctionCall {
    String(String),
    Object {
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
    },
}

/// A function , this is the same schema for both tools and the deprecated functions api. this
/// is duplicated in tools
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Function {
    /// A description of what the function does, used by the model to choose when and how to call the function.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    /// The name of the function to be called. Must be a-z, A-Z, 0-9, or contain underscores and dashes, with a maximum length of 64.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,

    /// Function parameters defined as a JSON Schema object. Refer to [this](https://json-schema.org/understanding-json-schema) for schema documentation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameters: Option<Value>,
}
