//! Baliverne server configuration: Docker images, WebRTC ICE/STUN/TURN, RTP ports.

use std::net::SocketAddr;
use std::path::PathBuf;

use super::state::BrowserKind;

/// One ICE server (STUN or TURN) for WebRTC.
#[derive(Clone, Debug, Default)]
pub struct IceServer {
    pub urls: String,
    pub username: Option<String>,
    pub credential: Option<String>,
}

/// Baliverne configuration (Docker, WebRTC, viewport).
#[derive(Clone, Debug)]
pub struct Config {
    pub listen: SocketAddr,
    pub public_host: Option<String>,
    /// Default browser for new sessions (chrome or firefox). Overridable via --agent baliverne:chrome etc.
    pub browser: BrowserKind,
    pub chrome_image: String,
    pub firefox_image: String,
    pub gpu_devices: Option<Vec<String>>,
    pub viewport_width: u32,
    pub viewport_height: u32,
    pub session_timeout_secs: u64,
    pub ice_servers: Vec<IceServer>,
    pub stun_bind: Option<SocketAddr>,
    pub turn_bind: Option<SocketAddr>,
    pub stun_public_host: Option<String>,
    pub turn_public_ip: Option<String>,
    pub turn_public_host: Option<String>,
    pub turn_realm: String,
    pub turn_username: Option<String>,
    pub turn_password: Option<String>,
    pub webrtc_rtp_port_start: u16,
    pub webrtc_rtp_port_end: u16,
    pub runtime_debug: bool,
    pub video_codec: String,
    pub rtp_fps: u32,
    pub neko_input_socket: Option<String>,
    pub ice_servers_file: Option<PathBuf>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            listen: ([0, 0, 0, 0], 8080).into(),
            public_host: None,
            browser: BrowserKind::Chrome,
            chrome_image: "baliverne-chrome:latest".to_string(),
            firefox_image: "baliverne-firefox:latest".to_string(),
            gpu_devices: None,
            viewport_width: 1920,
            viewport_height: 1080,
            session_timeout_secs: 3600,
            ice_servers: Vec::new(),
            stun_bind: Some("0.0.0.0:3478".parse().expect("default STUN bind")),
            turn_bind: None,
            stun_public_host: None,
            turn_public_ip: None,
            turn_public_host: None,
            turn_realm: "baliverne".to_string(),
            turn_username: None,
            turn_password: None,
            webrtc_rtp_port_start: 50000,
            webrtc_rtp_port_end: 50100,
            runtime_debug: false,
            video_codec: "vp8".to_string(),
            rtp_fps: 30,
            neko_input_socket: None,
            ice_servers_file: None,
        }
    }
}

/// Parse comma-separated ICE server list. Each entry may be "urls" or "urls|username|password".
pub fn parse_ice_servers(s: &str) -> Vec<IceServer> {
    let mut out = Vec::new();
    for part in s.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let mut urls = part.to_string();
        let mut username = None;
        let mut credential = None;
        if let Some((u, rest)) = part.split_once('|') {
            urls = u.trim().to_string();
            if let Some((user, pass)) = rest.split_once('|') {
                username = Some(user.trim().to_string());
                credential = Some(pass.trim().to_string());
            }
        }
        if !urls.is_empty() {
            out.push(IceServer {
                urls,
                username,
                credential,
            });
        }
    }
    out
}

impl Config {
    /// Load config from environment variables (BALIVERNE_*).
    pub fn from_env(listen: SocketAddr) -> Self {
        let mut c = Config::default();
        c.listen = listen;
        if let Ok(s) = std::env::var("BALIVERNE_PUBLIC_HOST") {
            if !s.is_empty() {
                c.public_host = Some(s);
            }
        }
        if let Ok(s) = std::env::var("BALIVERNE_BROWSER") {
            let b = s.trim().to_lowercase();
            if b == "firefox" {
                c.browser = BrowserKind::Firefox;
            }
            // "chrome" or anything else keeps default Chrome
        }
        if let Ok(s) = std::env::var("BALIVERNE_CHROME_IMAGE") {
            c.chrome_image = s;
        }
        if let Ok(s) = std::env::var("BALIVERNE_FIREFOX_IMAGE") {
            c.firefox_image = s;
        }
        if let Ok(s) = std::env::var("BALIVERNE_GPU_DEVICES") {
            c.gpu_devices = Some(
                s.split(',')
                    .map(str::trim)
                    .map(String::from)
                    .filter(|s| !s.is_empty())
                    .collect(),
            );
        }
        if let Ok(s) = std::env::var("BALIVERNE_VIEWPORT_WIDTH") {
            if let Ok(n) = s.parse() {
                c.viewport_width = n;
            }
        }
        if let Ok(s) = std::env::var("BALIVERNE_VIEWPORT_HEIGHT") {
            if let Ok(n) = s.parse() {
                c.viewport_height = n;
            }
        }
        if let Ok(s) = std::env::var("BALIVERNE_SESSION_TIMEOUT_SECS") {
            if let Ok(n) = s.parse() {
                c.session_timeout_secs = n;
            }
        }
        if let Ok(s) = std::env::var("BALIVERNE_ICE_SERVERS") {
            c.ice_servers = parse_ice_servers(&s);
        }
        if std::env::var("BALIVERNE_STUN_DISABLE")
            .map(|s| s == "1" || s.eq_ignore_ascii_case("true"))
            .unwrap_or(false)
        {
            c.stun_bind = None;
        } else if let Ok(s) = std::env::var("BALIVERNE_STUN_BIND") {
            c.stun_bind = if s.trim().is_empty() { None } else { s.parse().ok() };
        }
        if let Ok(s) = std::env::var("BALIVERNE_TURN_BIND") {
            if let Ok(addr) = s.parse() {
                c.turn_bind = Some(addr);
            }
        }
        if let Ok(s) = std::env::var("BALIVERNE_STUN_PUBLIC_HOST") {
            if !s.is_empty() {
                c.stun_public_host = Some(s);
            }
        }
        if let Ok(s) = std::env::var("BALIVERNE_TURN_PUBLIC_IP") {
            if !s.is_empty() {
                c.turn_public_ip = Some(s);
            }
        }
        if let Ok(s) = std::env::var("BALIVERNE_TURN_PUBLIC_HOST") {
            if !s.is_empty() {
                c.turn_public_host = Some(s);
            }
        }
        if let Ok(s) = std::env::var("BALIVERNE_TURN_REALM") {
            if !s.is_empty() {
                c.turn_realm = s;
            }
        }
        if let Ok(s) = std::env::var("BALIVERNE_TURN_USERNAME") {
            if !s.is_empty() {
                c.turn_username = Some(s);
            }
        }
        if let Ok(s) = std::env::var("BALIVERNE_TURN_PASSWORD") {
            if !s.is_empty() {
                c.turn_password = Some(s);
            }
        }
        if std::env::var("BALIVERNE_DEBUG")
            .map(|s| s == "1" || s.eq_ignore_ascii_case("true"))
            .unwrap_or(false)
        {
            c.runtime_debug = true;
        }
        if let Ok(s) = std::env::var("BALIVERNE_VIDEO_CODEC") {
            let codec = s.trim().to_lowercase();
            if ["vp8", "vp9", "av1", "h264"].contains(&codec.as_str()) {
                c.video_codec = codec;
            }
        }
        if let Ok(s) = std::env::var("BALIVERNE_RTP_FPS") {
            if let Ok(n) = s.parse() {
                if n > 0 && n <= 120 {
                    c.rtp_fps = n;
                }
            }
        }
        if let Ok(s) = std::env::var("BALIVERNE_NEKO_INPUT_SOCKET") {
            c.neko_input_socket = Some(s);
        }
        if let Ok(s) = std::env::var("BALIVERNE_ICE_SERVERS_FILE") {
            let p = s.trim();
            if !p.is_empty() {
                c.ice_servers_file = Some(PathBuf::from(p));
            }
        }
        c
    }
}
