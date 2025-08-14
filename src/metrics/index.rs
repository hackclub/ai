use axum::{
    extract::State,
    response::{Html, IntoResponse},
};
use maud::html;

use crate::{ALLOWED_MODELS, DEFAULT_MODEL, metrics::database::MetricsState};

#[utoipa::path(
    get,
    path = "/",
    responses(
        (status = 200, description = "Metrics page", body = String)
    ),
    tag = "Metrics"
)]
pub async fn index(State(state): State<MetricsState>) -> impl IntoResponse {
    let mut total: i64 = 0;

    if let Some(pool) = &state.db {
        if let Ok(client) = pool.get().await {
            if let Ok(rows) = client
                .query("SELECT COALESCE(SUM(tokens), 0) AS sum FROM api_logs", &[])
                .await
            {
                if let Some(row) = rows.first() {
                    total = row.get::<_, i64>("sum");
                }
            }
        }
    }

    Html(
        html! {
            html lang="en" {
                head {
                    meta charset="UTF-8" {}
                    meta name="viewport" content="width=device-width, initial-scale=1.0" {}
                    title { "Hack Club | AI" }
                }
                body {
                    header {
                        h1 { "ai.hackclub.com" }
                        p {
                            "An experimental service providing unlimited "
                            code { "/chat/completions" }
                            " for free, for teens in "
                            a href="https://hackclub.com/" target="_blank" { "Hack Club" }
                            ". No API key needed."
                        }
                        p {
                            b { (total) }
                            " tokens processed since January 2025. Default model: "
                            b { code { (DEFAULT_MODEL) } }
                        }
                        p {
                            "Available models: "
                            b {
                                @for (i, model) in ALLOWED_MODELS.split(',').enumerate() {
                                    @if i > 0 { ", " }
                                    code { (model.trim()) }
                                }
                            }
                        }
                        p {
                            "Open source at "
                            a href="https://github.com/hackclub/ai" { "github.com/hackclub/ai" }
                            "!"
                        }
                    }
                    section {
                        h2 { "Usage" }
                        h3 { "Chat Completions" }
                        pre {
                            code {
                                "curl -X POST https://ai.hackclub.com/chat/completions \\\n"
                                "    -H \"Content-Type: application/json\" \\\n"
                                "    -d '{\n"
                                "        \"messages\": [{\"role\": \"user\", \"content\": \"Tell me a joke!\"}]\n"
                                "    }'"
                            }
                        }
                        h3 { "Get Current Models" }
                        p { "To get current models:" }
                        pre {
                            code { "curl https://ai.hackclub.com/model" }
                        }
                        p {
                            "Example response: "
                            code { "qwen/qwen3-32b,openai/gpt-oss-120b,openai/gpt-oss-20b,meta-llama/llama-4-maverick-17b-128e-instruct" }
                        }
                    }
                    section {
                        h2 { "Terms" }
                        p {
                            "You must be a teenager in the "
                            a href="https://hackclub.com/slack" { "Hack Club Slack" }
                            ". All requests and responses are logged to prevent abuse. "
                            "Projects only - no personal use. This means you can't use it in Cursor "
                            "or anything similar for the moment! Abuse means this will get shut down "
                            "- we're a nonprofit funded by donations."
                        }
                    }
                    section {
                        h2 { "Docs" }
                        p {
                            a href="/docs" { "Link" }
                        }
                    }
                }
            }
        }
        .into_string(),
    )
}
