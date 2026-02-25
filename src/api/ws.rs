use std::sync::atomic::Ordering;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    response::IntoResponse,
};
use futures::{SinkExt, StreamExt};
use tokio::sync::broadcast;

use crate::models::AnalysisStatus;
use crate::protocol::{AgentCommand, AgentEvent};
use crate::state::AppState;

pub async fn agent_ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_agent_connection(socket, state))
}

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
        if let Message::Text(text) = msg {
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
    }

    send_task.abort();
    state.agent_connected.store(false, Ordering::Relaxed);
    tracing::info!("Agent disconnected");
}

async fn handle_agent_event(state: &AppState, event: AgentEvent) {
    match &event {
        AgentEvent::Screenshot {
            analysis_id, data, ..
        } => {
            tracing::debug!(
                "Screenshot for {} ({} KB base64)",
                analysis_id,
                data.len() / 1024
            );
            if let Some(mut analysis) = state.analyses.get_mut(analysis_id) {
                analysis.screenshot = Some(data.clone());
                if analysis.status == AnalysisStatus::Pending {
                    analysis.status = AnalysisStatus::Running;
                }

                // Sample into timeline (~every 3s)
                let now = chrono::Utc::now().timestamp_millis() as f64;
                let should_sample = analysis.screenshot_timeline.is_empty()
                    || (now - analysis.screenshot_timeline.last().unwrap().timestamp) >= 3000.0;
                if should_sample {
                    analysis.screenshot_timeline.push(crate::models::ScreenshotEntry {
                        data: data.clone(),
                        timestamp: now,
                    });
                }
            } else {
                tracing::warn!("Screenshot for unknown analysis {}", analysis_id);
            }
            forward_to_viewer(state, analysis_id, &event);
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
            forward_to_viewer(state, analysis_id, &event);
        }

        AgentEvent::NavigationComplete {
            analysis_id,
            url,
            title,
        } => {
            tracing::info!(
                "Navigation complete for {}: url={} title={:?}",
                analysis_id,
                url,
                title
            );
            if let Some(mut analysis) = state.analyses.get_mut(analysis_id) {
                analysis.status = AnalysisStatus::Running;
                let report = analysis.report.get_or_insert_with(Default::default);
                report.final_url = Some(url.clone());
                report.page_title = title.clone();
            }
            forward_to_viewer(state, analysis_id, &event);
        }

        AgentEvent::AnalysisComplete {
            analysis_id,
            report,
        } => {
            tracing::info!(
                "Analysis complete for {}: risk_score={}, {} requests, {} scripts, {} risk factors",
                analysis_id,
                report.risk_score,
                report.network_requests.len(),
                report.scripts.len(),
                report.risk_factors.len()
            );
            if let Some(mut analysis) = state.analyses.get_mut(analysis_id) {
                analysis.status = AnalysisStatus::Complete;
                analysis.completed_at = Some(chrono::Utc::now());
                // Save the final screenshot as the last timeline entry
                if let Some(data) = analysis.screenshot.clone() {
                    let now = chrono::Utc::now().timestamp_millis() as f64;
                    analysis.screenshot_timeline.push(crate::models::ScreenshotEntry {
                        data,
                        timestamp: now,
                    });
                }
                // Preserve server-accumulated fields before overwriting
                let mut merged = report.clone();
                if let Some(existing) = &analysis.report {
                    merged.raw_files = existing.raw_files.clone();
                    merged.page_source = existing.page_source.clone();
                }
                analysis.report = Some(merged);
            }
            forward_to_viewer(state, analysis_id, &event);
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
            forward_to_viewer(state, analysis_id, &event);
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
            forward_to_viewer(state, analysis_id, &event);
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

        AgentEvent::Error {
            analysis_id,
            message,
        } => {
            tracing::error!("Agent error for {}: {}", analysis_id, message);
            if let Some(mut analysis) = state.analyses.get_mut(analysis_id) {
                analysis.status = AnalysisStatus::Error;
            }
            forward_to_viewer(state, analysis_id, &event);
        }

        AgentEvent::AgentReady => {
            tracing::info!("Agent reports ready");
        }
    }
}

fn forward_to_viewer(state: &AppState, analysis_id: &str, event: &AgentEvent) {
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

fn forward_raw_to_viewer(state: &AppState, analysis_id: &str, json: &str) {
    let viewer_tx = state.get_viewer_tx(analysis_id);
    let _ = viewer_tx.send(json.to_string());
}

pub async fn viewer_ws_handler(
    ws: WebSocketUpgrade,
    Path(analysis_id): Path<String>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_viewer_connection(socket, analysis_id, state))
}

async fn handle_viewer_connection(socket: WebSocket, analysis_id: String, state: AppState) {
    tracing::info!("Viewer connected for analysis {}", analysis_id);

    if !state.analyses.contains_key(&analysis_id) {
        tracing::warn!("Viewer connected to non-existent analysis {}", analysis_id);
        return;
    }

    let (mut ws_tx, mut ws_rx) = socket.split();

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
        // Send the latest screenshot so the viewer can display it
        // (especially for completed/error analyses where no new screenshots arrive)
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
        // Notify about available screenshot timeline count
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
    }

    let viewer_tx = state.get_viewer_tx(&analysis_id);
    let mut viewer_rx = viewer_tx.subscribe();

    let aid_fwd = analysis_id.clone();
    let fwd_task = tokio::spawn(async move {
        loop {
            match viewer_rx.recv().await {
                Ok(json) => {
                    let len = json.len();
                    if ws_tx.send(Message::Text(json)).await.is_err() {
                        tracing::debug!("Viewer WS send failed for {}, closing", aid_fwd);
                        break;
                    }
                    tracing::trace!("Sent {} bytes to viewer for {}", len, aid_fwd);
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(
                        "Viewer for {} lagged, skipped {} messages — continuing",
                        aid_fwd,
                        n
                    );
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => {
                    tracing::debug!("Viewer broadcast closed for {}", aid_fwd);
                    break;
                }
            }
        }
    });

    let aid = analysis_id.clone();
    while let Some(Ok(msg)) = ws_rx.next().await {
        if let Message::Text(text) = msg {
            if let Ok(viewer_cmd) = serde_json::from_str::<serde_json::Value>(&text) {
                let cmd_type = viewer_cmd
                    .get("type")
                    .and_then(|t| t.as_str())
                    .unwrap_or("");

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
                    _ => {
                        tracing::warn!("Unknown viewer command type: {}", cmd_type);
                        None
                    }
                };

                if let Some(cmd) = agent_cmd {
                    let _ = state.agent_cmd_tx.send(cmd);
                }
            }
        }
    }

    fwd_task.abort();
    tracing::info!("Viewer disconnected for analysis {}", analysis_id);
}
