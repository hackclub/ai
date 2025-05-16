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
use serde_json::Value;
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

mod chat {
    use super::*;

    #[derive(Serialize, Deserialize, Debug, Clone)]
    pub struct FunctionCall {
        name: String,
        arguments: String, // JSON string
    }

    #[derive(Serialize, Deserialize, Debug, Clone)]
    pub struct ToolCall {
        id: Option<String>,
        #[serde(rename = "type")]
        call_type: String, // Usually "function"
        function: FunctionCall,
    }

    #[derive(Serialize, Deserialize, Debug, Clone)]
    pub struct ChatCompletionMessage {
        role: String,
        content: Option<String>, // Make content optional for tool responses
        #[serde(skip_serializing_if = "Option::is_none")]
        tool_calls: Option<Vec<ToolCall>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>, // For tool responses
        #[serde(skip_serializing_if = "Option::is_none")]
        tool_call_id: Option<String>, // For tool responses
    }

    #[derive(Serialize, Deserialize, Debug, Clone)]
    pub struct FunctionParameters {
        #[serde(rename = "type")]
        param_type: String,
        properties: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        required: Option<Vec<String>>,
    }

    #[derive(Serialize, Deserialize, Debug, Clone)]
    pub struct FunctionDefinition {
        name: String,
        description: String,
        parameters: FunctionParameters,
    }

    #[derive(Serialize, Deserialize, Debug, Clone)]
    pub struct ToolDefinition {
        #[serde(rename = "type")]
        tool_type: String, // Usually "function"
        function: FunctionDefinition,
    }

    #[derive(Serialize, Deserialize, Debug, Clone)]
    pub struct RequestPayload {
        model: Option<String>,
        messages: Vec<ChatCompletionMessage>,
        stream: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        tools: Option<Vec<ToolDefinition>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        tool_choice: Option<Value>, // Can be "auto", "none", or a specific tool
    }

    pub async fn completions(
        data: web::Data<AppState>,
        body: web::Json<RequestPayload>,
        req: HttpRequest,
    ) -> Result<impl Responder, Box<dyn std::error::Error>> {
        if let Some(peer_addr) = req.peer_addr() {
            println!("Address: {:?}", peer_addr.ip().to_string());
        }

        println!("{:?}", req.headers());

        let mut forward_payload = RequestPayload {
            model: Some(std::env::var("COMPLETIONS_MODEL").unwrap().to_string()),
            messages: body.messages.clone(),
            stream: body.stream,
            tools: body.tools.clone(),
            tool_choice: body.tool_choice.clone(),
        };

        let mut res = data
            .client
            .post(std::env::var("COMPLETIONS_URL").unwrap())
            .json(&forward_payload)
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
                }
            };

            return Ok(HttpResponse::Ok()
                .content_type("application/x-ndjson")
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

            let body_value = match serde_json::to_value(body) {
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
}

#[get("/model")]
async fn get_model() -> Result<impl Responder, Box<dyn std::error::Error>> {
    let model = std::env::var("COMPLETIONS_MODEL")?;
    Ok(HttpResponse::Ok().body(model))
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
