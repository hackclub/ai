//! hackclub/ai
//! a free open-source completions endpoint for hackclubbers!
//!
//! maintained at https://github.com/hackclub/ai
//!
//! ## Running
//! ### Environment variables
//! `VALID_MODELS`: The list of valid models, the first one is used as the default
//! `COMPLETIONS_URL`: Base URL for the API
//! `KEY`: API Key for the completions URL
//! `DB_URL`: URL to the postgresql db to store logs in

use crate::openai::OpenAiRequest;
use actix_web::post;
use actix_web::{
    App, HttpRequest, HttpResponse, HttpServer, Responder, get,
    http::StatusCode,
    middleware::Logger,
    web::{self, Bytes},
};
use async_stream::stream;
use deadpool_postgres::{Config, ManagerConfig, Pool, RecyclingMethod, Runtime};
use futures::StreamExt;
use minijinja::{Environment, context, path_loader};
use reqwest::{Client, header};
use serde_json::Value;
use std::net::IpAddr;
use tokio::io::AsyncBufReadExt;
use tokio_util::io::StreamReader;

mod openai;

#[get("/")]
async fn index(data: web::Data<AppState>) -> Result<impl Responder, Box<dyn std::error::Error>> {
    let sum: i32 = if let Some(pool) = &data.db_pool {
        match pool.get().await {
            Ok(conn) => {
                match conn.query_one(
                    "SELECT SUM((response->'usage'->>'total_tokens')::real) FROM api_request_logs;",
                    &[],
                ).await {
                    Ok(row) => {
                        match row.get::<_, Option<f32>>("sum") {
                            Some(val) => val as i32,
                            None => 0
                        }
                    },
                    Err(_) => -1 // Unable to query database
                }
            }
            Err(_) => -2, // Unable to get connection
        }
    } else {
        -3 // DB not configured
    };

    let mut env = Environment::new();
    env.set_loader(path_loader("templates"));
    let tmpl = env.get_template("index.jinja")?;

    let ctx = context!(total_tokens => sum, model => data.models.join(","));

    let page = tmpl.render(ctx)?;

    Ok(HttpResponse::Ok().content_type("text/html").body(page))
}

// The main handler for chat completions.
#[post("/chat/completions")]
pub async fn completions(
    data: web::Data<AppState>,
    mut body: web::Json<OpenAiRequest>,
    req: HttpRequest,
) -> Result<impl Responder, Box<dyn std::error::Error>> {
    println!("Request parameters: {body:#?}");

    // validate model
    let default = data.models[0].clone();

    body.model = match &body.model {
        None => Some(default),
        Some(model) => {
            let valid = data.models.contains(model);

            Some(if valid { model.to_string() } else { default })
        }
    };

    let peer_ip = req
        .peer_addr()
        .map(|a| a.ip())
        .unwrap_or_else(|| "0.0.0.0".parse().unwrap());
    let user_agent = req
        .headers()
        .get("user-agent")
        .and_then(|v| v.to_str().ok())
        .map(String::from);

    let res = data
        .http_client
        .post(&data.completions_url)
        .json(&body)
        .send()
        .await?;

    if !res.status().is_success() {
        let status = res.status();
        let error_body = res.text().await?;
        let status_code =
            StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        return Ok(HttpResponse::build(status_code)
            .content_type("application/json")
            .body(error_body));
    }

    if body.stream == Some(true) {
        let stream = res.bytes_stream();
        let lines = stream.map(|result| result.map_err(std::io::Error::other));

        let mut lines = StreamReader::new(lines).lines();

        let mut last_line = String::new();
        let processed_stream = stream! {
            while let Ok(Some(line)) = lines.next_line().await {
                if line != "\n" && line != "data: [DONE]" {
                    last_line.clear();
                    last_line.push_str(&line);
                }

                yield Ok::<Bytes, std::convert::Infallible>(Bytes::from(format!("{line}\n")));
            }

            if let Ok(res) = serde_json::from_str::<Value>(&last_line) {
                log_request(data.db_pool.clone(), &body, peer_ip, user_agent, &res).await;

                log::info!("streaming response: {res:#?}");
            }
        };

        Ok(HttpResponse::Ok()
            .content_type("text/event-stream")
            .streaming(processed_stream))
    } else {
        let res = res.json::<serde_json::Value>().await?;
        log::info!("non-streaming response: {res:#?}");
        log_request(data.db_pool.clone(), &body, peer_ip, user_agent, &res).await;

        Ok(HttpResponse::Ok()
            .content_type("application/json")
            .json(res))
    }
}

// Log requests and responses to the database
async fn log_request(
    db_pool: Option<Pool>,
    body: &OpenAiRequest,
    peer_ip: IpAddr,
    user_agent: Option<String>,
    res: &Value,
) {
    let body = match serde_json::to_string(body) {
        Ok(c) => c,
        Err(e) => {
            log::error!("Failed to serialize body for logging. Root error: {e:?}");
            return;
        }
    };

    let res = match serde_json::to_string(res) {
        Ok(c) => c,
        Err(e) => {
            log::error!("Failed to serialize response for logging. Root error: {e:?}");
            return;
        }
    };

    if let Some(db_pool) = db_pool {
        tokio::task::spawn(async move {
            let conn = match db_pool.get().await {
                Ok(c) => c,
                Err(e) => {
                    log::error!("Failed to get DB connection for logging: {e}");
                    return;
                }
            };

            if let Err(e) = conn.execute(
                    "INSERT INTO api_request_logs (request, response, ip, user_agent) VALUES ($1, $2, $3, $4)",
                    &[&body, &res, &peer_ip, &user_agent]
                ).await {
                    log::error!("Failed to insert log: {e}");
                }
        });
    } else {
        log::info!("{body:?} {res:?} {peer_ip:?} {user_agent:?}");
    }
}

struct AppState {
    http_client: Client,
    completions_url: String,
    models: Vec<String>,

    db_pool: Option<Pool>,
}

#[get("/model")]
async fn get_model(data: web::Data<AppState>) -> impl Responder {
    data.models.join(",")
}

// useful to check if prod build is up to date with the codebase
// note: please update version every push
#[get("/version")]
async fn version() -> impl Responder {
    env!("CARGO_PKG_VERSION")
}

#[actix_web::main]
pub async fn main() -> std::io::Result<()> {
    env_logger::init_from_env(env_logger::Env::new().default_filter_or("info"));

    let api_key = std::env::var("KEY").expect("No API key supplied");
    let models: Vec<_> = std::env::var("VALID_MODELS")
        .expect("No models specified, must be a comma-separated list of valid model IDs")
        .split(',')
        .map(|x| x.to_string())
        .collect();

    let completions_url = std::env::var("COMPLETIONS_URL").expect("No completions url supplied");
    let database_url = std::env::var("DB_URL").ok();

    log::info!("Environment variables:");
    log::info!("  VALID_MODELS: {models:?}",);
    log::info!("  COMPLETIONS_URL: {completions_url:?}",);
    log::info!("  KEY: {api_key}",);
    log::info!(
        "  DB_URL: {}",
        database_url.as_ref().map_or("NOT SET", |v| v)
    );

    // Optional database setup
    let db_pool = async {
        let mut db_cfg = Config::new();
        db_cfg.url = Some(database_url?);
        db_cfg.manager = Some(ManagerConfig {
            recycling_method: RecyclingMethod::Fast,
        });

        let pool = db_cfg
            .create_pool(Some(Runtime::Tokio1), tokio_postgres::NoTls)
            .ok()?;

        let  conn = pool.get().await.ok()?;

        if let Err(e) = conn
            .batch_execute(
                "CREATE TABLE IF NOT EXISTS api_request_logs (
            id SERIAL PRIMARY KEY,
            request JSONB NOT NULL,
            response JSONB NOT NULL,
            ip INET NOT NULL,
            user_agent VARCHAR(512),
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );",
            )
            .await
        {
            log::warn!(
                "Warning: Failed to create 'api_request_logs' table. Logging will be disabled. Original error: {e:?}"
            );
            return None;
        }

        log::info!("Database pool created successfully. Logging is enabled.");
        Some(pool)
    }
    .await;

    HttpServer::new(move || {
        let mut headers = header::HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            header::HeaderValue::from_static("application/json"),
        );

        let bearer = format!("Bearer {api_key}");
        let mut token = header::HeaderValue::from_str(&bearer).unwrap();
        token.set_sensitive(true);
        headers.insert(header::AUTHORIZATION, token);
        let http_client = reqwest::Client::builder()
            .default_headers(headers)
            .build()
            .expect("a successfully built client");

        let app_state = AppState {
            http_client,
            completions_url: completions_url.clone(),
            models: models.clone(),
            db_pool: db_pool.clone(),
        };

        App::new()
            .wrap(
                actix_cors::Cors::default()
                    .allow_any_origin()
                    .allow_any_method()
                    .allow_any_header(),
            )
            .app_data(web::Data::new(app_state))
            .service(index)
            .service(get_model)
            .service(version)
            .service(completions)
            .wrap(Logger::default())
    })
    .bind(("0.0.0.0", 8080))?
    .run()
    .await
}