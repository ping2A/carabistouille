//! WebRTC (webrtc-rs): ICE servers and peer connection config.

use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::configuration::RTCConfiguration;

use crate::baliverne::api::ice::IceServerEntry;

pub fn ice_servers_from_api(entries: &[IceServerEntry]) -> Vec<RTCIceServer> {
    entries
        .iter()
        .map(|e| {
            let urls: Vec<String> = e
                .urls
                .split_whitespace()
                .map(std::string::ToString::to_string)
                .collect();
            RTCIceServer {
                urls,
                username: e.username.clone().unwrap_or_default(),
                credential: e.credential.clone().unwrap_or_default(),
            }
        })
        .collect()
}

pub fn peer_connection_config(ice_servers: Vec<RTCIceServer>) -> RTCConfiguration {
    RTCConfiguration {
        ice_servers,
        ..Default::default()
    }
}
