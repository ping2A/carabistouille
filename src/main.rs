//! Server entry point: TLS resolution, router, optional Docker agent, and HTTP/HTTPS listen loop.

use std::net::SocketAddr;
use std::path::PathBuf;

use carabistouille::{build_mcp_router, build_router, AppState};
use tracing_subscriber::EnvFilter;

/// Agent mode: how the server gets browser automation (local process, Docker container, or Baliverne).
#[derive(Clone, Debug)]
pub enum AgentMode {
    /// Expect a local agent to connect to /ws/agent (run `cd agent && npm start` manually).
    Local,
    /// Run the Puppeteer agent in a Docker container (engine, real Chrome, or Lightpanda browser).
    Docker {
        engine: String,
        real_chrome: bool,
        /// Use Lightpanda browser (lightpanda/browser) via CDP instead of Chromium/Chrome.
        lightpanda: bool,
    },
    /// Use Baliverne: one Docker Chrome/Firefox per analysis, X11 dummy driver, WebRTC, STUN/TURN.
    /// Codec and browser can be set via agent string (e.g. baliverne:vp9, baliverne:chrome, baliverne:firefox:h264) or CLI/env.
    Baliverne {
        /// Override video codec (vp8, vp9, h264, av1). None = use env/config default.
        codec: Option<String>,
        /// Override browser (chrome, firefox). None = use env/config default (chrome).
        browser: Option<String>,
    },
}

impl AgentMode {
    /// Parse from string (e.g. from --agent or AGENT env).
    /// Values: "local"|"builtin", "docker", "docker:real", "docker:lightpanda", "baliverne", ...
    pub fn parse(s: &str) -> Result<Self, String> {
        let s = s.trim().to_lowercase();
        if s.is_empty() || s == "local" || s == "builtin" {
            return Ok(AgentMode::Local);
        }
        if s == "baliverne" {
            return Ok(AgentMode::Baliverne {
                codec: None,
                browser: None,
            });
        }
        if let Some(rest) = s.strip_prefix("baliverne:") {
            let parts: Vec<&str> = rest.split(':').map(str::trim).filter(|p| !p.is_empty()).collect();
            let mut codec = None;
            let mut browser = None;
            for p in &parts {
                let lower = (*p).to_lowercase();
                if ["vp8", "vp9", "av1", "h264"].contains(&lower.as_str()) {
                    if codec.replace(lower).is_some() {
                        return Err(format!("Duplicate Baliverne codec in '{}'", rest));
                    }
                } else if ["chrome", "firefox"].contains(&lower.as_str()) {
                    if browser.replace(lower).is_some() {
                        return Err(format!("Duplicate Baliverne browser in '{}'", rest));
                    }
                } else {
                    return Err(format!(
                        "Invalid Baliverne token '{}'. Use: baliverne, baliverne:chrome, baliverne:firefox, baliverne:vp8, baliverne:h264, baliverne:chrome:h264, ...",
                        p
                    ));
                }
            }
            return Ok(AgentMode::Baliverne { codec, browser });
        }
        if s == "docker" {
            return Ok(AgentMode::Docker {
                engine: "puppeteer-extra".to_string(),
                real_chrome: false,
                lightpanda: false,
            });
        }
        if let Some(rest) = s.strip_prefix("docker:") {
            let parts: Vec<&str> = rest.split(':').collect();
            let engine = match parts.get(0).copied() {
                Some("puppeteer") => "puppeteer".to_string(),
                Some("puppeteer-extra") | None => "puppeteer-extra".to_string(),
                Some("lightpanda") => "puppeteer-extra".to_string(), // use puppeteer-extra for Lightpanda CDP
                Some(other) if !other.is_empty() => other.to_string(),
                _ => "puppeteer-extra".to_string(),
            };
            let real_chrome = parts.iter().any(|&p| p == "real");
            let lightpanda = parts.iter().any(|&p| p == "lightpanda");
            return Ok(AgentMode::Docker {
                engine,
                real_chrome,
                lightpanda,
            });
        }
        Err(format!(
            "Unknown agent '{}'. Use: local, docker, docker:real, docker:lightpanda, baliverne, baliverne:chrome, baliverne:firefox, baliverne:vp8, baliverne:chrome:h264, ...",
            s
        ))
    }

    pub fn is_docker(&self) -> bool {
        matches!(self, AgentMode::Docker { .. })
    }

    pub fn is_baliverne(&self) -> bool {
        matches!(self, AgentMode::Baliverne { .. })
    }

    /// Baliverne video codec override from agent string (vp8, vp9, h264, av1). None = use config/env.
    pub fn baliverne_codec(&self) -> Option<&str> {
        match self {
            AgentMode::Baliverne { codec: Some(c), .. } => Some(c.as_str()),
            _ => None,
        }
    }

    /// Baliverne browser override from agent string (chrome, firefox). None = use config/env.
    pub fn baliverne_browser(&self) -> Option<&str> {
        match self {
            AgentMode::Baliverne { browser: Some(b), .. } => Some(b.as_str()),
            _ => None,
        }
    }

    pub fn docker_engine(&self) -> &str {
        match self {
            AgentMode::Docker { engine, .. } => engine.as_str(),
            _ => "puppeteer-extra",
        }
    }

    pub fn docker_real_chrome(&self) -> bool {
        match self {
            AgentMode::Docker { real_chrome, .. } => *real_chrome,
            _ => false,
        }
    }

    pub fn docker_lightpanda(&self) -> bool {
        match self {
            AgentMode::Docker { lightpanda, .. } => *lightpanda,
            _ => false,
        }
    }
}

/// Simple CLI flag parser.
struct CliArgs {
    clean_db: bool,
    database: Option<PathBuf>,
    mcp: bool,
    mcp_port: u16,
    /// Unified agent: local, docker, docker:real, baliverne, baliverne:vp9, baliverne:chrome, etc.
    agent: AgentMode,
    /// Override Baliverne video codec (vp8, vp9, h264, av1). Overridden by codec in --agent baliverne:CODEC.
    baliverne_codec: Option<String>,
    /// Override Baliverne browser (chrome, firefox). Overridden by browser in --agent baliverne:BROWSER.
    baliverne_browser: Option<String>,
    wireguard_config: Option<std::path::PathBuf>,
    listen: Option<String>,
}

/// Parse command-line arguments: --clean-db, --database, --agent, --listen, etc.
fn parse_args() -> CliArgs {
    let args: Vec<String> = std::env::args().collect();
    let clean_db = args.iter().any(|a| a == "--clean-db");
    let mcp = args.iter().any(|a| a == "--mcp")
        || std::env::var("ENABLE_MCP").map(|v| v == "1" || v.eq_ignore_ascii_case("true")).unwrap_or(false);
    let database = args
        .iter()
        .position(|a| a == "--database" || a == "--db")
        .and_then(|i| args.get(i + 1).cloned())
        .map(PathBuf::from);
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

    // Unified --agent; fallback: legacy --docker-agent / --use-baliverne-agent, then AGENT env, then "local"
    let agent_str = args
        .iter()
        .position(|a| a == "--agent")
        .and_then(|i| args.get(i + 1).cloned())
        .or_else(|| {
            if args.iter().any(|a| a == "--use-baliverne-agent")
                || std::env::var("USE_BALIVERNE_AGENT").ok().as_deref() == Some("1")
                || std::env::var("USE_BALIVERNE_AGENT").ok().as_deref() == Some("true")
            {
                Some("baliverne".to_string())
            } else if args.iter().any(|a| a == "--docker-agent") {
                let real = args.iter().any(|a| a == "--real-chrome");
                let engine = args
                    .iter()
                    .position(|a| a == "--browser-engine")
                    .and_then(|i| args.get(i + 1))
                    .cloned()
                    .or_else(|| std::env::var("BROWSER_ENGINE").ok())
                    .unwrap_or_else(|| "puppeteer-extra".to_string());
                Some(if real {
                    format!("docker:{}:real", engine)
                } else {
                    format!("docker:{}", engine)
                })
            } else {
                std::env::var("AGENT").ok()
            }
        })
        .unwrap_or_else(|| "local".to_string());

    let agent = AgentMode::parse(&agent_str).unwrap_or_else(|e| {
        eprintln!("Error: {}", e);
        std::process::exit(1);
    });

    let baliverne_codec = args
        .iter()
        .position(|a| a == "--baliverne-codec")
        .and_then(|i| args.get(i + 1).cloned())
        .or_else(|| std::env::var("BALIVERNE_VIDEO_CODEC").ok())
        .map(|s| {
            let c = s.trim().to_lowercase();
            if ["vp8", "vp9", "av1", "h264"].contains(&c.as_str()) {
                Some(c)
            } else {
                eprintln!("Invalid --baliverne-codec '{}'. Use: vp8, vp9, h264, av1", s);
                std::process::exit(1);
            }
        })
        .flatten();

    let baliverne_browser = args
        .iter()
        .position(|a| a == "--baliverne-browser")
        .and_then(|i| args.get(i + 1).cloned())
        .or_else(|| std::env::var("BALIVERNE_BROWSER").ok())
        .map(|s| {
            let b = s.trim().to_lowercase();
            if b == "chrome" || b == "firefox" {
                Some(b)
            } else {
                eprintln!("Invalid --baliverne-browser '{}'. Use: chrome, firefox", s);
                std::process::exit(1);
            }
        })
        .flatten();

    let mcp_port = args
        .iter()
        .position(|a| a == "--mcp-port")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.parse().ok())
        .or_else(|| std::env::var("MCP_PORT").ok().and_then(|p| p.parse().ok()))
        .unwrap_or(3001);

    CliArgs {
        clean_db,
        database,
        mcp,
        mcp_port,
        agent,
        baliverne_codec,
        baliverne_browser,
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

/// Per-container timeout so one stuck container doesn't block the rest.
const CONTAINER_STOP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
/// Overall cleanup timeout (Docker agent + all Baliverne containers).
const CLEANUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(45);

/// On shutdown: stop and remove Docker agent container (if any), then stop and remove all Baliverne containers.
/// Each step is time-bounded so we don't hang if Docker or a container is unresponsive.
async fn run_cleanup(
    docker_agent_enabled: bool,
    baliverne_state: Option<&std::sync::Arc<carabistouille::baliverne::state::AppState>>,
) {
    let cleanup = async {
        if docker_agent_enabled {
            tracing::info!("Stopping and removing Docker agent container...");
            if let Err(_) =
                tokio::time::timeout(CONTAINER_STOP_TIMEOUT, carabistouille::docker::stop_container()).await
            {
                tracing::warn!(
                    "Docker agent stop timed out after {:?} — container may still be running",
                    CONTAINER_STOP_TIMEOUT
                );
            } else {
                tracing::info!("Docker agent container stopped");
            }
        }

        if let Some(b) = baliverne_state {
            let rooms = b.list_rooms().await;
            if !rooms.is_empty() {
                tracing::info!(count = rooms.len(), "Stopping and removing Baliverne container(s) from room list...");
                for room in &rooms {
                    let Some(ref cid) = room.container_id else { continue };
                    match tokio::time::timeout(
                        CONTAINER_STOP_TIMEOUT,
                        b.docker.stop_container(cid),
                    )
                    .await
                    {
                        Ok(Ok(())) => {
                            tracing::debug!(container_id = %cid, "Baliverne container stopped");
                        }
                        Ok(Err(e)) => {
                            tracing::warn!(container_id = %cid, error = %e, "failed to stop Baliverne container");
                        }
                        Err(_) => {
                            tracing::warn!(
                                container_id = %cid,
                                "Baliverne container stop timed out after {:?}",
                                CONTAINER_STOP_TIMEOUT
                            );
                        }
                    }
                }
            }
            // Safety net: list all Docker containers named baliverne-* and stop any remaining (e.g. rooms already removed or missed).
            tracing::info!("Stopping any remaining Baliverne containers (Docker name prefix baliverne-)...");
            b.docker.stop_all_baliverne_containers().await;
            tracing::info!("Baliverne cleanup finished");
        }
    };

    if let Err(_) = tokio::time::timeout(CLEANUP_TIMEOUT, cleanup).await {
        tracing::warn!(
            "Cleanup timed out after {:?} — stop the server and run: docker ps -a && docker rm -f <ids> if needed",
            CLEANUP_TIMEOUT
        );
    }
}

/// Initialize logging, build router, optionally start Docker agent, bind with or without TLS, and run the server.
#[tokio::main]
async fn main() {
    // Required by rustls 0.23: select a process-level crypto provider before any TLS use (axum-server, reqwest).
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("rustls default crypto provider");

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env()
                .add_directive("carabistouille=debug".parse().unwrap()),
        )
        .init();

    let cli = parse_args();

    let db_path: PathBuf = cli
        .database
        .or_else(|| std::env::var("DATABASE_PATH").ok().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("carabistouille.db"));

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

    let (baliverne, analysis_to_baliverne, baliverne_room_to_analysis) =
        if cli.agent.is_baliverne() {
            tracing::info!("Baliverne agent enabled (Docker sessions, X11, WebRTC)");
            let mut config = carabistouille::baliverne::config::Config::from_env(addr);
            if let Some(c) = cli.agent.baliverne_codec() {
                config.video_codec = c.to_string();
                tracing::info!(codec = %c, "Baliverne video codec from --agent");
            } else if let Some(ref c) = cli.baliverne_codec {
                config.video_codec = c.clone();
                tracing::info!(codec = %c, "Baliverne video codec from --baliverne-codec / BALIVERNE_VIDEO_CODEC");
            }
            if let Some(b) = cli.agent.baliverne_browser() {
                if let Ok(kind) = b.parse::<carabistouille::baliverne::state::BrowserKind>() {
                    config.browser = kind;
                    tracing::info!(browser = %b, "Baliverne browser from --agent");
                }
            } else if let Some(ref b) = cli.baliverne_browser {
                if let Ok(kind) = b.parse::<carabistouille::baliverne::state::BrowserKind>() {
                    config.browser = kind;
                    tracing::info!(browser = %b, "Baliverne browser from --baliverne-browser / BALIVERNE_BROWSER");
                }
            }
            if let Some(bind) = config.stun_bind {
                tracing::info!(%bind, "STUN server listening (ICE)");
                let bind = bind;
                tokio::spawn(async move {
                    if let Err(e) = carabistouille::baliverne::stun::run(bind).await {
                        tracing::error!(error = %e, "STUN failed");
                    }
                });
            }
            if let (Some(bind_addr), Some(public_ip_str)) = (config.turn_bind, config.turn_public_ip.as_ref()) {
                if let Ok(public_ip) = public_ip_str.parse::<std::net::IpAddr>() {
                    tracing::info!(%bind_addr, "TURN server listening");
                    let cfg = carabistouille::baliverne::turn_relay::TurnRelayConfig {
                        bind_addr,
                        relay_public_ip: public_ip,
                        realm: config.turn_realm.clone(),
                        auth_static: config
                            .turn_username
                            .clone()
                            .zip(config.turn_password.clone()),
                        auth_dynamic_registry: None,
                    };
                    tokio::spawn(async move {
                        if let Err(e) = carabistouille::baliverne::turn_relay::run_turn_relay(cfg).await {
                            tracing::error!(error = ?e, "TURN failed");
                        }
                    });
                }
            }
            let baliverne_state = std::sync::Arc::new(
                carabistouille::baliverne::state::AppState::new(config),
            );
            let analysis_to_baliverne = std::sync::Arc::new(dashmap::DashMap::new());
            let baliverne_room_to_analysis = std::sync::Arc::new(dashmap::DashMap::new());
            (
                Some(baliverne_state),
                Some(analysis_to_baliverne),
                Some(baliverne_room_to_analysis),
            )
        } else {
            (None, None, None)
        };

    let baliverne_for_cleanup = baliverne.clone();
    let state = AppState::new(
        analyses,
        db_tx,
        cli.agent.is_docker(),
        cli.agent.docker_real_chrome(),
        cli.agent.docker_lightpanda(),
        cli.mcp,
        baliverne,
        analysis_to_baliverne,
        baliverne_room_to_analysis,
    );
    // When MCP is enabled, serve it on a separate port; main app omits /mcp. When MCP disabled, /mcp returns 404 on main port.
    let app = build_router(state.clone(), !cli.mcp);

    // Resolve TLS early so the Docker agent can use wss:// when the main server uses HTTPS.
    let tls_config = resolve_tls_config().await;

    // --- Docker agent management ---
    let _docker_log_handle: Option<tokio::task::JoinHandle<()>> = if cli.agent.is_docker() {
        tracing::info!(
            "Docker agent mode enabled (engine={}, real_chrome={})",
            cli.agent.docker_engine(),
            cli.agent.docker_real_chrome()
        );

        let skip_build = std::env::var("SKIP_AGENT_BUILD")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);

        if !skip_build {
            let agent_dir = std::env::var("AGENT_DIR").unwrap_or_else(|_| "agent".to_string());
            let agent_path = std::path::Path::new(&agent_dir)
                .canonicalize()
                .unwrap_or_else(|_| std::path::PathBuf::from(&agent_dir));

            if let Err(e) = carabistouille::docker::ensure_image(&agent_path).await {
                tracing::error!("Failed to build Docker agent image: {}", e);
                std::process::exit(1);
            }
        } else {
            tracing::info!("Skipping Docker image build (SKIP_AGENT_BUILD=1)");
        }

        match carabistouille::docker::start_container(
            addr.port(),
            tls_config.is_some(),
            cli.agent.docker_engine(),
            cli.agent.docker_real_chrome(),
            cli.agent.docker_lightpanda(),
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
        tracing::info!(
            "Local agent mode (start the agent manually or use --agent docker)"
        );
        None
    };

    // When MCP is enabled, run the MCP server on a separate port. Always plain HTTP so MCP clients
    // (e.g. LM Studio) that expect HTTP get a valid response. Use http://host:MCP_PORT/mcp in the client.
    if cli.mcp {
        let mcp_addr = SocketAddr::new(addr.ip(), cli.mcp_port);
        let mcp_app = build_mcp_router(state);
        tracing::info!("MCP server listening on http://{} (POST /mcp)", mcp_addr);
        tokio::spawn(async move {
            let listener = tokio::net::TcpListener::bind(mcp_addr).await.unwrap();
            axum::serve(
                listener,
                mcp_app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });
    }

    let docker_agent_enabled = cli.agent.is_docker();
    let use_tls = tls_config.is_some();

    // Single shutdown gate: Ctrl+C and SIGTERM (Unix) both notify this. Main task selects on it.
    let shutdown = std::sync::Arc::new(tokio::sync::Notify::new());

    // Spawn: Ctrl+C (SIGINT) → notify shutdown
    let shutdown_ctrl_c = shutdown.clone();
    tokio::spawn(async move {
        match tokio::signal::ctrl_c().await {
            Ok(()) => {
                tracing::info!("Ctrl+C received — shutting down");
                shutdown_ctrl_c.notify_waiters();
            }
            Err(e) => tracing::error!(error = %e, "Failed to listen for Ctrl+C"),
        }
    });

    // Spawn (Unix only): SIGTERM → notify shutdown
    #[cfg(unix)]
    {
        let shutdown_sigterm = shutdown.clone();
        tokio::spawn(async move {
            use tokio::signal::unix::{signal, SignalKind};
            let mut sig = match signal(SignalKind::terminate()) {
                Ok(s) => s,
                Err(e) => {
                    tracing::debug!(error = %e, "SIGTERM listener not installed");
                    return;
                }
            };
            if sig.recv().await.is_some() {
                tracing::info!("SIGTERM received — shutting down");
                shutdown_sigterm.notify_waiters();
            }
        });
    }

    // Start server in a task: HTTP with graceful shutdown, or TLS (no built-in graceful shutdown)
    let shutdown_for_graceful = shutdown.clone();
    let mut server_handle = if let Some(cfg) = tls_config {
        let addr = addr;
        let app = app.clone();
        tracing::info!("Server listening on https://{}", addr);
        tokio::spawn(async move {
            axum_server::bind_rustls(addr, cfg)
                .serve(app.into_make_service_with_connect_info::<SocketAddr>())
                .await
                .unwrap();
        })
    } else {
        let addr = addr;
        let app = app.clone();
        let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
        let shutdown_owned = shutdown_for_graceful.clone();
        tracing::info!("Server listening on http://{} (no TLS)", addr);
        tokio::spawn(async move {
            let shutdown_fut = async move { shutdown_owned.notified().await };
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(shutdown_fut)
            .await
            .unwrap();
        })
    };

    tokio::select! {
        biased;

        // Shutdown requested (Ctrl+C or SIGTERM): wait for server to stop, run cleanup, then exit
        _ = shutdown.notified() => {
            tracing::info!("Shutdown in progress…");
            if use_tls {
                // TLS server has no graceful shutdown; do not block on it
                drop(server_handle);
            } else {
                // HTTP: server is draining; wait for it to finish
                match server_handle.await {
                    Ok(()) => tracing::info!("Server stopped"),
                    Err(e) => tracing::debug!(error = %e, "Server task join error"),
                }
            }
            run_cleanup(docker_agent_enabled, baliverne_for_cleanup.as_ref()).await;
            tracing::info!("Shutdown complete");
            if use_tls {
                std::process::exit(0);
            }
        }

        // Server exited on its own (e.g. bind error or panic)
        res = &mut server_handle => {
            if let Err(e) = res {
                tracing::error!(error = %e, "Server task panicked or failed");
                run_cleanup(docker_agent_enabled, baliverne_for_cleanup.as_ref()).await;
                std::process::exit(1);
            }
        }
    }
}
