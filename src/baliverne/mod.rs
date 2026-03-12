//! Baliverne agent: Docker-based browser sessions with X11 dummy driver, WebRTC video, STUN/TURN.
//! Integrated from Baliverne for use as an alternative agent backend in Carabistouille.

pub mod api;
pub mod config;
pub mod docker;
pub mod protocol;
pub mod state;
pub mod stun;
pub mod turn_relay;
pub mod webrtc;
pub mod webrtc_stream;
pub mod webrtc_viewer;
pub mod ws;
