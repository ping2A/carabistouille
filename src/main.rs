mod api;
mod models;
mod protocol;
mod state;

use std::net::SocketAddr;

use axum::{
    routing::{delete, get, post},
    Router,
};
use state::AppState;
use tower_http::{cors::CorsLayer, services::ServeDir};
use tracing_subscriber::EnvFilter;

fn build_router(state: AppState) -> Router {
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

/// Resolve TLS configuration from environment variables.
///
/// Priority:
///   1. TLS_CERT + TLS_KEY  → load PEM files from disk
///   2. TLS_SELF_SIGNED=true → generate an ephemeral self-signed cert
///   3. Neither              → None (plain HTTP)
async fn resolve_tls_config() -> Option<axum_server::tls_rustls::RustlsConfig> {
    use axum_server::tls_rustls::RustlsConfig;

    let cert_path = std::env::var("TLS_CERT").ok();
    let key_path = std::env::var("TLS_KEY").ok();

    if let (Some(cert), Some(key)) = (cert_path, key_path) {
        tracing::info!("Loading TLS certificate from {} / {}", cert, key);
        let config = RustlsConfig::from_pem_file(&cert, &key)
            .await
            .expect("Failed to load TLS certificate/key — check TLS_CERT and TLS_KEY paths");
        return Some(config);
    }

    if std::env::var("TLS_SELF_SIGNED")
        .map(|v| v == "true" || v == "1")
        .unwrap_or(false)
    {
        tracing::info!("Generating self-signed TLS certificate for localhost");
        let rcgen::CertifiedKey { cert, signing_key } =
            rcgen::generate_simple_self_signed(vec![
                "localhost".into(),
                "127.0.0.1".into(),
                "0.0.0.0".into(),
            ])
            .expect("Failed to generate self-signed certificate");

        let cert_pem = cert.pem();
        let key_pem = signing_key.serialize_pem();

        let config = RustlsConfig::from_pem(cert_pem.into(), key_pem.into())
            .await
            .expect("Failed to build RustlsConfig from self-signed cert");
        return Some(config);
    }

    None
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env()
                .add_directive("carabistouille=debug".parse().unwrap()),
        )
        .init();

    let state = AppState::new();
    let app = build_router(state);

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3000);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));

    if let Some(tls_config) = resolve_tls_config().await {
        tracing::info!("Server listening on https://{}", addr);
        axum_server::bind_rustls(addr, tls_config)
            .serve(app.into_make_service())
            .await
            .unwrap();
    } else {
        tracing::info!("Server listening on http://{} (no TLS)", addr);
        let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
        axum::serve(listener, app).await.unwrap();
    }
}
