use std::net::SocketAddr;

use axum::{
    body::{Body, to_bytes},
    extract::{ConnectInfo, Json, Request, State},
    http::{Method, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use futures::StreamExt;
use serde_json::{Value, from_slice};
use tracing::error;

use crate::{
    CLIENT, COMPLETIONS_URL, DEFAULT_MODEL,
    delegates::error::APIError,
    is_allowed_model,
    metrics::database::{MetricsState, extract_tokens},
};

pub async fn validate_model(req: Request, next: Next) -> Result<Response, APIError> {
    let (parts, body) = req.into_parts();

    let bytes = to_bytes(body, usize::MAX).await.map_err(|_| APIError {
        code: StatusCode::BAD_REQUEST,
        body: Some("Failed to read request body"),
    })?;

    let mut json: Value = from_slice(&bytes).map_err(|_| APIError {
        code: StatusCode::BAD_REQUEST,
        body: Some("Invalid JSON"),
    })?;

    let model = json
        .get("model")
        .and_then(Value::as_str)
        .filter(|&m| is_allowed_model(m))
        .unwrap_or(DEFAULT_MODEL);

    json["model"] = Value::String(model.to_string());

    let body = serde_json::to_vec(&json).map_err(|_| APIError {
        code: StatusCode::INTERNAL_SERVER_ERROR,
        body: Some("Failed to serialize request"),
    })?;

    Ok(next.run(Request::from_parts(parts, Body::from(body))).await)
}

#[utoipa::path(
    post,
    path = "/chat/completions",
    request_body(
        content = serde_json::Value,
        example = json!({
            "messages": [{"role": "user", "content": "Tell me a joke!"}]
        })
    ),
    responses(
        (status = 200, description = "Chat completion successful", body = serde_json::Value),
        (status = 400, description = "Bad request"),
        (status = 502, description = "Upstream service error")
    ),
    tag = "Chat",
    description = "OpenAI/Groq compatible chat completions endpoint. See: https://platform.openai.com/docs/api-reference/introduction and https://console.groq.com/docs/api-reference#chat-create"
)]
pub async fn completions(
    State(state): State<MetricsState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(request): Json<Value>,
) -> impl IntoResponse {
    let response = CLIENT
        .request(Method::POST, COMPLETIONS_URL)
        .json(&request)
        .send()
        .await
        .map_err(|e| {
            error!("Failed to send request to Groq: {}", e);
            APIError {
                code: StatusCode::BAD_GATEWAY,
                body: Some("Failed to connect to upstream service"),
            }
        })?;

    if !response.status().is_success() {
        return Err(APIError {
            code: response.status(),
            body: Some("Upstream service error"),
        });
    }

    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .cloned()
        .unwrap_or(header::HeaderValue::from_static("application/json"));

    let is_streaming = request
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let ip = addr.ip();

    if is_streaming {
        let mut stream = response.bytes_stream();
        let mut buffer = Vec::new();
        let mut usage_data = None;

        while let Some(Ok(chunk)) = stream.next().await {
            buffer.extend_from_slice(&chunk);

            String::from_utf8_lossy(&chunk)
                .lines()
                .filter_map(|line| line.strip_prefix("data: "))
                .filter(|&data| data != "[DONE]")
                .filter_map(|data| serde_json::from_str::<Value>(data).ok())
                .filter(|json| json.get("x_groq").and_then(|x| x.get("usage")).is_some())
                .for_each(|json| usage_data = Some(json));
        }

        if let Some(final_response) = usage_data {
            let tokens = extract_tokens(&final_response, true);
            state
                .log_request(&request, &final_response, ip, tokens)
                .await;
        }

        Ok(Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, content_type)
            .body(Body::from(buffer))
            .unwrap())
    } else {
        let body = response.text().await.map_err(|e| {
            error!("Failed to read response body: {}", e);
            APIError {
                code: StatusCode::BAD_GATEWAY,
                body: Some("Failed to read upstream response"),
            }
        })?;

        let json: Value = serde_json::from_str(&body).map_err(|e| {
            error!("Failed to parse response JSON: {}", e);
            APIError {
                code: StatusCode::BAD_GATEWAY,
                body: Some("Invalid response from upstream service"),
            }
        })?;

        let tokens = extract_tokens(&json, false);
        state.log_request(&request, &json, ip, tokens).await;

        Ok(Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, content_type)
            .body(Body::from(body))
            .unwrap())
    }
}
