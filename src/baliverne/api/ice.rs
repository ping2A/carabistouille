//! WebRTC ICE servers API (STUN/TURN). Uses Carabistouille state and reads Baliverne config from it.

use axum::{extract::State, http::HeaderMap, Json};
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
pub struct IceServerEntry {
    pub urls: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub credential: Option<String>,
}

#[derive(Deserialize)]
struct IceServersFile {
    ice_servers: Vec<IceServerEntry>,
}

#[derive(Serialize)]
pub struct WebRtcIceServersResponse {
    pub ice_servers: Vec<IceServerEntry>,
}

fn host_only(host_port: &str) -> &str {
    host_port.split(':').next().unwrap_or(host_port)
}

fn load_ice_servers_from_file(path: &std::path::Path) -> Option<Vec<IceServerEntry>> {
    let data = std::fs::read_to_string(path).ok()?;
    let parsed: IceServersFile = serde_json::from_str(&data).ok()?;
    if parsed.ice_servers.is_empty() {
        return None;
    }
    Some(parsed.ice_servers)
}

pub(crate) fn build_ice_servers(
    carabistouille_state: &crate::state::AppState,
    request_host: Option<&str>,
) -> Vec<IceServerEntry> {
    let state = match carabistouille_state.baliverne.as_ref() {
        Some(b) => b,
        None => return Vec::new(),
    };
    if let Some(ref path) = state.config.ice_servers_file {
        if path.exists() {
            if let Some(list) = load_ice_servers_from_file(path) {
                return list;
            }
        }
    }

    let mut list: Vec<IceServerEntry> = state
        .config
        .ice_servers
        .iter()
        .map(|s| IceServerEntry {
            urls: s.urls.clone(),
            username: s.username.clone(),
            credential: s.credential.clone(),
        })
        .collect();

    let stun_host_raw = state
        .config
        .stun_public_host
        .as_deref()
        .or(state.config.public_host.as_deref())
        .or(request_host);
    if list.is_empty() && state.config.stun_bind.is_some() {
        if let Some(host_port) = stun_host_raw {
            let host = host_only(host_port);
            let port = state.config.stun_bind.as_ref().map(|a| a.port()).unwrap_or(3478);
            list.push(IceServerEntry {
                urls: format!("stun:{}:{}", host, port),
                username: None,
                credential: None,
            });
        }
    }

    if state.config.turn_bind.is_some() {
        let turn_host_raw = state
            .config
            .turn_public_host
            .as_deref()
            .or(state.config.turn_public_ip.as_deref())
            .or(stun_host_raw);
        if let Some(host_port) = turn_host_raw {
            let host = host_only(host_port);
            let port = state.config.turn_bind.as_ref().map(|a| a.port()).unwrap_or(3479);
            list.push(IceServerEntry {
                urls: format!("turn:{}:{}", host, port),
                username: state.config.turn_username.clone(),
                credential: state.config.turn_password.clone(),
            });
        }
    }

    list
}

pub async fn webrtc_ice_servers_handler(
    State(state): State<crate::state::AppState>,
    headers: HeaderMap,
) -> Json<WebRtcIceServersResponse> {
    let request_host = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.split(':').next().unwrap_or(s));
    let ice_servers = build_ice_servers(&state, request_host);
    Json(WebRtcIceServersResponse { ice_servers })
}
