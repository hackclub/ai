use axum::response::IntoResponse;

#[utoipa::path(
    get,
    path = "/model",
    responses(
        (status = 200, description = "Comma-delimited allowed model list", content_type = "text/plain")
    ),
    tag = "Legacy"
)]
pub async fn get_model() -> impl IntoResponse {
    crate::ALLOWED_MODELS
}

#[utoipa::path(
    get,
    path = "/echo",
    responses(
        (status = 200, description = "Greeting message", content_type = "text/plain")
    ),
    tag = "Legacy"
)]
pub async fn echo() -> impl IntoResponse {
    "Hey there!"
}

#[utoipa::path(
    get,
    path = "/hey",
    responses(
        (status = 200, description = "Hello message", content_type = "text/plain")
    ),
    tag = "Legacy"
)]
pub async fn manual_hello() -> impl IntoResponse {
    echo().await
}
