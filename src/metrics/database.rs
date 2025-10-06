use std::net::IpAddr;
use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};

use deadpool_postgres::{Config, ManagerConfig, Pool, RecyclingMethod, Runtime::Tokio1};
use rustls::RootCertStore;
use rustls_pemfile::certs;
use serde_json::Value;
use tokio_postgres_rustls::MakeRustlsConnect;
use tracing::error;
use webpki_roots::TLS_SERVER_ROOTS;

use crate::DATABASE_URL;

#[derive(Clone)]
pub struct MetricsState {
    pub db: Option<Pool>,
    pub tokens: Arc<AtomicI64>,
}

impl MetricsState {
    pub async fn init() -> Self {
        let mut cfg = Config::new();
        cfg.url = Some(DATABASE_URL.to_string());
        cfg.manager = Some(ManagerConfig {
            recycling_method: RecyclingMethod::Fast,
        });

        let mut root_store = RootCertStore::empty();
        root_store.extend(TLS_SERVER_ROOTS.iter().cloned());

        let tls = MakeRustlsConnect::new(
            rustls::ClientConfig::builder()
                .with_root_certificates(root_store)
                .with_no_client_auth(),
        );

        match cfg.create_pool(Some(Tokio1), tls) {
            Ok(pool) => Self {
                db: Some(pool),
                tokens: std::sync::Arc::new(AtomicI64::new(0)),
            },
            Err(e) => {
                error!("Failed to create database pool: {}", e);
                Self {
                    db: None,
                    tokens: std::sync::Arc::new(AtomicI64::new(0)),
                }
            }
        }
    }

    #[inline]
    pub fn inc_tokens(&self, n: i64) {
        self.tokens.fetch_add(n, Ordering::Relaxed);
    }

    pub async fn log_request(
        &self,
        request: &Value,
        response: &Value,
        ip: IpAddr,
        tokens: Option<i32>,
    ) {
        if let Some(pool) = &self.db {
            match pool.get().await {
                Ok(client) => {
                    if let Err(e) = client
                        .execute(
                            "INSERT INTO api_logs (request, response, ip, tokens) VALUES ($1, $2, $3, $4)",
                            &[request, response, &ip, &tokens],
                        )
                        .await
                    {
                        error!("Failed to log request: {}", e);
                    }

                    if let Some(token_count) = tokens {
                        self.inc_tokens(token_count as i64);
                    }
                }
                Err(e) => {
                    error!("Failed to get database connection from pool: {}", e);
                }
            }
        }
    }
}

pub fn extract_tokens(response: &Value, is_streaming: bool) -> Option<i32> {
    let usage = if is_streaming {
        response.get("x_groq")?.get("usage")?
    } else {
        response.get("usage")?
    };

    usage.get("total_tokens")?.as_i64().map(|t| t as i32)
}
