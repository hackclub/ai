use actix_web::{
    get,
    middleware::Logger,
    web::{self, Bytes},
    App, HttpRequest, HttpResponse, HttpServer, Responder, http::StatusCode,
    error::ErrorBadRequest,
};
use async_stream::stream;
use deadpool_postgres::{Config, ManagerConfig, Pool, RecyclingMethod, Runtime};
use futures::StreamExt;
use minijinja::{context, path_loader, Environment};
use reqwest::{header, Client};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

// Remove a field from a JSON object - used to remove unwanted fields before returning response
fn remove_field(value: &mut Value, key: &str) {
    if let Value::Object(map) = value {
        map.remove(key);
    }
}

#[get("/")]
async fn index(data: web::Data<AppState>) -> Result<impl Responder, Box<dyn std::error::Error>> {
    // Gracefully handle the case where the database is not configured.
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
            },
            Err(_) => -1 // Unable to get connection
        }
    } else {
        -1 // DB not configured
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

mod embeddings {
    use super::*;
    use serde::{Deserialize, Serialize};
    use serde_json::Value;

    #[derive(Serialize, Deserialize, Debug, Clone)]
    pub struct EmbeddingsRequest {
        pub model: Option<String>,
        pub input: String,
    }

    pub async fn handler(
        data: web::Data<AppState>,
        mut body: web::Json<EmbeddingsRequest>,
        req: HttpRequest,
    ) -> Result<impl Responder, Box<dyn std::error::Error>> {
        // Override model with environment variable
        body.model = Some(std::env::var("EMBEDDINGS_MODEL").unwrap().to_string());
        
        println!("Embeddings request:");
        println!("  Model: {:?}", body.model);
        println!("  Input: {}", body.input);

        let res = data
            .client
            .post(std::env::var("EMBEDDINGS_URL").unwrap())
            .json(&body.into_inner())
            .send()
            .await?;

        let res_json = res.json::<serde_json::Value>().await?;
        
        // Log the embeddings request
        if let Some(db_pool) = data.db_pool.clone() {
            let peer_ip = req
                .peer_addr()
                .map(|a| a.ip())
                .unwrap_or_else(|| "0.0.0.0".parse().unwrap());
            let user_agent = req
                .headers()
                .get("user-agent")
                .and_then(|v| v.to_str().ok())
                .map(String::from);

            tokio::task::spawn(async move {
                if let Ok(conn) = db_pool.get().await {
                    let body_value = serde_json::to_value(body).unwrap();
                    let body_string = body_value.to_string();
                    let res_string = res_json.to_string();
                    
                    if let Err(e) = conn.execute(
                        "INSERT INTO api_request_logs (request, response, ip, user_agent) VALUES ($1, $2, $3, $4)",
                        &[&body_string, &res_string, &peer_ip, &user_agent]
                    ).await {
                        eprintln!("Failed to insert embeddings log: {}", e);
                    }
                }
            });
        }

        Ok(HttpResponse::Ok()
            .content_type("application/json")
            .json(res_json))
    }
}


mod chat {
    use super::*;
    #[derive(Serialize, Deserialize, Debug, Clone)]
    pub struct ChatCompletionMessage {
        pub role: String,
        pub content: String,
    }

    // Defines the structure for a tool's function definition.
    #[derive(Serialize, Deserialize, Debug, Clone)]
    pub struct Function {
        pub name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub description: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub parameters: Option<Value>,
    }

    // Defines a tool that the model can call.
    #[derive(Serialize, Deserialize, Debug, Clone)]
    pub struct Tool {
        #[serde(rename = "type")]
        pub tool_type: String, // Typically "function"
        pub function: Function,
    }

    // Controls how the model should use tools.
    #[derive(Serialize, Deserialize, Debug, Clone)]
    #[serde(untagged)]
    pub enum ToolChoice {
        String(String), // e.g., "none", "auto"
        Object {
            #[serde(rename = "type")]
            tool_type: String,
            function: HashMap<String, String>,
        },
    }

    // Specifies the format of the response, e.g., for enabling JSON mode.
    #[derive(Serialize, Deserialize, Debug, Clone)]
    pub struct ResponseFormat {
        #[serde(rename = "type")]
        pub format_type: String,
    }

    // The main request payload, made to include standard Groq/OpenAI parameters
    #[derive(Serialize, Deserialize, Debug, Clone)]
    pub struct RequestPayload {
        pub messages: Vec<ChatCompletionMessage>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub model: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub frequency_penalty: Option<f32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub logit_bias: Option<HashMap<String, f32>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub max_tokens: Option<i32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub presence_penalty: Option<f32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub response_format: Option<ResponseFormat>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub reasoning_format: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub reasoning_effort: Option<String>, // Added reasoning_effort parameter
        #[serde(skip_serializing_if = "Option::is_none")]
        pub seed: Option<i32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub stop: Option<Vec<String>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub stream: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub temperature: Option<f32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub top_p: Option<f32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub tools: Option<Vec<Tool>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub tool_choice: Option<ToolChoice>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub user: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub include_reasoning: Option<bool>,
    }

    // The main handler for chat completions.
    pub async fn completions(
        data: web::Data<AppState>,
        mut body: web::Json<RequestPayload>,
        req: HttpRequest,
    ) -> Result<impl Responder, Box<dyn std::error::Error>> {
        // As requested, ignore the model specified by the user and use the one from env vars.
        body.model = Some(std::env::var("COMPLETIONS_MODEL").unwrap().to_string());
        
        // Debug log request parameters
        println!("Request parameters:");
        println!("  Model: {:?}", body.model);
        println!("  Messages count: {}", body.messages.len());
        println!("  Stream: {:?}", body.stream);
        println!("  Temperature: {:?}", body.temperature);
        println!("  Max tokens: {:?}", body.max_tokens);
        println!("  Top-p: {:?}", body.top_p);
        println!("  Presence penalty: {:?}", body.presence_penalty);
        println!("  Frequency penalty: {:?}", body.frequency_penalty);
        println!("  Response format: {:?}", body.response_format);
        println!("  Reasoning format: {:?}", body.reasoning_format);
        println!("  Reasoning effort: {:?}", body.reasoning_effort); // Added reasoning_effort logging
        println!("  Tools: {:?}", body.tools.as_ref().map(|t| t.len()));
        println!("  Tool choice: {:?}", body.tool_choice);
        println!("  Include reasoning: {:?}", body.include_reasoning);
        
        // Clone the necessary parts for logging before the body is consumed.
        let log_body = body.clone();
        let log_req = req.clone();

        let res = data
            .client
            .post(std::env::var("COMPLETIONS_URL").unwrap())
            .json(&body.into_inner()) // Send the full payload to Groq
            .send()
            .await?;

        // Handle potential errors from the upstream API (e.g., unsupported feature)
        if !res.status().is_success() {
            let status = res.status();
            let error_body = res.text().await?;
            let status_code = StatusCode::from_u16(status.as_u16())
                .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            return Ok(HttpResponse::build(status_code)
                .content_type("application/json")
                .body(error_body));
        }

        if log_body.stream == Some(true) {
            // Use bytes_stream instead of json_array_stream for proper NDJSON handling
            let mut stream_res = res.bytes_stream();
            
            let processed_stream = stream! {
                let mut buffer = String::new();
                
                while let Some(chunk) = stream_res.next().await {
                    match chunk {
                        Ok(bytes) => {
                            // Add new bytes to buffer
                            buffer.push_str(&String::from_utf8_lossy(&bytes));
                            
                            // Process complete lines
                            while let Some(newline_pos) = buffer.find('\n') {
                                // Extract complete line
                                let line = buffer[..newline_pos].to_string();
                                let remaining = buffer[newline_pos + 1..].to_string();
                                buffer = remaining;
                                
                                let line = line.trim();
                                
                                // Skip empty lines
                                if line.is_empty() {
                                    continue;
                                }
                                
                                // Skip the data: prefix if present
                                let json_str = if line.starts_with("data: ") {
                                    &line[6..]
                                } else {
                                    line
                                };
                                
                                // Check for stream end
                                if json_str == "[DONE]" {
                                    // Stream is finished
                                    break;
                                }
                                
                                // Parse JSON
                                match serde_json::from_str::<Value>(json_str) {
                                    Ok(mut val) => {
                                        log_reqres(data.clone(), log_body.clone(), log_req.clone(), val.clone());
                                        remove_field(&mut val, "usage");
                                        println!("val: {:#?}", val);

                                        match serde_json::to_vec(&val) {
                                            Ok(mut bytes) => {
                                                bytes.extend(b"\n");
                                                yield Ok::<Bytes, Box<dyn std::error::Error>>(Bytes::from(bytes));
                                            },
                                            Err(e) => {
                                                eprintln!("Serialization error: {}", e);
                                                yield Err::<Bytes, _>(e.into());
                                            }
                                        }
                                    },
                                    Err(e) => {
                                        eprintln!("JSON parsing error for line '{}': {}", json_str, e);
                                        // Continue processing other lines
                                        continue;
                                    }
                                }
                            }
                        },
                        Err(e) => {
                            eprintln!("Stream error: {}", e);
                            yield Err::<Bytes, _>(e.into());
                            break;
                        }
                    }
                }
                
                // Process any remaining data in buffer
                let line = buffer.trim();
                if !line.is_empty() && line != "[DONE]" {
                    let json_str = if line.starts_with("data: ") {
                        &line[6..]
                    } else {
                        line
                    };
                    
                    if let Ok(mut val) = serde_json::from_str::<Value>(json_str) {
                        log_reqres(data.clone(), log_body.clone(), log_req.clone(), val.clone());
                        remove_field(&mut val, "usage");
                        println!("val: {:#?}", val);

                        if let Ok(mut bytes) = serde_json::to_vec(&val) {
                            bytes.extend(b"\n");
                            yield Ok::<Bytes, Box<dyn std::error::Error>>(Bytes::from(bytes));
                        }
                    }
                }
            };

            return Ok(HttpResponse::Ok()
                .content_type("application/x-ndjson")
                .streaming(Box::pin(processed_stream)));
        } else {
            let mut res_json = res.json::<serde_json::Value>().await?;
            println!("non-streaming resp: {:#?}", res_json);
            log_reqres(data.clone(), log_body, log_req, res_json.clone());

            remove_field(&mut res_json, "usage");
            Ok(HttpResponse::Ok()
                .content_type("application/json")
                .json(res_json))
        }
    }

    // Log requests and responses to the database
    fn log_reqres(
        data: web::Data<AppState>,
        body: RequestPayload,
        req: HttpRequest,
        res: Value,
    ) {
        // Only proceed if the database pool is available.
        if let Some(db_pool) = data.db_pool.clone() {
            let peer_ip = req
                .peer_addr()
                .map(|a| a.ip())
                .unwrap_or_else(|| "0.0.0.0".parse().unwrap());
            let user_agent = req
                .headers()
                .get("user-agent")
                .and_then(|v| v.to_str().ok())
                .map(String::from);

            tokio::task::spawn(async move {
                let conn = match db_pool.get().await {
                    Ok(c) => c,
                    Err(e) => {
                        eprintln!("Failed to get DB connection for logging: {}", e);
                        return;
                    }
                };
                let body_value = match serde_json::to_value(body) {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!("Failed to serialize body for logging: {}", e);
                        return;
                    }
                };
                let body_string = body_value.to_string();
                let res_string = res.to_string();
                if let Err(e) = conn.execute(
                    "INSERT INTO api_request_logs (request, response, ip, user_agent) VALUES ($1, $2, $3, $4)",
                    &[&body_string, &res_string, &peer_ip, &user_agent]
                ).await {
                    eprintln!("Failed to insert log: {}", e);
                }
            });
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

    // Show environment variables status
    println!("Environment variables:");
    println!("  COMPLETIONS_MODEL: {:?}", std::env::var("COMPLETIONS_MODEL").unwrap_or_else(|_| "NOT SET".to_string()));
    println!("  COMPLETIONS_URL: {:?}", std::env::var("COMPLETIONS_URL").unwrap_or_else(|_| "NOT SET".to_string()));
    println!("  EMBEDDINGS_MODEL: {:?}", std::env::var("EMBEDDINGS_MODEL").unwrap_or_else(|_| "NOT SET".to_string()));
    println!("  EMBEDDINGS_URL: {:?}", std::env::var("EMBEDDINGS_URL").unwrap_or_else(|_| "NOT SET".to_string()));
    println!("  KEY: {:?}", std::env::var("KEY").unwrap_or_else(|_| "NOT SET".to_string()));
    println!("  DB_URL: {:?}", std::env::var("DB_URL").unwrap_or_else(|_| "NOT SET".to_string()));

    // Optional database setup
    let db_pool = if let Ok(db_url) = std::env::var("DB_URL") {
        let mut db_cfg = Config::new();
        db_cfg.url = Some(db_url);
        db_cfg.manager = Some(ManagerConfig {
            recycling_method: RecyclingMethod::Fast,
        });
        match db_cfg.create_pool(Some(Runtime::Tokio1), tokio_postgres::NoTls) {
            Ok(pool) => {
                // Test connection and create table
                match pool.get().await {
                    Ok(conn) => {
                        if let Err(e) = conn.batch_execute(
                            "CREATE TABLE IF NOT EXISTS api_request_logs (
                                id SERIAL PRIMARY KEY,
                                request JSONB NOT NULL,
                                response JSONB NOT NULL,
                                ip INET NOT NULL,
                                user_agent VARCHAR(512),
                                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
                            );",
                        ).await {
                            eprintln!("Warning: Failed to create 'api_request_logs' table: {}. Logging will be disabled.", e);
                            None
                        } else {
                            println!("Database pool created successfully. Logging is enabled.");
                            Some(pool)
                        }
                    },
                    Err(e) => {
                        eprintln!("Warning: Failed to get DB connection from pool: {}. Logging will be disabled.", e);
                        None
                    }
                }
            },
            Err(e) => {
                eprintln!("Warning: Could not create database pool: {}. Logging will be disabled.", e);
                None
            }
        }
    } else {
        println!("Warning: DB_URL environment variable not set. Logging will be disabled.");
        None
    };

    HttpServer::new(move || {
        let mut headers = header::HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            header::HeaderValue::from_static("application/json"),
        );
        
        // Check if KEY is set and provide a better error message
        let api_key = std::env::var("KEY").unwrap_or_else(|_| {
            eprintln!("ERROR: KEY environment variable is not set!");
            std::process::exit(1);
        });
        
        let bearer = format!("Bearer {}", api_key);
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
            .route("/embeddings", web::post().to(embeddings::handler))
            .route("/hey", web::get().to(manual_hello))
            .wrap(Logger::default())
    })
    .bind(("0.0.0.0", 8080))?
    .run()
    .await
}
