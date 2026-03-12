//! Docker agent manager: build image, start/stop container for the Puppeteer agent.
//!
//! Activated by passing `--agent docker` (or `docker:real`, `docker:lightpanda`) to the server binary.
//! The container runs the agent which connects back to the host server via WebSocket.
//! With `docker:lightpanda`, a Lightpanda browser container is started first and the agent connects to it via CDP.

use std::process::Stdio;
use tokio::process::Command;

const IMAGE_NAME: &str = "carabistouille-agent";
const CONTAINER_NAME: &str = "carabistouille-agent";
const LIGHTPANDA_IMAGE: &str = "lightpanda/browser:nightly";
const LIGHTPANDA_CONTAINER: &str = "carabistouille-lightpanda";
const LIGHTPANDA_NETWORK: &str = "carabistouille-net";
const LIGHTPANDA_CDP_PORT: u16 = 9222;

/// Path to the docker binary. Tries PATH first, then common install locations (e.g. when run from IDE with minimal PATH).
fn docker_binary() -> String {
    if which_docker().is_some() {
        return "docker".to_string();
    }
    #[cfg(unix)]
    {
        for path in ["/usr/local/bin/docker", "/opt/homebrew/bin/docker"] {
            if std::path::Path::new(path).is_file() {
                return path.to_string();
            }
        }
    }
    "docker".to_string()
}

#[cfg(unix)]
fn which_docker() -> Option<std::path::PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        for dir in std::env::split_paths(&paths) {
            let docker = dir.join("docker");
            if docker.is_file() {
                return Some(docker);
            }
        }
        None
    })
}

#[cfg(not(unix))]
fn which_docker() -> Option<std::path::PathBuf> {
    None
}

/// Ensure the Docker image is built (from `agent/Dockerfile`).
/// `agent_dir` should be an absolute path to the agent directory (contains Dockerfile, package.json, etc.).
pub async fn ensure_image(agent_dir: &std::path::Path) -> Result<(), String> {
    if !agent_dir.is_dir() {
        return Err(format!(
            "Agent directory does not exist or is not a directory: {}",
            agent_dir.display()
        ));
    }
    let docker = docker_binary();
    tracing::info!("Building Docker image '{}' from {}", IMAGE_NAME, agent_dir.display());

    let output = Command::new(&docker)
        .args(["build", "--platform", "linux/amd64", "-t", IMAGE_NAME, "."])
        .current_dir(agent_dir)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .output()
        .await
        .map_err(|e| {
            if e.raw_os_error() == Some(2) {
                format!(
                    "Docker not found. Ensure Docker Desktop is running and 'docker' is in your PATH, or build the image manually:\n  cd agent && docker build --platform linux/amd64 -t {} .",
                    IMAGE_NAME
                )
            } else {
                format!("Failed to run docker build: {e}")
            }
        })?;

    if !output.status.success() {
        return Err("docker build failed — check output above".into());
    }
    tracing::info!("Docker image '{}' ready", IMAGE_NAME);
    Ok(())
}

/// Start the Lightpanda browser container and create network. No-op if image pull/run fails (logs and returns Err).
async fn start_lightpanda_container(docker: &str) -> Result<(), String> {
    // Remove stale Lightpanda container if any
    let _ = Command::new(docker)
        .args(["rm", "-f", LIGHTPANDA_CONTAINER])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await;

    tracing::info!("Creating network '{}' (if not exists)", LIGHTPANDA_NETWORK);
    let _ = Command::new(docker)
        .args(["network", "create", LIGHTPANDA_NETWORK])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await;

    tracing::info!("Starting Lightpanda browser container '{}' (image: {})", LIGHTPANDA_CONTAINER, LIGHTPANDA_IMAGE);
    let out = Command::new(docker)
        .args([
            "run",
            "-d",
            "--platform",
            "linux/amd64",
            "--name",
            LIGHTPANDA_CONTAINER,
            "--network",
            LIGHTPANDA_NETWORK,
            "-p",
            &format!("{}:{}", LIGHTPANDA_CDP_PORT, LIGHTPANDA_CDP_PORT),
            LIGHTPANDA_IMAGE,
        ])
        .output()
        .await
        .map_err(|e| format!("Failed to run Lightpanda container: {e}"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("Lightpanda container start failed: {stderr}. Pull the image with: docker pull {LIGHTPANDA_IMAGE}"));
    }
    tracing::info!("Lightpanda container '{}' started (CDP on port {})", LIGHTPANDA_CONTAINER, LIGHTPANDA_CDP_PORT);
    Ok(())
}

/// Start the agent container (removes any stale container first).
/// When `lightpanda` is true, starts the Lightpanda browser container first and passes BROWSER_WS_ENDPOINT to the agent.
/// `server_port` is the host port the server listens on.
/// `use_tls`: if true, the main server uses HTTPS, so the agent must connect with wss://.
/// `browser_engine` selects puppeteer or puppeteer-extra inside the container.
/// `real_chrome`: if true, run Chrome in headed mode (HEADLESS=false) with Xvfb for a more realistic browser.
/// `lightpanda`: if true, run Lightpanda browser in a separate container and connect the agent to it via CDP.
/// `wireguard_config`: if Some(path), mount the WireGuard config and run with NET_ADMIN so all traffic goes through the VPN.
pub async fn start_container(
    server_port: u16,
    use_tls: bool,
    browser_engine: &str,
    real_chrome: bool,
    lightpanda: bool,
    wireguard_config: Option<&std::path::Path>,
) -> Result<String, String> {
    let docker = docker_binary();

    if lightpanda {
        start_lightpanda_container(&docker).await?;
    }

    // Remove stale agent container if any
    let _ = Command::new(&docker)
        .args(["rm", "-f", CONTAINER_NAME])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await;

    let scheme = if use_tls { "wss" } else { "ws" };
    let server_url = format!("{scheme}://host.docker.internal:{server_port}/ws/agent");

    tracing::info!(
        "Starting Docker agent container '{}' (engine={}, server={}, real_chrome={}, lightpanda={}, wireguard={})",
        CONTAINER_NAME,
        browser_engine,
        server_url,
        real_chrome,
        lightpanda,
        wireguard_config.is_some(),
    );

    let server_url_env = format!("SERVER_URL={server_url}");
    let browser_engine_env = format!("BROWSER_ENGINE={browser_engine}");
    let lightpanda_env = lightpanda.then(|| {
        format!("BROWSER_WS_ENDPOINT=ws://{}:{}", LIGHTPANDA_CONTAINER, LIGHTPANDA_CDP_PORT)
    });

    let mut args = vec![
        "run",
        "-d",
        "--platform",
        "linux/amd64",
        "--name",
        CONTAINER_NAME,
        "--add-host=host.docker.internal:host-gateway",
        "--shm-size=512m",
        "-e",
        server_url_env.as_str(),
        "-e",
        browser_engine_env.as_str(),
    ];
    if lightpanda {
        args.push("--network");
        args.push(LIGHTPANDA_NETWORK);
        if let Some(ref e) = lightpanda_env {
            args.push("-e");
            args.push(e.as_str());
        }
    }
    if real_chrome {
        args.push("-e");
        args.push("HEADLESS=false");
    }
    let wireguard_volume = if let Some(path) = wireguard_config {
        let path_str = path
            .to_str()
            .ok_or_else(|| "WireGuard config path is not valid UTF-8".to_string())?;
        if !path.exists() {
            return Err(format!(
                "WireGuard config path does not exist: {}",
                path.display()
            ));
        }
        Some(format!("{}:/etc/wireguard/wg0.conf:ro", path_str))
    } else {
        None
    };
    if let Some(ref vol) = wireguard_volume {
        args.push("--cap-add=NET_ADMIN");
        args.push("--sysctl");
        args.push("net.ipv4.conf.all.src_valid_mark=1");
        args.push("-v");
        args.push(vol.as_str());
        args.push("-e");
        args.push("WIREGUARD_CONFIG_PATH=/etc/wireguard/wg0.conf");
    }
    args.push(IMAGE_NAME);

    let output = Command::new(&docker)
        .args(args)
        .output()
        .await
        .map_err(|e| format!("Failed to run docker run: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("docker run failed: {stderr}"));
    }

    let container_id = String::from_utf8_lossy(&output.stdout).trim().to_string();
    tracing::info!(
        "Docker agent container started: {} (id: {})",
        CONTAINER_NAME,
        &container_id[..12.min(container_id.len())]
    );
    Ok(container_id)
}

/// Stop and remove the agent container (and Lightpanda container if present). Uses `docker rm -f`.
/// Logs but does not fail; idempotent (no-op if containers already gone).
pub async fn stop_container() {
    let docker = docker_binary();
    tracing::info!("Stopping and removing Docker agent container '{}'", CONTAINER_NAME);
    match Command::new(&docker)
        .args(["rm", "-f", CONTAINER_NAME])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
    {
        Ok(s) if s.success() => tracing::info!("Docker agent container '{}' removed", CONTAINER_NAME),
        Ok(s) => {
            if s.code() != Some(1) {
                tracing::warn!(code = ?s.code(), "docker rm -f {} failed", CONTAINER_NAME);
            }
        }
        Err(e) => tracing::warn!(error = %e, "failed to run docker rm -f {}", CONTAINER_NAME),
    }
    tracing::info!("Stopping and removing Lightpanda container '{}' (if present)", LIGHTPANDA_CONTAINER);
    match Command::new(&docker)
        .args(["rm", "-f", LIGHTPANDA_CONTAINER])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
    {
        Ok(s) if s.success() => tracing::info!("Lightpanda container '{}' removed", LIGHTPANDA_CONTAINER),
        Ok(s) if s.code() == Some(1) => {}
        Ok(s) => tracing::warn!(code = ?s.code(), "docker rm -f {} failed", LIGHTPANDA_CONTAINER),
        Err(e) => tracing::warn!(error = %e, "failed to run docker rm -f {}", LIGHTPANDA_CONTAINER),
    }
}

/// Stream container logs to the server's stdout (spawns a background task).
pub fn stream_logs() -> tokio::task::JoinHandle<()> {
    let docker = docker_binary();
    tokio::spawn(async move {
        let _ = Command::new(&docker)
            .args(["logs", "-f", CONTAINER_NAME])
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status()
            .await;
    })
}
