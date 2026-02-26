//! Carabistouille library: router builder and shared state for the URL analyzer server.

mod api;
pub mod db;
pub mod models;
mod protocol;
mod state;

use axum::{
    routing::{delete, get, post},
    Router,
};
use tower_http::{cors::CorsLayer, services::ServeDir};

pub use state::AppState;

/// Build the application router with the given state.
pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/api/status", get(api::routes::get_status))
        .route("/api/analyses", post(api::routes::create_analysis))
        .route("/api/analyses", get(api::routes::list_analyses))
        .route("/api/analyses/:id", get(api::routes::get_analysis))
        .route("/api/analyses/:id/stop", post(api::routes::stop_analysis))
        .route(
            "/api/analyses/:id/screenshots",
            get(api::routes::get_screenshots),
        )
        .route("/api/analyses/:id", delete(api::routes::delete_analysis))
        .route("/ws/agent", get(api::ws::agent_ws_handler))
        .route("/ws/viewer/:id", get(api::ws::viewer_ws_handler))
        .fallback_service(ServeDir::new("web"))
        .layer(CorsLayer::permissive())
        .with_state(state)
}
