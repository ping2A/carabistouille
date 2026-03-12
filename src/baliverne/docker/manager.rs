//! Docker container lifecycle: create Chrome/Firefox sessions with optional GPU.

use crate::baliverne::config::Config;
use crate::baliverne::state::BrowserKind;
use bollard::container::{
    Config as ContainerConfig, CreateContainerOptions, ListContainersOptions,
    RemoveContainerOptions, StartContainerOptions, StopContainerOptions,
};
use bollard::service::DeviceMapping;
use bollard::Docker;
use std::sync::Arc;
use tracing::{debug, error, info, warn};
use uuid::Uuid;

pub struct DockerManager {
    docker: Arc<Docker>,
    chrome_image: String,
    firefox_image: String,
    gpu_devices: Option<Vec<String>>,
    server_host: String,
    runtime_debug: bool,
    video_codec: String,
    rtp_fps: u32,
    neko_input_socket: Option<String>,
}

impl DockerManager {
    pub fn new(config: Config) -> Self {
        let docker = Docker::connect_with_local_defaults().unwrap_or_else(|e| {
            warn!(error = %e, "Docker connection failed; container start will fail");
            panic!("Docker is required for Baliverne agent; start Docker and try again.");
        });
        info!("Baliverne Docker client connected");
        let server_host = if let Some(ref h) = config.public_host {
            let s = h.trim();
            if s.contains(':') {
                s.to_string()
            } else {
                format!("{}:{}", s, config.listen.port())
            }
        } else {
            let a = config.listen;
            let port = a.port();
            let host: String = if a.ip().is_loopback() || a.ip().is_unspecified() {
                "host.docker.internal".to_string()
            } else {
                a.ip().to_string()
            };
            format!("{}:{}", host, port)
        };
        debug!(%server_host, "container server URL");
        Self {
            docker: Arc::new(docker),
            chrome_image: config.chrome_image,
            firefox_image: config.firefox_image,
            gpu_devices: config.gpu_devices,
            server_host,
            runtime_debug: config.runtime_debug,
            video_codec: config.video_codec,
            rtp_fps: config.rtp_fps,
            neko_input_socket: config.neko_input_socket,
        }
    }

    pub async fn start_session(
        &self,
        session_id: Uuid,
        browser: BrowserKind,
        webrtc_rtp: Option<(String, u16)>,
    ) -> Result<String, String> {
        let image = match browser {
            BrowserKind::Chrome => self.chrome_image.as_str(),
            BrowserKind::Firefox => self.firefox_image.as_str(),
        };
        let name = format!("baliverne-{}", session_id.as_simple());
        let ws_url = format!("ws://{}/ws/session/{}", self.server_host, session_id);

        debug!(%image, "checking if image exists");
        if let Err(e) = self.docker.inspect_image(image).await {
            error!(
                %image,
                error = %e,
                "image not found — build with: docker build -f docker/chrome/Dockerfile -t baliverne-chrome:latest ."
            );
            return Err(format!(
                "image {} not found: {}. Build with: docker build -f docker/chrome/Dockerfile -t {} .",
                image, e, image
            ));
        }

        info!(%session_id, image = %image, name = %name, ws_url = %ws_url, "creating container");
        let mut env = vec![
            format!("BALIVERNE_WS_URL={}", ws_url),
            format!("BALIVERNE_SESSION_ID={}", session_id),
            format!("BALIVERNE_BROWSER={}", format!("{:?}", browser).to_lowercase()),
        ];
        if let Some((ref rtp_host, rtp_port)) = webrtc_rtp {
            env.push(format!("BALIVERNE_RTP_HOST={}", rtp_host));
            env.push(format!("BALIVERNE_RTP_PORT={}", rtp_port));
            env.push(format!("BALIVERNE_VIDEO_CODEC={}", self.video_codec));
            env.push(format!("BALIVERNE_RTP_FPS={}", self.rtp_fps));
        }
        if self.runtime_debug {
            env.push("BALIVERNE_DEBUG=1".to_string());
        }
        if let Some(ref path) = self.neko_input_socket {
            env.push(format!("BALIVERNE_NEKO_INPUT_SOCKET={}", path));
        }

        let mut host_config = bollard::service::HostConfig::default();
        if let Some(ref devices) = self.gpu_devices {
            host_config.devices = Some(
                devices
                    .iter()
                    .map(|d| DeviceMapping {
                        path_on_host: Some(d.clone()),
                        path_in_container: Some(d.clone()),
                        cgroup_permissions: Some("rwm".to_string()),
                    })
                    .collect(),
            );
        }
        host_config.extra_hosts = Some(vec!["host.docker.internal:host-gateway".to_string()]);
        host_config.shm_size = Some(2 * 1024 * 1024 * 1024_i64);
        host_config.auto_remove = Some(true);

        let config = ContainerConfig {
            image: Some(image.to_string()),
            env: Some(env),
            host_config: Some(host_config),
            ..Default::default()
        };

        let create_opts = CreateContainerOptions {
            name: name.clone(),
            platform: None,
        };

        let id = match self.docker.create_container(Some(create_opts), config).await {
            Ok(create_result) => {
                let id = create_result.id;
                info!(%session_id, container_id = %id, "container created");
                id
            }
            Err(e) => {
                error!(%session_id, image = %image, error = %e, "create_container failed");
                return Err(format!("create container: {}", e));
            }
        };

        if let Err(e) = self.docker.start_container(&id, None::<StartContainerOptions<String>>).await
        {
            error!(%id, error = %e, "start_container failed");
            let _ = self.docker.remove_container(&id, None).await;
            return Err(format!("start container: {}", e));
        }
        info!(session_id = %session_id, container_id = %id, "container started");

        Ok(id)
    }

    pub async fn stop_container(&self, container_id: &str) -> Result<(), String> {
        const STOP_GRACE_SECS: i64 = 10;
        debug!(%container_id, "stopping container");
        if let Err(e) = self
            .docker
            .stop_container(container_id, Some(StopContainerOptions { t: STOP_GRACE_SECS }))
            .await
        {
            let msg = e.to_string();
            if !msg.contains("404") && !msg.contains("no such container") && !msg.contains("not found") {
                warn!(%container_id, error = %e, "stop container failed");
            }
        }
        match self
            .docker
            .remove_container(
                container_id,
                Some(RemoveContainerOptions {
                    force: true,
                    ..Default::default()
                }),
            )
            .await
        {
            Ok(()) => {
                info!(%container_id, "container removed");
                Ok(())
            }
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("404") || msg.contains("no such container") || msg.contains("not found")
                {
                    Ok(())
                } else if msg.contains("409") || msg.contains("already in progress") {
                    Ok(())
                } else {
                    error!(%container_id, error = %e, "remove container failed");
                    Err(format!("remove container: {}", e))
                }
            }
        }
    }

    /// List all Docker containers whose name starts with "baliverne-", then stop and remove each.
    /// Used on server shutdown as a safety net so no Baliverne containers are left running.
    pub async fn stop_all_baliverne_containers(&self) {
        let opts = ListContainersOptions::<String> {
            all: true,
            ..Default::default()
        };
        let list = match self.docker.list_containers(Some(opts)).await {
            Ok(l) => l,
            Err(e) => {
                warn!(error = %e, "list_containers failed, skipping Baliverne shutdown cleanup");
                return;
            }
        };
        for summary in list {
            let names = summary.names.as_deref().unwrap_or(&[]);
            let is_baliverne = names.iter().any(|n| n.trim_start_matches('/').starts_with("baliverne-"));
            if !is_baliverne {
                continue;
            }
            let id = summary.id.as_deref().unwrap_or("<no-id>");
            info!(container_id = %id, names = ?names, "stopping stray Baliverne container");
            if let Err(e) = self.stop_container(id).await {
                warn!(container_id = %id, error = %e, "failed to stop stray Baliverne container");
            }
        }
    }
}
