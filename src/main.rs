mod delegates;
mod docs;
mod metrics;
mod routes;

use std::{collections::HashSet, net::SocketAddr, sync::LazyLock, time::Duration};

use axum::{
    Router,
    http::header,
    middleware,
    routing::{get, post},
};
use dotenvy_macro::dotenv;
use reqwest::{
    Client, StatusCode,
    header::{HeaderMap, HeaderValue},
};
use tokio::net::TcpListener;
use rustls::crypto::aws_lc_rs::default_provider;
use tower_http::cors::{Any, CorsLayer};
use tracing_subscriber::fmt;
use utoipa::OpenApi;

use crate::{
    delegates::error::APIError,
    docs::handlers::{docs, openapi_axle},
    metrics::{database::MetricsState, index::index},
    routes::{
        completions::{completions, validate_model},
        legacy::{echo, get_model, manual_hello},
    },
};

pub(crate) const KEY: &str = dotenv!("KEY");
pub(crate) const PORT: &str = dotenv!("PORT");
pub(crate) const PROD_DOMAIN: &str = dotenv!("PROD_DOMAIN");
pub(crate) const DATABASE_URL: &str = dotenv!("DATABASE_URL");
pub(crate) const DEFAULT_MODEL: &str = dotenv!("DEFAULT_MODEL");
pub(crate) const ALLOWED_MODELS: &str = dotenv!("ALLOWED_MODELS");
pub(crate) const COMPLETIONS_URL: &str = dotenv!("COMPLETIONS_URL");

#[derive(OpenApi)]
#[openapi(
    paths(
        routes::legacy::echo,
        metrics::index::index,
        routes::legacy::get_model,
        routes::legacy::manual_hello,
        routes::completions::completions,
    ),
    tags(
        (name = "Chat", description = "Chat completion endpoints"),
        (name = "Legacy", description = "Legacy endpoints"),
        (name = "Metrics", description = "Metrics and monitoring")
    ),
    info(
        title = "Hack Club AI Service",
        version = "0.0.1",
        description = "Simple Groq proxy for AI completions"
    )
)]
struct ApiDoc;

static CLIENT: LazyLock<Client> = LazyLock::new(|| {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    headers.insert(
        header::USER_AGENT,
        HeaderValue::from_static("hackclub-ai-proxy/1.0"),
    );

    let bearer = format!("Bearer {}", KEY);
    headers.insert(
        header::AUTHORIZATION,
        HeaderValue::from_str(&bearer).expect("Invalid authorization header"),
    );

    Client::builder()
        .default_headers(headers)
        .build()
        .expect("Failed to build HTTP client")
});

static ALLOWED_MODELS_SET: LazyLock<HashSet<String>> = LazyLock::new(|| {
    ALLOWED_MODELS
        .split(',')
        .map(|s| s.trim().to_string())
        .collect()
});

pub(crate) fn is_allowed_model(model: &str) -> bool {
    ALLOWED_MODELS_SET.contains(model)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    default_provider()
        .install_default()
        .unwrap();

    fmt::init();

    LazyLock::force(&CLIENT);

    let chat_router = Router::new()
        .route("/chat/completions", post(completions))
        .layer(middleware::from_fn(validate_model));

    let docs_router = Router::new()
        .route("/docs", get(docs))
        .route("/openapi.json", get(openapi_axle));

    let legacy_router = Router::new()
        .route("/", get(index))
        .route("/model", get(get_model))
        .route("/echo", get(echo))
        .route("/hey", get(manual_hello));

    let cors = CorsLayer::new()
        .allow_methods(Any)
        .allow_headers(Any)
        .allow_origin(Any)
        .max_age(Duration::from_secs(60) * 10);

    let state = MetricsState::init().await;

    run_migrations(&state).await;
    let app = chat_router
        .merge(docs_router)
        .merge(legacy_router)
        .fallback(|| async {
            APIError {
                code: StatusCode::NOT_FOUND,
                body: Some("Not Found"),
            }
        })
        .layer(cors)
        .with_state(state.clone());

    let listener = TcpListener::bind(format!("0.0.0.0:{}", PORT)).await?;

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;

    Ok(())
}

async fn run_migrations(state: &metrics::database::MetricsState) {
    if let Some(pool) = &state.db {
        if let Ok(client) = pool.get().await {
            let _ = client
                .execute(
                    "CREATE TABLE IF NOT EXISTS api_logs (
                    id SERIAL PRIMARY KEY,
                    request JSONB NOT NULL,
                    response JSONB NOT NULL,
                    ip INET NOT NULL,
                    tokens INTEGER,
                    created_at TIMESTAMPTZ DEFAULT NOW()
                )",
                    &[],
                )
                .await;
        }
    }
}
