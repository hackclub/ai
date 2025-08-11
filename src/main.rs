//! hackclub/ai
//! a free open-source completions endpoint for hackclubbers!
//!
//! maintained at https://github.com/hackclub/ai
//!
//! ## Running
//! ### Environment variables
//! `COMPLETIONS_MODEL`: The default execution model
//! `COMPLETIONS_URL`: Base URL for the API
//! `KEY`: API Key for the completions URL

use actix_web::{
    get,
    http::StatusCode,
    middleware::Logger,
    web::{self, Bytes},
    App, HttpRequest, HttpResponse, HttpServer, Responder,
};
use async_stream::stream;
use deadpool_postgres::{Config, ManagerConfig, Pool, RecyclingMethod, Runtime};
use futures::StreamExt;
use minijinja::{context, path_loader, Environment};
use reqwest::{header, Client};

use serde_json::Value;

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
                    Err(_) => 0 // Unable to query database
                }
            }
            Err(_) => 0, // Unable to get connection
        }
    } else {
        0 // DB not configured
    };

    let mut env = Environment::new();
    env.set_loader(path_loader("templates"));
    let tmpl = env.get_template("index.jinja")?;

    let ctx = if sum >= 0 {
        context!(total_tokens => sum, model => std::env::var("COMPLETIONS_MODEL")?)
    } else {
        context!(total_tokens => -1, model => std::env::var("COMPLETIONS_MODEL")?)
    };

    let page = tmpl.render(ctx)?;

    Ok(HttpResponse::Ok().content_type("text/html").body(page))
}

mod chat {
    use tokio::io::AsyncBufReadExt;
    use tokio_util::io::StreamReader;

    use super::*;
    use crate::openai::OpenAiRequest;

    // The main handler for chat completions.
    pub async fn completions(
        data: web::Data<AppState>,
        body: web::Json<OpenAiRequest>,
        req: HttpRequest,
    ) -> Result<impl Responder, Box<dyn std::error::Error>> {
        println!("Request parameters: {body:#?}");

        let res = data
            .client
            .post(std::env::var("COMPLETIONS_URL").unwrap())
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
                    if !line.is_empty() && line != "data: [DONE]" {
                        last_line.clear();
                        last_line.push_str(&line);
                    }

                    yield Ok::<Bytes, std::convert::Infallible>(Bytes::from(format!("{line}\n")));
                }

                if let Ok(val) = serde_json::from_str::<Value>(&last_line) {
                    log_reqres(data, &body, &req, &val).await;

                    println!("val: {val:#?}");
                }
            };

            Ok(HttpResponse::Ok()
                .content_type("application/x-ndjson")
                .streaming(Box::pin(processed_stream)))
        } else {
            let res_json = res.json::<serde_json::Value>().await?;
            println!("non-streaming resp: {res_json:#?}");
            log_reqres(data, &body, &req, &res_json).await;

            Ok(HttpResponse::Ok()
                .content_type("application/json")
                .json(res_json))
        }
    }

    // Log requests and responses to the database
    async fn log_reqres(
        data: web::Data<AppState>,
        body: &OpenAiRequest,
        req: &HttpRequest,
        res: &Value,
    ) {
        if let Some(db_pool) = &data.db_pool {
            let peer_ip = req
                .peer_addr()
                .map(|a| a.ip())
                .unwrap_or_else(|| "0.0.0.0".parse().unwrap());
            let user_agent = req
                .headers()
                .get("user-agent")
                .and_then(|v| v.to_str().ok())
                .map(String::from);

            let conn = match db_pool.get().await {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("Failed to get DB connection for logging: {e}");
                    return;
                }
            };

            let body = match serde_json::to_string(body) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("Failed to serialize body for logging. Root error: {e:?}");
                    return;
                }
            };

            let res = match serde_json::to_string(res) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("Failed to serialize response for logging. Root error: {e:?}");
                    return;
                }
            };

            if let Err(e) = conn.execute(
                    "INSERT INTO api_request_logs (request, response, ip, user_agent) VALUES ($1, $2, $3, $4)",
                    &[&body, &res, &peer_ip, &user_agent]
                ).await {
                    eprintln!("Failed to insert log: {e}");
                }
        }
    }
}

struct AppState {
    client: Client,
    db_pool: Option<Pool>, // The database pool is now optional
}

#[get("/model")]
async fn get_model() -> Result<impl Responder, Box<dyn std::error::Error>> {
    let model = std::env::var("COMPLETIONS_MODEL")?;
    Ok(HttpResponse::Ok().body(model))
}

#[get("/echo")]
async fn echo(req_body: String) -> impl Responder {
    HttpResponse::Ok().body(req_body)
}

async fn manual_hello() -> impl Responder {
    HttpResponse::Ok().body("Hey there!")
}

#[actix_web::main]
pub async fn main() -> std::io::Result<()> {
    env_logger::init_from_env(env_logger::Env::new().default_filter_or("info"));

    let api_key = std::env::var("KEY").expect("No API key supplied");
    let model = std::env::var("COMPLETIONS_MODEL").expect("No default completions model supplied");
    let completions_url = std::env::var("COMPLETIONS_URL").expect("No completions url supplied");

    let database_url = std::env::var("DB_URL");

    println!("Environment variables:");
    println!("  COMPLETIONS_MODEL: {model:?}",);
    println!("  COMPLETIONS_URL: {completions_url:?}",);
    println!("  KEY: {api_key:?}",);
    println!(
        "  DB_URL: {:?}",
        database_url.as_ref().map_or("NOT SET", |v| v)
    );

    // Optional database setup
    let db_pool = async {
        let database_url = database_url.ok()?;

        let mut db_cfg = Config::new();
        db_cfg.url = Some(database_url);
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
            eprintln!(
                "Warning: Failed to create 'api_request_logs' table. Logging will be disabled. Original error: {e:?}"
            );
            return None;
        }

        println!("Database pool created successfully. Logging is enabled.");
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
        let client = reqwest::Client::builder()
            .default_headers(headers)
            .build()
            .expect("a successfully built client");

        let app_state = AppState {
            client,
            db_pool: db_pool.clone(),
        };

        App::new()
            .wrap(actix_cors::Cors::permissive())
            .app_data(web::Data::new(app_state))
            .service(index)
            .service(echo)
            .service(get_model)
            .route("/chat/completions", web::post().to(chat::completions))
            .route("/hey", web::get().to(manual_hello))
            .wrap(Logger::default())
    })
    .bind(("0.0.0.0", 8080))?
    .run()
    .await
}
