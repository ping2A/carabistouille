//! Carabistouille library: router builder and shared state for the URL analyzer server.

mod api;
pub mod db;
pub mod docker;
pub mod models;
pub mod protocol;
mod state;

use std::time::Duration;

use axum::{
    extract::ConnectInfo,
    routing::{get, post},
    Router,
};
use tower_http::{
    cors::CorsLayer,
    services::ServeDir,
    trace::TraceLayer,
};
use tracing::Span;

pub use state::AppState;

/// Build the application router with the given state.
pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/api/status", get(api::routes::get_status))
        .route("/api/analyses", post(api::routes::create_analysis))
        .route("/api/analyses", get(api::routes::list_analyses))
        .route(
            "/api/analyses/:id",
            get(api::routes::get_analysis)
                .patch(api::routes::update_analysis)
                .delete(api::routes::delete_analysis),
        )
        .route("/api/analyses/:id/stop", post(api::routes::stop_analysis))
        .route(
            "/api/analyses/:id/screenshots",
            get(api::routes::get_screenshots),
        )
        .route(
            "/api/analyses/:id/virustotal",
            get(api::routes::get_virustotal),
        )
        .route("/mcp", post(api::mcp::mcp_handler))
        .route("/ws/agent", get(api::ws::agent_ws_handler))
        .route("/ws/viewer/:id", get(api::ws::viewer_ws_handler))
        .fallback_service(ServeDir::new("web"))
        .layer(CorsLayer::permissive())
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(|req: &axum::http::Request<_>| {
                    let client_ip = req
                        .extensions()
                        .get::<ConnectInfo<std::net::SocketAddr>>()
                        .map(|ci| ci.0.to_string())
                        .unwrap_or_else(|| "-".into());
                    tracing::info_span!(
                        "request",
                        method = %req.method(),
                        uri = %req.uri(),
                        client = %client_ip,
                    )
                })
                .on_response(
                    |res: &axum::http::Response<_>, latency: Duration, _span: &Span| {
                        tracing::info!(
                            status = res.status().as_u16(),
                            latency_ms = latency.as_millis(),
                            "response"
                        );
                    },
                )
                .on_failure(
                    |err: tower_http::classify::ServerErrorsFailureClass,
                     latency: Duration,
                     _span: &Span| {
                        tracing::error!(
                            error = %err,
                            latency_ms = latency.as_millis(),
                            "request failed"
                        );
                    },
                ),
        )
        .with_state(state)
}
