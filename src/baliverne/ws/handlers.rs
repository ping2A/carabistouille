//! WebSocket handlers for Baliverne runtime (/ws/session/:id). Bridge events to Carabistouille analyses.

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    response::Response,
};
use futures_util::{SinkExt, StreamExt};
use tracing::{debug, error, info, warn};
use uuid::Uuid;

use crate::baliverne::protocol::SessionId;

/// Router for Baliverne WebSocket routes. Requires Carabistouille AppState (with baliverne and maps set).
pub fn router(state: crate::state::AppState) -> axum::Router<crate::state::AppState> {
    axum::Router::new()
        .route(
            "/ws/session/:session_id",
            axum::routing::get(ws_runtime),
        )
        .with_state(state)
}

/// Browser runtime (container) connects here. Receives commands, sends events; we forward events to Carabistouille.
async fn ws_runtime(
    ws: WebSocketUpgrade,
    State(state): State<crate::state::AppState>,
    Path(session_id): Path<Uuid>,
) -> Response {
    let session_id: SessionId = session_id;
    debug!(%session_id, "ws_runtime: upgrade requested for /ws/session/:id");
    ws.on_upgrade(move |socket| handle_runtime_socket(state, session_id, socket))
}

async fn handle_runtime_socket(
    state: crate::state::AppState,
    session_id: SessionId,
    socket: WebSocket,
) {
    debug!(%session_id, "handle_runtime_socket: started");
    let baliverne = match state.baliverne.as_ref() {
        Some(b) => b.clone(),
        None => {
            error!(%session_id, "runtime connected but Baliverne not enabled");
            return;
        }
    };
    let room = match baliverne.get_room_by_session(session_id).await {
        Some(r) => r,
        None => {
            // Stale container (leftover from previous run, or Docker restarted it) — connection closed, no log spam
            debug!(%session_id, "runtime connected but session_id not found (stale container), closing");
            return;
        }
    };
    debug!(%session_id, room_id = %room.id, "handle_runtime_socket: room found");
    let analysis_id = state
        .baliverne_room_to_analysis
        .as_ref()
        .and_then(|m| m.get(&room.id).map(|s| s.clone()));
    let Some(analysis_id) = analysis_id else {
        error!(%session_id, room_id = %room.id, "no analysis_id for this room");
        return;
    };

    let (mut ws_tx, mut ws_rx) = socket.split();
    let (cmd_tx, mut cmd_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(64);
    let cmd_tx_for_nav = cmd_tx.clone();
    let room_id = room.id;
    let broadcast_tx = room.tx.clone();
    if baliverne.set_runtime_tx(session_id, cmd_tx).await.is_none() {
        error!(%session_id, "failed to set runtime tx");
        return;
    }
    debug!(%session_id, %room_id, %analysis_id, "handle_runtime_socket: runtime_tx set");
    info!(%session_id, %room_id, %analysis_id, "Baliverne runtime connected");

    // Send initial Navigate from the analysis (url + run_options for Baliverne runtime).
    if let Some(analysis) = state.analyses.get(&analysis_id) {
        let opts = analysis.run_options.as_ref();
        let nav = serde_json::json!({
            "type": "navigate",
            "url": analysis.url,
            "proxy": opts.and_then(|o| o.proxy.clone()),
            "user_agent": opts.and_then(|o| o.user_agent.clone()),
            "viewport_width": opts.and_then(|o| o.viewport_width),
            "viewport_height": opts.and_then(|o| o.viewport_height),
            "device_scale_factor": opts.and_then(|o| o.device_scale_factor),
            "is_mobile": opts.and_then(|o| o.is_mobile),
            "timezone_id": opts.and_then(|o| o.timezone_id.clone()),
            "locale": opts.and_then(|o| o.locale.clone()),
            "latitude": opts.and_then(|o| o.latitude),
            "longitude": opts.and_then(|o| o.longitude),
            "accuracy": opts.and_then(|o| o.accuracy),
            "network_throttling": opts.and_then(|o| o.network_throttling.clone()),
        });
        if let Ok(bytes) = serde_json::to_vec(&nav) {
            let _ = cmd_tx_for_nav.send(bytes).await;
            if let Some(o) = opts {
                info!(
                    %session_id,
                    %analysis_id,
                    url = %analysis.url,
                    viewport = ?o.viewport_width.zip(o.viewport_height).map(|(w, h)| format!("{}x{}", w, h)),
                    proxy = o.proxy.is_some(),
                    user_agent = o.user_agent.is_some(),
                    timezone = ?o.timezone_id.as_deref(),
                    locale = ?o.locale.as_deref(),
                    geo = o.latitude.is_some() && o.longitude.is_some(),
                    network_throttling = ?o.network_throttling.as_deref(),
                    "sent initial navigate with run_options"
                );
            } else {
                debug!(%session_id, %analysis_id, url = %analysis.url, "handle_runtime_socket: sent initial navigate (no run_options)");
            }
        }
    } else {
        debug!(%session_id, %analysis_id, "handle_runtime_socket: no analysis for initial navigate");
    }

    let send_task = tokio::spawn(async move {
        while let Some(data) = cmd_rx.recv().await {
            if ws_tx.send(Message::Binary(data)).await.is_err() {
                debug!(%session_id, "runtime command channel closed");
                break;
            }
        }
    });

    let state_ev = state.clone();
    while let Some(Ok(msg)) = ws_rx.next().await {
        match msg {
            Message::Text(t) => {
                let data = t.into_bytes();
                debug!(%session_id, %analysis_id, len = data.len(), "handle_runtime_socket: received Text");
                crate::api::ws::handle_agent_event_from_baliverne(
                    &state_ev,
                    &analysis_id,
                    &data,
                )
                .await;
                let _ = broadcast_tx.send(data.clone());
            }
            Message::Binary(b) => {
                debug!(%session_id, %analysis_id, len = b.len(), "handle_runtime_socket: received Binary");
                crate::api::ws::handle_agent_event_from_baliverne(
                    &state_ev,
                    &analysis_id,
                    &b,
                )
                .await;
                let _ = broadcast_tx.send(b.clone());
            }
            Message::Close(_) => {
                debug!(%session_id, %room_id, "runtime closed connection");
                break;
            }
            _ => {}
        }
    }
    send_task.abort();
    info!(%session_id, %room_id, "runtime disconnected");
    debug!(%session_id, %room_id, %analysis_id, "handle_runtime_socket: cleanup starting");

    if let Some(room) = baliverne.get_room_by_session(session_id).await {
        if let Some(ref cid) = room.container_id {
            debug!(%session_id, container_id = %cid, "handle_runtime_socket: stopping container");
            if let Err(e) = baliverne.docker.stop_container(cid).await {
                warn!(%session_id, container_id = %cid, error = %e, "failed to stop container");
            }
        }
        baliverne.remove_room(room.id).await;
        debug!(%session_id, room_id = %room.id, "handle_runtime_socket: room removed");
    }
    if let Some(ref m) = state.baliverne_room_to_analysis {
        m.remove(&room_id);
        debug!(%room_id, "handle_runtime_socket: baliverne_room_to_analysis entry removed");
    }
    if let Some(ref m) = state.analysis_to_baliverne {
        m.remove(&analysis_id);
        debug!(%analysis_id, "handle_runtime_socket: analysis_to_baliverne entry removed");
    }
    debug!(%session_id, %analysis_id, "handle_runtime_socket: cleanup done");
}
