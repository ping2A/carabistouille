//! WebSocket handlers: agent connection (commands out, events in) and viewer connection (events out).

use std::sync::atomic::Ordering;
use std::sync::Arc;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    response::IntoResponse,
};
use futures::{SinkExt, StreamExt};
use tokio::sync::broadcast;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;

use std::time::Duration;

use crate::baliverne::webrtc_viewer;
use crate::models::AnalysisStatus;
use crate::protocol::{AgentCommand, AgentEvent};
use crate::state::{AppState, MCP_NO_DATA_DELAY_SECS};

/// WebSocket upgrade for /ws/agent. One agent connects; receives commands, sends events.
pub async fn agent_ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_agent_connection(socket, state))
}

/// Run the agent connection: subscribe to commands, forward to WS; receive messages, parse as events and handle.
async fn handle_agent_connection(socket: WebSocket, state: AppState) {
    tracing::info!("Agent connected");
    state.agent_connected.store(true, Ordering::Relaxed);

    let (mut ws_tx, mut ws_rx) = socket.split();
    let mut cmd_rx = state.agent_cmd_tx.subscribe();

    let send_task = tokio::spawn(async move {
        loop {
            match cmd_rx.recv().await {
                Ok(cmd) => {
                    if let Ok(json) = serde_json::to_string(&cmd) {
                        tracing::debug!("-> Agent: {} ({} bytes)", cmd.type_name(), json.len());
                        if ws_tx.send(Message::Text(json)).await.is_err() {
                            tracing::warn!("Failed to send command to agent, WS closed");
                            break;
                        }
                    }
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!("Agent command channel lagged, skipped {} messages", n);
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => {
                    tracing::info!("Agent command channel closed");
                    break;
                }
            }
        }
    });

    while let Some(Ok(msg)) = ws_rx.next().await {
        match msg {
            Message::Text(text) => {
                let text_len = text.len();
                match serde_json::from_str::<AgentEvent>(&text) {
                    Ok(event) => {
                        tracing::debug!(
                            "<- Agent: {} ({} bytes)",
                            event.type_name(),
                            text_len
                        );
                        handle_agent_event(&state, event).await;
                    }
                    Err(_) => {
                        if let Ok(raw) = serde_json::from_str::<serde_json::Value>(&text) {
                            if let Some(analysis_id) = raw.get("analysis_id").and_then(|v| v.as_str()) {
                                let event_type = raw.get("type").and_then(|v| v.as_str()).unwrap_or("unknown");
                                tracing::debug!("<- Agent (raw): {} for {} ({} bytes)", event_type, analysis_id, text_len);
                                forward_raw_to_viewer(&state, analysis_id, &text);
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    send_task.abort();
    state.agent_connected.store(false, Ordering::Relaxed);
    tracing::info!("Agent disconnected");
}

/// Called from Baliverne runtime handler: rewrite session_id to analysis_id and process event.
pub(crate) async fn handle_agent_event_from_baliverne(
    state: &AppState,
    analysis_id: &str,
    event_json: &[u8],
) {
    tracing::debug!(%analysis_id, len = event_json.len(), "handle_agent_event_from_baliverne: entry");
    let mut value: serde_json::Value = match serde_json::from_slice(event_json) {
        Ok(v) => v,
        Err(e) => {
            tracing::debug!(%analysis_id, error = %e, "handle_agent_event_from_baliverne: parse slice failed");
            return;
        }
    };
    value["analysis_id"] = serde_json::json!(analysis_id);
    let new_json = value.to_string();
    let event_type = value.get("type").and_then(|t| t.as_str()).unwrap_or("?");
    match serde_json::from_str::<AgentEvent>(&new_json) {
        Ok(event) => {
            tracing::debug!(%analysis_id, event_type = event_type, "handle_agent_event_from_baliverne: parsed as AgentEvent");
            let is_agent_ready = matches!(&event, AgentEvent::AgentReady);
            handle_agent_event(state, event).await;
            // When runtime reports ready, send the user-requested URL so the remote browser opens it.
            if is_agent_ready {
                tracing::debug!(%analysis_id, "handle_agent_event_from_baliverne: agent_ready, sending navigate");
                send_navigate_to_baliverne_runtime(state, analysis_id).await;
            }
        }
        Err(_) => {
            tracing::debug!(%analysis_id, event_type = event_type, "handle_agent_event_from_baliverne: forwarding raw to viewer");
            forward_raw_to_viewer(state, analysis_id, &new_json);
        }
    }
}

/// Send Navigate (analysis URL) to the Baliverne runtime for this analysis. No-op if not Baliverne or no room.
async fn send_navigate_to_baliverne_runtime(state: &AppState, analysis_id: &str) {
    tracing::debug!(%analysis_id, "send_navigate_to_baliverne_runtime: entry");
    let analysis = match state.analyses.get(analysis_id) {
        Some(a) => a,
        None => {
            tracing::debug!(%analysis_id, "send_navigate_to_baliverne_runtime: no analysis found");
            return;
        }
    };
    let baliverne = match state.baliverne.as_ref() {
        Some(b) => b.clone(),
        None => {
            tracing::debug!(%analysis_id, "send_navigate_to_baliverne_runtime: Baliverne not enabled");
            return;
        }
    };
    let (room_id, _) = match state.analysis_to_baliverne.as_ref().and_then(|m| m.get(analysis_id)) {
        Some(guard) => *guard,
        None => {
            tracing::debug!(%analysis_id, "send_navigate_to_baliverne_runtime: no room for analysis");
            return;
        }
    };
    let room = match baliverne.get_room(room_id).await {
        Some(r) => r,
        None => {
            tracing::debug!(%analysis_id, %room_id, "send_navigate_to_baliverne_runtime: room not found");
            return;
        }
    };
    let tx = match room.runtime_tx.as_ref() {
        Some(t) => t.clone(),
        None => {
            tracing::debug!(%analysis_id, %room_id, "send_navigate_to_baliverne_runtime: no runtime_tx");
            return;
        }
    };
    let run_options = analysis.run_options.as_ref();
    let cmd = AgentCommand::Navigate {
        analysis_id: analysis_id.to_string(),
        url: analysis.url.clone(),
        proxy: run_options.and_then(|o| o.proxy.clone()),
        user_agent: run_options.and_then(|o| o.user_agent.clone()),
        timezone_id: run_options.and_then(|o| o.timezone_id.clone()),
        locale: run_options.and_then(|o| o.locale.clone()),
        latitude: run_options.and_then(|o| o.latitude),
        longitude: run_options.and_then(|o| o.longitude),
        accuracy: run_options.and_then(|o| o.accuracy),
        viewport_width: run_options.and_then(|o| o.viewport_width),
        viewport_height: run_options.and_then(|o| o.viewport_height),
        device_scale_factor: run_options.and_then(|o| o.device_scale_factor),
        is_mobile: run_options.and_then(|o| o.is_mobile),
        network_throttling: run_options.and_then(|o| o.network_throttling.clone()),
    };
    let bytes = adapt_cmd_to_baliverne(&cmd);
    if tx.send(bytes).await.is_err() {
        tracing::debug!(%analysis_id, "could not send navigate to runtime (channel closed)");
    } else {
        tracing::info!(%analysis_id, url = %analysis.url, "sent navigate to Baliverne runtime");
    }
}

/// Update server state from an agent event and forward the event to any viewers for that analysis.
pub(crate) async fn handle_agent_event(state: &AppState, event: AgentEvent) {
    tracing::debug!(event_type = %event.type_name(), "handle_agent_event: entry");
    match &event {
        AgentEvent::Screenshot {
            analysis_id, data, ..
        } => {
            let is_baliverne = state
                .analysis_to_baliverne
                .as_ref()
                .map(|m| m.contains_key(analysis_id))
                .unwrap_or(false);
            if is_baliverne {
                // Baliverne uses WebRTC/RTP for video; do not store or forward screenshot over WebSocket.
                if let Some(mut analysis) = state.analyses.get_mut(analysis_id) {
                    if analysis.status == AnalysisStatus::Pending {
                        analysis.status = AnalysisStatus::Running;
                        if let Some(a) = state.analyses.get(analysis_id) {
                            state.persist_analysis(a.clone());
                        }
                    }
                }
                return;
            }
            tracing::debug!(
                "Screenshot for {} ({} KB base64)",
                analysis_id,
                data.len() / 1024
            );
            let now_ms = chrono::Utc::now().timestamp_millis() as f64;
            let mut did_start = false;
            let should_forward = if let Some(mut analysis) = state.analyses.get_mut(analysis_id) {
                analysis.screenshot = Some(data.clone());
                if analysis.status == AnalysisStatus::Pending {
                    analysis.status = AnalysisStatus::Running;
                    did_start = true;
                }
                let should_sample = analysis.screenshot_timeline.is_empty()
                    || (now_ms - analysis.screenshot_timeline.last().unwrap().timestamp) >= 3000.0;
                if should_sample {
                    analysis.screenshot_timeline.push(crate::models::ScreenshotEntry {
                        data: data.clone(),
                        timestamp: now_ms,
                    });
                }
                let last = analysis.last_screenshot_forward_time_ms;
                let ok = last.is_none()
                    || (now_ms - last.unwrap_or(0.0)) >= SCREENSHOT_FORWARD_INTERVAL_MS;
                if ok {
                    analysis.last_screenshot_forward_time_ms = Some(now_ms);
                }
                ok
            } else {
                tracing::warn!("Screenshot for unknown analysis {}", analysis_id);
                false
            };
            if did_start {
                if let Some(a) = state.analyses.get(analysis_id) {
                    state.persist_analysis(a.clone());
                }
            }
            if should_forward {
                forward_to_viewer(state, analysis_id, &event);
            }
        }

        AgentEvent::NetworkRequestCaptured {
            analysis_id,
            request,
        } => {
            tracing::debug!(
                "Network request for {}: {} {} -> {:?}",
                analysis_id,
                request.method,
                request.url.chars().take(80).collect::<String>(),
                request.status
            );
            state.cancel_mcp_no_data_timer(analysis_id);
            if let Some(mut analysis) = state.analyses.get_mut(analysis_id) {
                let report = analysis.report.get_or_insert_with(Default::default);
                report.network_requests.push(request.clone());
            }
            forward_to_viewer(state, analysis_id, &event);
        }

        AgentEvent::ConsoleLogCaptured { analysis_id, log } => {
            tracing::debug!(
                "Console [{}] for {}: {}",
                log.level,
                analysis_id,
                log.text.chars().take(100).collect::<String>()
            );
            if let Some(mut analysis) = state.analyses.get_mut(analysis_id) {
                let report = analysis.report.get_or_insert_with(Default::default);
                report.console_logs.push(log.clone());
            }
            forward_to_viewer(state, analysis_id, &event);
        }

        AgentEvent::RedirectDetected {
            analysis_id,
            from,
            to,
            status,
        } => {
            tracing::info!(
                "Redirect for {}: {} -> {} ({})",
                analysis_id,
                from,
                to,
                status
            );
            if let Some(mut analysis) = state.analyses.get_mut(analysis_id) {
                let report = analysis.report.get_or_insert_with(Default::default);
                report.redirect_chain.push(crate::models::RedirectEntry {
                    from: from.clone(),
                    to: to.clone(),
                    status: *status,
                });
            }
            forward_to_viewer(state, analysis_id, &event);
        }

        AgentEvent::ScriptLoaded {
            analysis_id,
            script,
        } => {
            tracing::debug!(
                "Script loaded for {}: {} (inline={})",
                analysis_id,
                script.url.as_deref().unwrap_or("(inline)"),
                script.is_inline
            );
            if let Some(mut analysis) = state.analyses.get_mut(analysis_id) {
                let report = analysis.report.get_or_insert_with(Default::default);
                report.scripts.push(script.clone());
            }
            // Forward a lightweight version without the full script content
            let mut light = script.clone();
            light.content = None;
            let light_event = AgentEvent::ScriptLoaded {
                analysis_id: analysis_id.clone(),
                script: light,
            };
            forward_to_viewer(state, analysis_id, &light_event);
        }

        AgentEvent::NavigationComplete {
            analysis_id,
            url,
            title,
            engine,
            headless,
        } => {
            tracing::info!(
                "Navigation complete for {}: url={} title={:?} engine={:?} headless={:?}",
                analysis_id,
                url,
                title,
                engine,
                headless
            );
            if let Some(mut analysis) = state.analyses.get_mut(analysis_id) {
                analysis.status = AnalysisStatus::Running;
                let report = analysis.report.get_or_insert_with(Default::default);
                report.final_url = Some(url.clone());
                report.page_title = title.clone();
                if engine.is_some() {
                    report.engine = engine.clone();
                }
                if headless.is_some() {
                    report.headless = headless.clone();
                }
            }
            if let Some(a) = state.analyses.get(analysis_id) {
                state.persist_analysis(a.clone());
            }
            // For MCP-submitted analyses only: if no network data arrives within a delay, finish the analysis.
            if state.analyses.get(analysis_id).map(|a| a.submitted_via_mcp).unwrap_or(false) {
                let state_timer = state.clone();
                let analysis_id_timer = analysis_id.clone();
                let cmd_tx = state.agent_cmd_tx.clone();
                let handle = tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(MCP_NO_DATA_DELAY_SECS)).await;
                    state_timer.mcp_no_data_timers.remove(&analysis_id_timer);
                    let should_stop = state_timer
                        .analyses
                        .get(&analysis_id_timer)
                        .map(|a| {
                            a.status == AnalysisStatus::Running
                                && a.report.as_ref().map_or(true, |r| r.network_requests.is_empty())
                        })
                        .unwrap_or(false);
                    if should_stop {
                        tracing::info!(
                            analysis_id = %analysis_id_timer,
                            "MCP no-data delay elapsed with no network requests, finishing analysis"
                        );
                        let _ = cmd_tx.send(AgentCommand::StopAnalysis {
                            analysis_id: analysis_id_timer.clone(),
                        });
                        state_timer.cancel_analysis_timeout(&analysis_id_timer);
                    }
                });
                state.mcp_no_data_timers.insert(analysis_id.clone(), handle);
            }
            forward_to_viewer(state, analysis_id, &event);
        }

        AgentEvent::AnalysisComplete {
            analysis_id,
            report,
        } => {
            // Build merged report (server-accumulated raw_files, page_source, etc.) and update state.
            // Do not call state.analyses.get() while holding get_mut() — DashMap would deadlock.
            let (merged, submitted_via_mcp) = if let Some(mut analysis) = state.analyses.get_mut(analysis_id) {
                let submitted_via_mcp = analysis.submitted_via_mcp;
                analysis.status = AnalysisStatus::Complete;
                analysis.completed_at = Some(chrono::Utc::now());
                if let Some(data) = analysis.screenshot.clone() {
                    let now = chrono::Utc::now().timestamp_millis() as f64;
                    analysis.screenshot_timeline.push(crate::models::ScreenshotEntry {
                        data,
                        timestamp: now,
                    });
                }
                let mut merged = report.clone();
                if let Some(existing) = &analysis.report {
                    merged.raw_files = existing.raw_files.clone();
                    merged.page_source = existing.page_source.clone();
                    merged.dom_snapshot = existing.dom_snapshot.clone();
                    merged.storage_capture = existing.storage_capture.clone();
                    merged.security_headers = existing.security_headers.clone();
                    if merged.detection_attempts.is_empty() && !existing.detection_attempts.is_empty() {
                        merged.detection_attempts = existing.detection_attempts.clone();
                    }
                }
                analysis.report = Some(merged.clone());
                (Some(merged), submitted_via_mcp)
            } else {
                (None, false)
            };

            tracing::info!(
                analysis_id = %analysis_id,
                risk_score = report.risk_score,
                network_requests = report.network_requests.len(),
                scripts = report.scripts.len(),
                risk_factors = report.risk_factors.len(),
                submitted_via_mcp = submitted_via_mcp,
                "Analysis done"
            );

            state.cancel_analysis_timeout(analysis_id);
            state.cancel_mcp_no_data_timer(analysis_id);
            if let Some(a) = state.analyses.get(analysis_id) {
                state.persist_analysis(a.clone());
            }
            // Forward merged report to viewers so Raw/Screenshot tabs get server-accumulated data
            if let Some(merged) = merged {
                let complete_event = AgentEvent::AnalysisComplete {
                    analysis_id: analysis_id.clone(),
                    report: merged,
                };
                forward_to_viewer(state, analysis_id, &complete_event);
            } else {
                forward_to_viewer(state, analysis_id, &event);
            }
        }

        AgentEvent::ElementInfo { analysis_id, tag, .. } => {
            tracing::debug!("Element info for {}: <{}>", analysis_id, tag);
            forward_to_viewer(state, analysis_id, &event);
        }

        AgentEvent::RawFileCaptured { analysis_id, file } => {
            tracing::debug!(
                "Raw file for {}: {} ({} bytes, {})",
                analysis_id,
                file.url.chars().take(80).collect::<String>(),
                file.size,
                file.content_type
            );
            if let Some(mut analysis) = state.analyses.get_mut(analysis_id) {
                let report = analysis.report.get_or_insert_with(Default::default);
                report.raw_files.push(file.clone());
            }
            // Don't forward raw file content to viewers — too large (100KB+).
            // Viewer gets the full data via report_snapshot or analysis_complete.
        }

        AgentEvent::PageSourceCaptured { analysis_id, html } => {
            tracing::debug!(
                "Page source for {} ({} bytes)",
                analysis_id,
                html.len()
            );
            if let Some(mut analysis) = state.analyses.get_mut(analysis_id) {
                let report = analysis.report.get_or_insert_with(Default::default);
                report.page_source = Some(html.clone());
            }
            // Don't forward page source to viewers in real-time — too large.
        }

        AgentEvent::StorageCaptured { analysis_id, capture } => {
            tracing::debug!(
                "Storage for {}: {} cookies, {} localStorage, {} sessionStorage",
                analysis_id,
                capture.cookies.len(),
                capture.local_storage.len(),
                capture.session_storage.len()
            );
            if let Some(mut analysis) = state.analyses.get_mut(analysis_id) {
                let report = analysis.report.get_or_insert_with(Default::default);
                report.storage_capture = Some(capture.clone());
            }
            forward_to_viewer(state, analysis_id, &event);
        }

        AgentEvent::SecurityHeadersCaptured { analysis_id, headers } => {
            tracing::debug!("Security headers for {}: {} headers", analysis_id, headers.len());
            if let Some(mut analysis) = state.analyses.get_mut(analysis_id) {
                let report = analysis.report.get_or_insert_with(Default::default);
                report.security_headers = headers.clone();
            }
            forward_to_viewer(state, analysis_id, &event);
        }

        AgentEvent::DomSnapshotCaptured { analysis_id, html } => {
            tracing::debug!("DOM snapshot for {} ({} bytes)", analysis_id, html.len());
            if let Some(mut analysis) = state.analyses.get_mut(analysis_id) {
                let report = analysis.report.get_or_insert_with(Default::default);
                report.dom_snapshot = Some(html.clone());
            }
            // Don't forward DOM snapshot to viewers in real-time — too large.
        }

        AgentEvent::ClipboardCaptured { analysis_id, read } => {
            tracing::debug!(
                "Clipboard read for {} (trigger: {}, {} bytes)",
                analysis_id,
                read.trigger,
                read.content.len()
            );
            if let Some(mut analysis) = state.analyses.get_mut(analysis_id) {
                let report = analysis.report.get_or_insert_with(Default::default);
                report.clipboard_reads.push(read.clone());
            }
            forward_to_viewer(state, analysis_id, &event);
        }

        AgentEvent::DetectionEvent {
            analysis_id,
            attempt,
        } => {
            tracing::debug!(
                "Detection probe for {}: {} ({})",
                analysis_id,
                attempt.property,
                attempt.severity
            );
            if let Some(mut analysis) = state.analyses.get_mut(analysis_id) {
                let report = analysis.report.get_or_insert_with(Default::default);
                report.detection_attempts.push(attempt.clone());
            }
            forward_to_viewer(state, analysis_id, &event);
        }

        AgentEvent::Error {
            analysis_id,
            message,
        } => {
            tracing::error!("Agent error for {}: {}", analysis_id, message);
            if let Some(mut analysis) = state.analyses.get_mut(analysis_id) {
                // Do not overwrite a successful completion: late errors (e.g. from a viewer
                // command after the analysis finished) must not flip status to Error.
                if analysis.status != AnalysisStatus::Complete {
                    analysis.status = AnalysisStatus::Error;
                }
            }
            state.cancel_analysis_timeout(analysis_id);
            state.cancel_mcp_no_data_timer(analysis_id);
            if let Some(a) = state.analyses.get(analysis_id) {
                state.persist_analysis(a.clone());
            }
            forward_to_viewer(state, analysis_id, &event);
        }

        AgentEvent::AgentReady => {
            tracing::info!("Agent reports ready");
        }
    }
}

/// Minimum interval (ms) between forwarding screenshots to viewers. Lower = more fluid UI; 300–500 is a good balance.
const SCREENSHOT_FORWARD_INTERVAL_MS: f64 = 400.0;

/// Serialize the event and send it to all viewers subscribed to this analysis.
pub(crate) fn forward_to_viewer(state: &AppState, analysis_id: &str, event: &AgentEvent) {
    tracing::trace!(%analysis_id, event_type = %event.type_name(), "forward_to_viewer: entry");
    let viewer_tx = state.get_viewer_tx(analysis_id);
    if let Ok(json) = serde_json::to_string(event) {
        match viewer_tx.send(json) {
            Ok(n) => {
                tracing::trace!(
                    "Forwarded {} to {} viewer(s) for {}",
                    event.type_name(),
                    n,
                    analysis_id
                );
            }
            Err(_) => {
                tracing::trace!(
                    "No viewers listening for {} (event: {})",
                    analysis_id,
                    event.type_name()
                );
            }
        }
    }
}

/// Forward raw JSON to viewers (e.g. when event did not parse as AgentEvent).
pub(crate) fn forward_raw_to_viewer(state: &AppState, analysis_id: &str, json: &str) {
    tracing::trace!(%analysis_id, len = json.len(), "forward_raw_to_viewer: entry");
    let viewer_tx = state.get_viewer_tx(analysis_id);
    let _ = viewer_tx.send(json.to_string());
}

/// Mark analysis as Complete and forward analysis_complete to viewers. Used when stop is triggered (e.g. Baliverne) and the runtime did not send analysis_complete.
pub(crate) fn mark_analysis_complete_and_forward(state: &AppState, analysis_id: &str) {
    let report = if let Some(mut analysis) = state.analyses.get_mut(analysis_id) {
        analysis.status = AnalysisStatus::Complete;
        analysis.completed_at = Some(chrono::Utc::now());
        analysis.report.clone().unwrap_or_default()
    } else {
        return;
    };
    if let Some(a) = state.analyses.get(analysis_id) {
        state.persist_analysis(a.clone());
    }
    let event = AgentEvent::AnalysisComplete {
        analysis_id: analysis_id.to_string(),
        report,
    };
    tracing::info!(%analysis_id, "mark_analysis_complete_and_forward: forwarding analysis_complete to viewers");
    forward_to_viewer(state, analysis_id, &event);
}

/// If this analysis is backed by Baliverne, send the command to the runtime (adapted format). Returns true if sent to Baliverne.
pub(crate) async fn send_viewer_command_to_agent(
    state: &AppState,
    analysis_id: &str,
    cmd: &AgentCommand,
) -> bool {
    tracing::debug!(%analysis_id, cmd_type = %cmd.type_name(), "send_viewer_command_to_agent: entry");
    // Do not forward commands for analyses that are already finished (e.g. user clicked Finish; container stopped).
    if let Some(analysis) = state.analyses.get(analysis_id) {
        if analysis.status != AnalysisStatus::Running && analysis.status != AnalysisStatus::Pending {
            tracing::trace!(%analysis_id, status = ?analysis.status, "send_viewer_command_to_agent: analysis not running, skip");
            return false;
        }
    }
    let baliverne = match state.baliverne.as_ref() {
        Some(b) => b.clone(),
        None => {
            tracing::trace!(%analysis_id, "send_viewer_command_to_agent: Baliverne not enabled");
            return false;
        }
    };
    let (room_id, _) = match state.analysis_to_baliverne.as_ref().and_then(|m| m.get(analysis_id)) {
        Some(guard) => *guard,
        None => {
            tracing::trace!(%analysis_id, "send_viewer_command_to_agent: no room for analysis");
            return false;
        }
    };
    let room = match baliverne.get_room(room_id).await {
        Some(r) => r,
        None => {
            tracing::debug!(%analysis_id, %room_id, "send_viewer_command_to_agent: room not found");
            return false;
        }
    };
    let tx = match room.runtime_tx.as_ref() {
        Some(t) => t.clone(),
        None => {
            tracing::debug!(%analysis_id, %room_id, "send_viewer_command_to_agent: no runtime_tx");
            return false;
        }
    };
    let bytes = adapt_cmd_to_baliverne(cmd);
    tracing::debug!(%analysis_id, bytes_len = bytes.len(), "send_viewer_command_to_agent: sending via try_send");
    // Non-blocking: avoid blocking HTTP handler if runtime is slow or channel full
    if tx.try_send(bytes).is_err() {
        tracing::debug!(%analysis_id, "runtime command channel full or closed, stop may not reach container");
    } else {
        tracing::trace!(%analysis_id, "send_viewer_command_to_agent: sent");
    }
    true
}

/// Convert Carabistouille AgentCommand to Baliverne runtime JSON (no analysis_id, dx/dy for scroll, mousemove).
fn adapt_cmd_to_baliverne(cmd: &AgentCommand) -> Vec<u8> {
    tracing::trace!(cmd_type = %cmd.type_name(), "adapt_cmd_to_baliverne: entry");
    let value = match cmd {
        AgentCommand::Navigate { url, proxy, user_agent, .. } => {
            serde_json::json!({ "type": "navigate", "url": url, "proxy": proxy, "user_agent": user_agent })
        }
        AgentCommand::Click { x, y, .. } => serde_json::json!({ "type": "click", "x": x, "y": y }),
        AgentCommand::Scroll { delta_x, delta_y, .. } => {
            serde_json::json!({ "type": "scroll", "dx": delta_x, "dy": delta_y })
        }
        AgentCommand::MoveMouse { x, y, .. } => {
            serde_json::json!({ "type": "mousemove", "x": x, "y": y })
        }
        AgentCommand::TypeText { text, .. } => serde_json::json!({ "type": "type_text", "text": text }),
        AgentCommand::KeyPress { key, .. } => serde_json::json!({ "type": "key_press", "key": key }),
        AgentCommand::InspectElement { x, y, .. } => {
            serde_json::json!({ "type": "inspect_element", "x": x, "y": y })
        }
        AgentCommand::StopAnalysis { .. } => serde_json::json!({ "type": "stop_analysis" }),
    };
    serde_json::to_vec(&value).unwrap_or_default()
}

/// WebSocket upgrade for /ws/viewer/:id. Viewer receives events for that analysis; can send click/scroll/stop etc.
pub async fn viewer_ws_handler(
    ws: WebSocketUpgrade,
    Path(analysis_id): Path<String>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    tracing::debug!(%analysis_id, "viewer_ws_handler: upgrade requested");
    ws.on_upgrade(move |socket| handle_viewer_connection(socket, analysis_id, state))
}

/// Run the viewer connection: send report_snapshot + last screenshot + timeline notice, then forward all events; handle incoming commands.
async fn handle_viewer_connection(socket: WebSocket, analysis_id: String, state: AppState) {
    tracing::debug!(%analysis_id, "handle_viewer_connection: started");
    tracing::info!("Viewer connected for analysis {}", analysis_id);

    if !state.analyses.contains_key(&analysis_id) {
        tracing::warn!("Viewer connected to non-existent analysis {}", analysis_id);
        return;
    }

    let (mut ws_tx, mut ws_rx) = socket.split();

    let is_baliverne = state
        .analysis_to_baliverne
        .as_ref()
        .map(|m| m.contains_key(&analysis_id))
        .unwrap_or(false);

    // Send a snapshot of the current report so the viewer doesn't miss
    // events that arrived before the WS connection was established.
    if let Some(analysis) = state.analyses.get(&analysis_id) {
        if let Some(ref report) = analysis.report {
            let snapshot = serde_json::json!({
                "type": "report_snapshot",
                "report": report,
                "status": analysis.status,
            });
            if let Ok(json) = serde_json::to_string(&snapshot) {
                tracing::debug!(
                    "Sending report snapshot for {} ({} bytes, {} requests, {} scripts)",
                    analysis_id, json.len(),
                    report.network_requests.len(), report.scripts.len()
                );
                let _ = ws_tx.send(Message::Text(json)).await;
            }
        }
        // For Baliverne, video is via WebRTC/RTP — do not send screenshot. Send stream_mode so UI uses WebRTC viewport.
        if !is_baliverne {
            if let Some(ref screenshot) = analysis.screenshot {
                let ss_msg = serde_json::json!({
                    "type": "screenshot",
                    "analysis_id": analysis_id,
                    "data": screenshot,
                });
                if let Ok(json) = serde_json::to_string(&ss_msg) {
                    let _ = ws_tx.send(Message::Text(json)).await;
                }
            }
            if !analysis.screenshot_timeline.is_empty() {
                let ts_msg = serde_json::json!({
                    "type": "screenshot_timeline_available",
                    "analysis_id": analysis_id,
                    "count": analysis.screenshot_timeline.len(),
                });
                if let Ok(json) = serde_json::to_string(&ts_msg) {
                    let _ = ws_tx.send(Message::Text(json)).await;
                }
            }
        } else {
            let stream_mode_msg = serde_json::json!({
                "type": "stream_mode",
                "analysis_id": analysis_id,
                "video": "webrtc",
            });
            if let Ok(json) = serde_json::to_string(&stream_mode_msg) {
                let _ = ws_tx.send(Message::Text(json)).await;
            }
        }
    }

    let viewer_tx = state.get_viewer_tx(&analysis_id);
    let mut viewer_rx = viewer_tx.subscribe();
    let (sig_tx, mut sig_rx) = tokio::sync::mpsc::channel::<String>(32);

    let aid_fwd = analysis_id.clone();
    let fwd_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                recv_result = viewer_rx.recv() => match recv_result {
                    Ok(json) => {
                        let len = json.len();
                        if ws_tx.send(Message::Text(json)).await.is_err() {
                            tracing::debug!("Viewer WS send failed for {}, closing", aid_fwd);
                            break;
                        }
                        tracing::trace!("Sent {} bytes to viewer for {}", len, aid_fwd);
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!("Viewer for {} lagged, skipped {} messages", aid_fwd, n);
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        tracing::debug!("Viewer broadcast closed for {}", aid_fwd);
                        break;
                    }
                },
                Some(sig_msg) = sig_rx.recv() => {
                    if ws_tx.send(Message::Text(sig_msg)).await.is_err() {
                        tracing::debug!("Viewer WS send (sig) failed for {}, closing", aid_fwd);
                        break;
                    }
                }
                else => break,
            }
        }
    });

    let mut webrtc_pc: Option<Arc<webrtc::peer_connection::RTCPeerConnection>> = None;
    let mut webrtc_forward_handle: Option<tokio::task::JoinHandle<()>> = None;
    let baliverne_room_id = state
        .analysis_to_baliverne
        .as_ref()
        .and_then(|m| m.get(&analysis_id).map(|r| r.0));

    let aid = analysis_id.clone();
    while let Some(Ok(msg)) = ws_rx.next().await {
        if let Message::Text(text) = msg {
            if let Ok(viewer_cmd) = serde_json::from_str::<serde_json::Value>(&text) {
                let cmd_type = viewer_cmd
                    .get("type")
                    .and_then(|t| t.as_str())
                    .unwrap_or("");

                // WebRTC signaling (Baliverne viewer)
                if cmd_type == "webrtc_request_offer" {
                    if webrtc_pc.is_some() {
                        tracing::debug!("WebRTC offer already created for {}, ignoring", aid);
                    } else if let Some(room_id) = baliverne_room_id {
                        match webrtc_viewer::handle_webrtc_request_offer(&state, room_id, &sig_tx).await {
                            Ok((pc, handle)) => {
                                webrtc_pc = pc;
                                webrtc_forward_handle = handle;
                            }
                            Err(e) => tracing::warn!(%aid, error = %e, "WebRTC offer creation failed"),
                        }
                    }
                }
                if cmd_type == "webrtc_answer" {
                    if let Some(ref pc) = webrtc_pc {
                        if let Some(sdp_val) = viewer_cmd.get("sdp") {
                            let sdp_str = sdp_val.get("sdp").and_then(|s| s.as_str()).unwrap_or("");
                            if !sdp_str.is_empty() {
                                match RTCSessionDescription::answer(sdp_str.to_string()) {
                                    Ok(desc) => {
                                        if let Err(e) = pc.set_remote_description(desc).await {
                                            tracing::warn!(%aid, error = %e, "set_remote_description failed");
                                        }
                                    }
                                    Err(e) => tracing::warn!(%aid, error = %e, "invalid answer SDP"),
                                }
                            }
                        }
                    }
                }
                if cmd_type == "webrtc_ice_candidate" {
                    if let Some(ref pc) = webrtc_pc {
                        if let Some(cand) = viewer_cmd.get("candidate") {
                            if let Ok(init) = serde_json::from_value::<RTCIceCandidateInit>(cand.clone()) {
                                if let Err(e) = pc.add_ice_candidate(init).await {
                                    tracing::debug!(%aid, error = %e, "add_ice_candidate failed");
                                }
                            }
                        }
                    }
                }

                tracing::debug!("Viewer command for {}: {}", aid, cmd_type);

                let agent_cmd = match cmd_type {
                    "click" => {
                        let x = viewer_cmd.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
                        let y = viewer_cmd.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
                        Some(AgentCommand::Click {
                            analysis_id: aid.clone(),
                            x,
                            y,
                        })
                    }
                    "scroll" => {
                        let delta_x = viewer_cmd
                            .get("delta_x")
                            .and_then(|v| v.as_f64())
                            .unwrap_or(0.0);
                        let delta_y = viewer_cmd
                            .get("delta_y")
                            .and_then(|v| v.as_f64())
                            .unwrap_or(0.0);
                        Some(AgentCommand::Scroll {
                            analysis_id: aid.clone(),
                            delta_x,
                            delta_y,
                        })
                    }
                    "mousemove" => {
                        let x = viewer_cmd.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
                        let y = viewer_cmd.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
                        Some(AgentCommand::MoveMouse {
                            analysis_id: aid.clone(),
                            x,
                            y,
                        })
                    }
                    "type_text" => {
                        let text = viewer_cmd
                            .get("text")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        Some(AgentCommand::TypeText {
                            analysis_id: aid.clone(),
                            text,
                        })
                    }
                    "keypress" => {
                        let key = viewer_cmd
                            .get("key")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        Some(AgentCommand::KeyPress {
                            analysis_id: aid.clone(),
                            key,
                        })
                    }
                    "inspect" => {
                        let x = viewer_cmd.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
                        let y = viewer_cmd.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
                        Some(AgentCommand::InspectElement {
                            analysis_id: aid.clone(),
                            x,
                            y,
                        })
                    }
                    "stop_analysis" => Some(AgentCommand::StopAnalysis {
                        analysis_id: aid.clone(),
                    }),
                    "webrtc_request_offer" | "webrtc_answer" | "webrtc_ice_candidate" => None,
                    _ => {
                        tracing::warn!("Unknown viewer command type: {}", cmd_type);
                        None
                    }
                };

                if let Some(cmd) = agent_cmd {
                    let sent = send_viewer_command_to_agent(&state, &aid, &cmd).await;
                    if !sent {
                        let _ = state.agent_cmd_tx.send(cmd);
                    }
                }
            }
        }
    }

    // Run cleanup in a spawned task so we don't block this handler (WebRTC drop or Baliverne lock
    // can take time). Returning immediately allows new connections to be accepted.
    let state_cleanup = state.clone();
    let room_id_cleanup = baliverne_room_id;
    tokio::spawn(async move {
        if let Some(handle) = webrtc_forward_handle.take() {
            handle.abort();
        }
        drop(webrtc_pc.take());
        if let Some(room_id) = room_id_cleanup {
            if let Some(ref b) = state_cleanup.baliverne {
                b.set_room_rtp_tx(room_id, None).await;
            }
        }
        fwd_task.abort();
    });
    tracing::info!("Viewer disconnected for analysis {}", analysis_id);
}
