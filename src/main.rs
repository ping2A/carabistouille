//! Server entry point: TLS resolution, router, optional Docker agent, and HTTP/HTTPS listen loop.

use std::net::SocketAddr;
use std::path::PathBuf;

use carabistouille::{build_router, AppState};
use tracing_subscriber::EnvFilter;

/// Simple CLI flag parser (avoids adding clap for a handful of flags).
struct CliArgs {
    clean_db: bool,
    /// Start the agent inside a Docker container instead of expecting a local agent.
    docker_agent: bool,
    /// Browser engine passed into the Docker container (puppeteer | puppeteer-extra).
    browser_engine: String,
    /// When using --docker-agent: run Chrome in headed mode (real Chrome) with Xvfb for better anti-detection.
    real_chrome: bool,
    /// When using --docker-agent: path to WireGuard config so all agent traffic goes through the VPN.
    wireguard_config: Option<std::path::PathBuf>,
    /// Override listen address (host:port). Takes precedence over HOST and PORT.
    listen: Option<String>,
}

/// Parse command-line arguments: --clean-db, --docker-agent, --real-chrome, --browser-engine, --wireguard-config.
fn parse_args() -> CliArgs {
    let args: Vec<String> = std::env::args().collect();
    let clean_db = args.iter().any(|a| a == "--clean-db");
    let docker_agent = args.iter().any(|a| a == "--docker-agent");
    let real_chrome = args.iter().any(|a| a == "--real-chrome");

    let browser_engine = args
        .iter()
        .position(|a| a == "--browser-engine")
        .and_then(|i| args.get(i + 1))
        .cloned()
        .or_else(|| std::env::var("BROWSER_ENGINE").ok())
        .unwrap_or_else(|| "puppeteer-extra".to_string());

    let wireguard_config = args
        .iter()
        .position(|a| a == "--wireguard-config")
        .and_then(|i| args.get(i + 1))
        .cloned()
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var("WIREGUARD_CONFIG_PATH").ok().map(std::path::PathBuf::from));

    let listen = args
        .iter()
        .position(|a| a == "--listen")
        .and_then(|i| args.get(i + 1))
        .cloned()
        .or_else(|| std::env::var("LISTEN").ok());

    CliArgs {
        clean_db,
        docker_agent,
        browser_engine,
        real_chrome,
        wireguard_config,
        listen,
    }
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

/// Initialize logging, build router, optionally start Docker agent, bind with or without TLS, and run the server.
#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env()
                .add_directive("carabistouille=debug".parse().unwrap()),
        )
        .init();

    let cli = parse_args();

    let db_path: PathBuf = std::env::var("DATABASE_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("carabistouille.db"));

    if cli.clean_db {
        if db_path.exists() {
            if let Err(e) = std::fs::remove_file(&db_path) {
                tracing::warn!("Could not remove database {:?}: {}", db_path, e);
            } else {
                tracing::info!("Database cleaned: {:?} removed", db_path);
            }
        } else {
            tracing::info!("Database clean requested but {:?} does not exist", db_path);
        }
    }

    let analyses = carabistouille::db::load_analyses(&db_path)
        .unwrap_or_else(|e| {
            tracing::warn!("Could not load analyses from {:?}: {} — starting with empty list", db_path, e);
            Vec::new()
        });
    tracing::info!("Loaded {} analyses from {:?}", analyses.len(), db_path);

    let (db_tx, _db_handle) = carabistouille::db::run_db_thread(&db_path)
        .expect("Failed to start SQLite DB thread");

    let state = AppState::new(analyses, db_tx, cli.docker_agent, cli.real_chrome);
    let app = build_router(state);

    let addr: SocketAddr = if let Some(ref listen_str) = cli.listen {
        listen_str
            .parse()
            .unwrap_or_else(|_| panic!("Invalid --listen / LISTEN address '{}' (use host:port, e.g. 127.0.0.1:3000)", listen_str))
    } else {
        let host_str = std::env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_string());
        let host: std::net::IpAddr = host_str
            .parse()
            .unwrap_or_else(|_| panic!("Invalid HOST '{}' (use an IP address)", host_str));
        let port: u16 = std::env::var("PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(3000);
        SocketAddr::new(host, port)
    };

    // --- Docker agent management ---
    let _docker_log_handle: Option<tokio::task::JoinHandle<()>> = if cli.docker_agent {
        tracing::info!(
            "Docker agent mode enabled (engine={}, real_chrome={})",
            cli.browser_engine,
            cli.real_chrome
        );

        let agent_dir = std::env::var("AGENT_DIR").unwrap_or_else(|_| "agent".to_string());

        if let Err(e) = carabistouille::docker::ensure_image(&agent_dir).await {
            tracing::error!("Failed to build Docker agent image: {}", e);
            std::process::exit(1);
        }

        match carabistouille::docker::start_container(
            addr.port(),
            &cli.browser_engine,
            cli.real_chrome,
            cli.wireguard_config.as_deref(),
        )
        .await {
            Ok(_container_id) => {
                tracing::info!("Docker agent container started — logs streaming below:");
                Some(carabistouille::docker::stream_logs())
            }
            Err(e) => {
                tracing::error!("Failed to start Docker agent container: {}", e);
                std::process::exit(1);
            }
        }
    } else {
        tracing::info!("Local agent mode (start the agent manually or use --docker-agent)");
        None
    };

    // Register shutdown handler to clean up the Docker container
    let docker_agent_enabled = cli.docker_agent;
    tokio::spawn(async move {
        tokio::signal::ctrl_c()
            .await
            .expect("Failed to listen for ctrl-c");
        if docker_agent_enabled {
            carabistouille::docker::stop_container().await;
        }
        std::process::exit(0);
    });

    if let Some(tls_config) = resolve_tls_config().await {
        tracing::info!("Server listening on https://{}", addr);
        axum_server::bind_rustls(addr, tls_config)
            .serve(app.into_make_service_with_connect_info::<SocketAddr>())
            .await
            .unwrap();
    } else {
        tracing::info!("Server listening on http://{} (no TLS)", addr);
        let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    }
}
