//! Carabistouille library: router builder and shared state for the URL analyzer server.

pub mod baliverne;
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
/// When `include_mcp_route` is true, POST /mcp is registered (returns 404 if MCP disabled).
/// When MCP is enabled (--mcp), the main app typically omits /mcp and MCP is served on a separate port via `build_mcp_router`.
pub fn build_router(state: AppState, include_mcp_route: bool) -> Router {
    let mut app = Router::new()
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
        );
    if include_mcp_route {
        app = app.route("/mcp", post(api::mcp::mcp_handler));
    }
    app = app
        .route("/ws/agent", get(api::ws::agent_ws_handler))
        .route("/ws/viewer/:id", get(api::ws::viewer_ws_handler));
    if state.baliverne.is_some() {
        let baliverne_routes: axum::Router<AppState> = baliverne::ws::ws_router(state.clone());
        app = app.merge(baliverne_routes).route(
            "/api/webrtc-ice-servers",
            axum::routing::get(baliverne::api::ice::webrtc_ice_servers_handler),
        );
    }
    app = app.fallback_service(ServeDir::new("web"));

    app.layer(CorsLayer::permissive())
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

/// Build a minimal router that only serves POST /mcp (MCP JSON-RPC). Used when MCP is enabled
/// and bound to a separate port (e.g. MCP_PORT=3001). Shares the same AppState as the main server.
pub fn build_mcp_router(state: AppState) -> Router {
    Router::new()
        .route("/mcp", post(api::mcp::mcp_handler))
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
                        "mcp_request",
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
                            "MCP request completed"
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
                            "MCP request failed"
                        );
                    },
                ),
        )
        .with_state(state)
}
