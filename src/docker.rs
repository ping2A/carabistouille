//! Docker agent manager: build image, start/stop container for the Puppeteer agent.
//!
//! Activated by passing `--docker-agent` to the server binary.
//! The container runs the agent which connects back to the host server via WebSocket.

use std::process::Stdio;
use tokio::process::Command;

const IMAGE_NAME: &str = "carabistouille-agent";
const CONTAINER_NAME: &str = "carabistouille-agent";

/// Ensure the Docker image is built (from `agent/Dockerfile`).
pub async fn ensure_image(agent_dir: &str) -> Result<(), String> {
    tracing::info!("Building Docker image '{}' from {}", IMAGE_NAME, agent_dir);

    let output = Command::new("docker")
        .args(["build", "--platform", "linux/amd64", "-t", IMAGE_NAME, "."])
        .current_dir(agent_dir)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .output()
        .await
        .map_err(|e| format!("Failed to run docker build: {e}"))?;

    if !output.status.success() {
        return Err("docker build failed — check output above".into());
    }
    tracing::info!("Docker image '{}' ready", IMAGE_NAME);
    Ok(())
}

/// Start the agent container (removes any stale container first).
/// `server_port` is the host port the server listens on.
/// `browser_engine` selects puppeteer or puppeteer-extra inside the container.
/// `real_chrome`: if true, run Chrome in headed mode (HEADLESS=false) with Xvfb for a more realistic browser.
pub async fn start_container(
    server_port: u16,
    browser_engine: &str,
    real_chrome: bool,
) -> Result<String, String> {
    // Remove stale container if any
    let _ = Command::new("docker")
        .args(["rm", "-f", CONTAINER_NAME])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await;

    let server_url = format!("ws://host.docker.internal:{server_port}/ws/agent");

    tracing::info!(
        "Starting Docker agent container '{}' (engine={}, server={}, real_chrome={})",
        CONTAINER_NAME,
        browser_engine,
        server_url,
        real_chrome,
    );

    let server_url_env = format!("SERVER_URL={server_url}");
    let browser_engine_env = format!("BROWSER_ENGINE={browser_engine}");

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
    if real_chrome {
        args.push("-e");
        args.push("HEADLESS=false");
    }
    args.push(IMAGE_NAME);

    let output = Command::new("docker")
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

/// Stop and remove the agent container. Logs but does not fail.
pub async fn stop_container() {
    tracing::info!("Stopping Docker agent container '{}'", CONTAINER_NAME);
    let _ = Command::new("docker")
        .args(["rm", "-f", CONTAINER_NAME])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await;
}

/// Stream container logs to the server's stdout (spawns a background task).
pub fn stream_logs() -> tokio::task::JoinHandle<()> {
    tokio::spawn(async {
        let _ = Command::new("docker")
            .args(["logs", "-f", CONTAINER_NAME])
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status()
            .await;
    })
}
