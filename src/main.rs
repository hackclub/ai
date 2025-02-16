use actix_cors::Cors;
use actix_files::NamedFile;
use actix_web::error::ErrorBadRequest;
use actix_web::{
    get,
    middleware::Logger,
    post,
    web::{self, Bytes},
    App, HttpRequest, HttpResponse, HttpServer, Responder,
};
use async_stream::stream;
use deadpool_postgres::{Config, ManagerConfig, Pool, RecyclingMethod, Runtime};
use futures::stream::BoxStream as _;
use futures::StreamExt;
use minijinja::{context, path_loader, Environment};
use reqwest::{header, Client};
use reqwest_streams::JsonStreamResponse as _;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

fn remove_field(value: &mut serde_json::Value, key: &str) {
    if let serde_json::Value::Object(ref mut map) = value {
        map.remove(key);
    }
}

#[get("/")]
async fn index(data: web::Data<AppState>) -> Result<impl Responder, Box<dyn std::error::Error>> {
    let conn = data.db_pool.get().await.map_err(|e| {
        eprintln!("Failed to get DB connection: {:?}", e);
        actix_web::error::ErrorInternalServerError("Database error")
    })?;
    let sum: f32 = conn
        .query(
            "SELECT SUM((response->'usage'->>'total_tokens')::real) FROM api_request_logs;",
            &[],
        )
        .await?[0]
        .get("sum");
    println!("{:#?}", sum as i32);

    let mut env = Environment::new();
    env.set_loader(path_loader("templates"));
    let tmpl = env.get_template("index.jinja")?;
    let page = tmpl.render(
        context!(total_tokens => (sum as i32), model => std::env::var("COMPLETIONS_MODEL")?),
    )?;

    Ok(HttpResponse::Ok().content_type("text/html").body(page))
}

#[post("/echo")]
async fn echo(req_body: String) -> impl Responder {
    HttpResponse::Ok().body(req_body)
}

async fn manual_hello() -> impl Responder {
    HttpResponse::Ok().body("Hey there!")
}

#[get("/meow")]
async fn meow() -> impl Responder {
    HttpResponse::Ok().body("Meow :3")
}

mod chat {
    use super::*;

    #[derive(Serialize, Deserialize, Debug, Clone)]
    pub struct ChatCompletionMessage {
        role: String,
        content: String,
    }

    #[derive(Serialize, Deserialize, Debug, Clone)]
    pub struct RequestPayload {
        model: Option<String>,
        messages: Vec<ChatCompletionMessage>,
        stream: Option<bool>,
    }

    pub async fn completions(
        data: web::Data<AppState>,
        body: web::Json<RequestPayload>,
        req: HttpRequest,
    ) -> Result<impl Responder, Box<dyn std::error::Error>> {
        if let Some(peer_addr) = req.peer_addr() {
            println!("Address: {:?}", peer_addr.ip().to_string());
        }

        let mut last_error = None;

        for (index, provider) in data.providers.iter().enumerate() {
            if index > 0 {
                println!("Falling back to {}", provider.model);
            }

            let mut headers = header::HeaderMap::new();
            headers.insert(
                header::CONTENT_TYPE,
                header::HeaderValue::from_static("application/json"),
            );
            
            let bearer = format!("Bearer {}", provider.key);
            let mut token = header::HeaderValue::from_str(&bearer).unwrap();
            token.set_sensitive(true);
            headers.insert(header::AUTHORIZATION, token);

            let client = reqwest::Client::builder()
                .default_headers(headers)
                .build()
                .expect("failed to build client");

            let result = try_provider(
                client,
                provider,
                &body,
                data.clone(),
                req.clone(),
            ).await;

            match result {
                Ok(response) => return Ok(response),
                Err(e) => {
                    eprintln!("Provider failed: {:?}", e);
                    last_error = Some(e);
                    continue;
                }
            }
        }

        Err(last_error.unwrap_or_else(|| "No providers available".into()))
    }

    async fn try_provider(
        client: Client,
        provider: &Provider,
        body: &web::Json<RequestPayload>,
        data: web::Data<AppState>,
        req: HttpRequest,
    ) -> Result<HttpResponse, Box<dyn std::error::Error>> {
        let mut res = client
            .post(&provider.url)
            .json(&RequestPayload {
                model: Some(provider.model.clone()),
                messages: body.messages.clone(),
                stream: body.stream,
            })
            .send()
            .await?;

        if body.stream == Some(true) {
            let mut stream_res = res.json_array_stream::<serde_json::Value>(64 * 16);

            let processed_stream = stream! {
                while let Some(item) = stream_res.next().await {
                    match item {
                        Ok(mut val) => {
                            // Save to DB
                            log_reqres(data.clone(), body.clone(), req.clone(), val.clone());

                            remove_field(&mut val, "usage");
                            println!("val: {:#?}", val);

                            match serde_json::to_vec(&val) {
                                Ok(mut bytes) => {
                                    bytes.extend(b"\n");
                                    yield Ok::<Bytes, Box<dyn std::error::Error>>(Bytes::from(bytes));
                                },
                                Err(e) => yield Err::<Bytes, _>(e.into()),
                            }
                        },
                        Err(e) => yield Err::<Bytes, _>(e.into()),
                    }
                    // Force flush after each chunk
                    //tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;
                }
            };

            return Ok(HttpResponse::Ok()
                .content_type("application/json")
                .streaming(Box::pin(processed_stream)));
        } else {
            let mut res_json = res.json::<serde_json::Value>().await?;
            println!("non-streaming resp: {:#?}", res_json);
            log_reqres(data.clone(), body.clone(), req.clone(), res_json.clone());

            remove_field(&mut res_json, "usage");
            Ok(HttpResponse::Ok()
                .content_type("application/json")
                .json(res_json))
        }
    }

    fn log_reqres(
        data: web::Data<AppState>,
        body: RequestPayload,
        req: HttpRequest,
        res: serde_json::Value,
    ) {
        // Extract needed values from HttpRequest before moving into async block
        let peer_ip = req
            .peer_addr()
            .map(|a| a.ip())
            .unwrap_or_else(|| "0.0.0.0".parse().unwrap());

        let user_agent = req
            .headers()
            .get("user-agent")
            .and_then(|v| v.to_str().ok())
            .map(String::from);

        println!("Spawning log task");
        tokio::task::spawn(async move {
            let conn = match data.db_pool.get().await {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("Failed to get DB connection: {}", e);
                    return;
                }
            };

            let body_value = match serde_json::to_value(body /*.into_inner()*/) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("Failed to serialize body: {}", e);
                    return;
                }
            };

            if let Err(e) = conn.execute(
                "INSERT INTO api_request_logs (request, response, ip, user_agent) VALUES ($1, $2, $3, $4)",
                &[&body_value, &res, &peer_ip, &user_agent]
            ).await {
                eprintln!("Failed to insert log: {}", e);
            }
        });
    }
}

struct AppState {
    client: Client,
    db_pool: Pool,
    providers: Vec<Provider>,
}

struct Provider {
    url: String,
    model: String,
    key: String,
}

fn setup_providers() -> Vec<Provider> {
    let mut providers = Vec::new();
    
    if let (Ok(url), Ok(model), Ok(key)) = (
        std::env::var("COMPLETIONS_URL"),
        std::env::var("COMPLETIONS_MODEL"),
        std::env::var("KEY"),
    ) {
        providers.push(Provider { url, model, key });
    }

    if let Ok(key) = std::env::var("GEMINI_KEY") {
        providers.push(Provider {
            url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions".to_string(),
            model: "gemini-2.0-flash".to_string(),
            key,
        });
    }

    if let Ok(key) = std::env::var("GROQ_KEY") {
        providers.push(Provider {
            url: "https://api.groq.com/openai/v1/chat/completions".to_string(),
            model: "llama-3.3-70b-versatile".to_string(),
            key,
        });
    }

    providers
}

#[actix_web::main]
pub async fn main() -> std::io::Result<()> {
    env_logger::init_from_env(env_logger::Env::new().default_filter_or("debug"));

    //#region DB setup
    let mut db_cfg = Config::new();
    db_cfg.url = Some(std::env::var("DB_URL").expect("a Postgres URL").to_string());
    db_cfg.manager = Some(ManagerConfig {
        recycling_method: RecyclingMethod::Fast,
    });
    let db_pool = db_cfg
        .create_pool(Some(Runtime::Tokio1), tokio_postgres::NoTls)
        .unwrap();
    db_pool
        .get()
        .await
        .unwrap()
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
        .unwrap();
    //#endregion

    HttpServer::new(move || {
        let mut headers = header::HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            header::HeaderValue::from_static("application/json"),
        );

        let cors = Cors::default()
            .allow_any_origin()
            .allowed_methods(vec!["GET", "POST"]);

        let bearer = format!("Bearer {}", std::env::var("KEY").expect("an API key"));
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
            providers: setup_providers(),
        };

        App::new()
            .wrap(cors)
            .app_data(web::Data::new(app_state))
            .service(index)
            .service(echo)
            .route("/chat/completions", web::post().to(chat::completions))
            .route("/hey", web::get().to(manual_hello))
            .wrap(Logger::default())
    })
    .bind(("0.0.0.0", 8080))?
    .run()
    .await
}

/*
 * curl https://api.deepseek.com/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <DeepSeek API Key>" \
  -d '{
        "model": "deepseek-chat",
        "messages": [
          {"role": "system", "content": "You are a helpful assistant."},
          {"role": "user", "content": "Hello!"}
        ],
        "stream": false
      }'
*/
