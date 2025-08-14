use std::{
    error::Error,
    fmt,
    io::{Error as IoError, ErrorKind},
};

use axum::{
    body::Body,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;
use tracing::error;

#[derive(Debug)]
pub struct APIError {
    pub code: StatusCode,
    pub body: Option<&'static str>,
}

impl IntoResponse for APIError {
    fn into_response(self) -> Response<Body> {
        let reason = self
            .body
            .or(self.code.canonical_reason())
            .unwrap_or("Unknown error");
        error!("Status code based error: {reason}");

        let body: Body = json!({ "error": reason }).to_string().into();

        Response::builder()
            .status(self.code)
            .header("Content-Type", "application/json")
            .body(body)
            .unwrap()
    }
}

impl From<Box<dyn Error + Send + Sync + 'static>> for APIError {
    fn from(err: Box<dyn Error + Send + Sync + 'static>) -> Self {
        error!("API Error: {err}");
        APIError {
            code: StatusCode::INTERNAL_SERVER_ERROR,
            body: Some("Internal server error"),
        }
    }
}

impl fmt::Display for APIError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.body.unwrap_or("Unknown error"))
    }
}

impl Error for APIError {}

impl From<APIError> for IoError {
    fn from(api_error: APIError) -> Self {
        IoError::new(ErrorKind::Other, api_error.body.unwrap_or("Unknown error"))
    }
}
