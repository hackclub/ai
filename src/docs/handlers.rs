use axum::{
    Json,
    response::{Html, IntoResponse},
};
use maud::html;
use utoipa::{OpenApi, openapi::ServerBuilder};

use crate::{ApiDoc, PROD_DOMAIN};

pub async fn docs() -> impl IntoResponse {
    Html(html! {
		html {
			head {
				title { "Hack Club AI Service" }
				script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference" {}
			}
			body {
				div id="app" {}
				script { "const app = Scalar.createApiReference('#app', { url: '/openapi.json', hideDownloadButton: true, hideClientButton: true, hideModels: true });" }
			}
		}
	}.into_string())
}

pub async fn openapi_axle() -> impl IntoResponse {
    let mut openapi = ApiDoc::openapi();
    openapi.servers = Some(vec![
        ServerBuilder::new()
            .url(PROD_DOMAIN)
            .description(Some("Production"))
            .build(),
    ]);
    Json(openapi)
}
