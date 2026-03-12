//! WebRTC offer creation for Baliverne viewer: create PeerConnection, TrackLocalStaticRTP, feed RTP from container into track, send SDP offer to viewer.
//! Mirrors Baliverne's handle_webrtc_request_offer so the Carabistouille UI can receive WebRTC video.

use std::sync::Arc;
use tracing::{debug, info, warn};
use webrtc::api::media_engine::{MIME_TYPE_AV1, MIME_TYPE_H264, MIME_TYPE_VP8, MIME_TYPE_VP9};
use webrtc::api::APIBuilder;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::{TrackLocal, TrackLocalWriter};

use crate::baliverne::api::ice::build_ice_servers;
use crate::baliverne::protocol::RoomId;
use crate::baliverne::webrtc::{ice_servers_from_api, peer_connection_config};
use crate::state::AppState;

/// Create WebRTC offer for a viewer: set room's rtp_tx, create PC with video track, send offer via sig_tx, spawn RTP→track forward task.
/// Returns (None, None) on error; on success returns (Some(pc), Some(join_handle)) so the caller can handle answer/ICE and abort the handle on disconnect.
pub async fn handle_webrtc_request_offer(
    state: &AppState,
    room_id: RoomId,
    sig_tx: &tokio::sync::mpsc::Sender<String>,
) -> Result<
    (
        Option<Arc<webrtc::peer_connection::RTCPeerConnection>>,
        Option<tokio::task::JoinHandle<()>>,
    ),
    String,
> {
    let baliverne = state
        .baliverne
        .as_ref()
        .ok_or_else(|| "Baliverne not enabled".to_string())?;

    let (rtp_tx, mut rtp_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(256);
    baliverne.set_room_rtp_tx(room_id, Some(rtp_tx)).await;
    info!(%room_id, "WebRTC RTP forwarding active (container → viewer)");

    let mut m = webrtc::api::media_engine::MediaEngine::default();
    m.register_default_codecs().map_err(|e| e.to_string())?;
    let api = APIBuilder::new().with_media_engine(m).build();

    let ice_entries = build_ice_servers(state, None);
    let ice_servers = ice_servers_from_api(&ice_entries);
    let config = peer_connection_config(ice_servers);

    let pc = api
        .new_peer_connection(config)
        .await
        .map_err(|e| e.to_string())?;
    let pc = Arc::new(pc);

    let codec = baliverne.config.video_codec.to_lowercase();
    let mime_type = match codec.as_str() {
        "h264" => MIME_TYPE_H264.to_owned(),
        "vp9" => MIME_TYPE_VP9.to_owned(),
        "av1" => MIME_TYPE_AV1.to_owned(),
        _ => MIME_TYPE_VP8.to_owned(),
    };
    let track = Arc::new(TrackLocalStaticRTP::new(
        RTCRtpCodecCapability {
            mime_type,
            clock_rate: 90000,
            ..Default::default()
        },
        "video".to_owned(),
        "baliverne".to_owned(),
    ));
    pc.add_track(Arc::clone(&track) as Arc<dyn TrackLocal + Send + Sync>)
        .await
        .map_err(|e| e.to_string())?;

    let sig_tx_c = sig_tx.clone();
    pc.on_ice_candidate(Box::new(move |c: Option<webrtc::ice_transport::ice_candidate::RTCIceCandidate>| {
        let sig_tx = sig_tx_c.clone();
        Box::pin(async move {
            if let Some(cand) = c {
                if let Ok(init) = cand.to_json() {
                    let msg = serde_json::json!({
                        "type": "webrtc_ice_candidate",
                        "candidate": init
                    });
                    let _ = sig_tx.send(msg.to_string()).await;
                }
            }
        })
    }));

    let offer = pc.create_offer(None).await.map_err(|e| e.to_string())?;
    pc.set_local_description(offer.clone())
        .await
        .map_err(|e| e.to_string())?;

    let offer_msg = serde_json::json!({
        "type": "webrtc_offer",
        "sdp": { "type": "offer", "sdp": offer.sdp }
    });
    sig_tx
        .send(offer_msg.to_string())
        .await
        .map_err(|_| "signaling channel closed".to_string())?;
    info!(%room_id, codec = %baliverne.config.video_codec, "WebRTC offer sent to viewer");

    let track_forward = Arc::clone(&track);
    let room_id_fwd = room_id;
    let handle = tokio::spawn(async move {
        let mut count: u64 = 0;
        while let Some(packet) = rtp_rx.recv().await {
            count += 1;
            if count == 1 {
                info!(%room_id_fwd, bytes = packet.len(), "RTP first packet forwarded to WebRTC track");
            } else if count % 500 == 0 {
                debug!(%room_id_fwd, count, "RTP packets forwarded to track");
            }
            if let Err(e) = track_forward.write(&packet).await {
                warn!(%room_id_fwd, count, error = %e, "RTP track write failed, stopping forward");
                break;
            }
        }
    });

    Ok((Some(pc), Some(handle)))
}
