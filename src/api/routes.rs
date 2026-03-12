//! REST API handlers: status, create/list/get/stop/delete analyses, get screenshots, VirusTotal.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use base64::Engine;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::models::{Analysis, AnalysisListItem, AnalysisRunOptions, AnalysisStatus};
use crate::protocol::AgentCommand;
use crate::state::{AppState, DEFAULT_ANALYSIS_TIMEOUT_SECS};

/// Request body for POST /api/analyses (url required; proxy, user_agent, geo/locale optional).
#[derive(Deserialize)]
pub struct CreateAnalysisRequest {
    pub url: String,
    pub proxy: Option<String>,
    pub user_agent: Option<String>,
    /// IANA timezone ID (e.g. "Europe/Paris").
    pub timezone_id: Option<String>,
    /// BCP 47 locale (e.g. "fr-FR").
    pub locale: Option<String>,
    /// Geolocation latitude.
    pub latitude: Option<f64>,
    /// Geolocation longitude.
    pub longitude: Option<f64>,
    /// Geolocation accuracy in meters.
    pub accuracy: Option<f64>,
    /// Viewport width (e.g. 1920).
    pub viewport_width: Option<u32>,
    /// Viewport height (e.g. 1080).
    pub viewport_height: Option<u32>,
    /// Device scale factor (1 or 2).
    pub device_scale_factor: Option<f64>,
    /// Mobile viewport (touch).
    pub is_mobile: Option<bool>,
    /// Network throttling: "none", "slow3g", "fast3g".
    pub network_throttling: Option<String>,
}

/// Request body for PATCH /api/analyses/:id (notes and/or tags).
/// Use Option<Option<String>> for notes so that Some(None) means "clear notes".
#[derive(Deserialize)]
pub struct UpdateAnalysisRequest {
    #[serde(default)]
    pub notes: Option<Option<String>>,
    pub tags: Option<Vec<String>>,
}

/// Response for POST /api/analyses (id, url, status).
#[derive(Serialize)]
pub struct CreateAnalysisResponse {
    pub id: String,
    pub url: String,
    pub status: AnalysisStatus,
}

/// GET /api/status — agent connected flag, run mode, chrome mode, stream/codec/input info, ICE servers (when Baliverne), analyses count.
pub async fn get_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Json<serde_json::Value> {
    let agent_backend = if state.baliverne.is_some() {
        "baliverne"
    } else {
        "builtin"
    };
    let run_mode = if state.docker_agent { "docker" } else { "local" };
    let chrome_mode: Option<&str> = if state.docker_agent {
        Some(if state.lightpanda {
            "lightpanda"
        } else if state.real_chrome {
            "real"
        } else {
            "headless"
        })
    } else {
        None
    };
    let request_host = headers
        .get("host")
        .and_then(|v: &axum::http::HeaderValue| v.to_str().ok())
        .map(|s: &str| s.split(':').next().unwrap_or(s));
    let mut payload = serde_json::json!({
        "agent_connected": state.agent_connected.load(Ordering::Relaxed) || state.baliverne.is_some(),
        "agent_backend": agent_backend,
        "run_mode": run_mode,
        "chrome_mode": chrome_mode,
        "analyses_count": state.analyses.len(),
    });
    // Stream/video/input info and ICE servers (STUN/TURN) for UI when Baliverne
    if let Some(ref b) = state.baliverne {
        let c = &b.config;
        let browser_name = match c.browser {
            crate::baliverne::state::BrowserKind::Chrome => "chrome",
            crate::baliverne::state::BrowserKind::Firefox => "firefox",
        };
        payload["baliverne_browser"] = serde_json::json!(browser_name);
        let input_method = if c.neko_input_socket.is_some() {
            "neko"
        } else {
            "xtest"
        };
        payload["stream"] = serde_json::json!({
            "video": "webrtc",
            "codec": c.video_codec,
            "fps": c.rtp_fps,
            "input": input_method,
        });
        let ice_servers = crate::baliverne::api::ice::build_ice_servers(&state, request_host);
        payload["ice_servers"] = serde_json::json!(ice_servers);
    } else {
        payload["stream"] = serde_json::json!({
            "video": "screencast",
            "codec": null,
            "fps": null,
            "input": "puppeteer",
        });
    }
    Json(payload)
}

/// POST /api/analyses — create analysis, send Navigate to agent (or start Baliverne session), return 201 or 503 if no agent.
pub async fn create_analysis(
    State(state): State<AppState>,
    Json(req): Json<CreateAnalysisRequest>,
) -> Result<(StatusCode, Json<CreateAnalysisResponse>), (StatusCode, String)> {
    let use_baliverne = state.baliverne.is_some();
    if !use_baliverne && !state.agent_connected.load(Ordering::Relaxed) {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "No agent connected".to_string(),
        ));
    }

    let id = Uuid::new_v4().to_string();
    let run_options = AnalysisRunOptions {
        proxy: req.proxy.clone(),
        user_agent: req.user_agent.clone(),
        timezone_id: req.timezone_id.clone(),
        locale: req.locale.clone(),
        latitude: req.latitude,
        longitude: req.longitude,
        accuracy: req.accuracy,
        viewport_width: req.viewport_width,
        viewport_height: req.viewport_height,
        device_scale_factor: req.device_scale_factor,
        is_mobile: req.is_mobile,
        network_throttling: req.network_throttling.clone(),
    };
    let has_any_option = run_options.proxy.is_some()
        || run_options.user_agent.is_some()
        || run_options.timezone_id.is_some()
        || run_options.locale.is_some()
        || run_options.latitude.is_some()
        || run_options.longitude.is_some()
        || run_options.viewport_width.is_some()
        || run_options.viewport_height.is_some()
        || run_options.device_scale_factor.is_some()
        || run_options.is_mobile.is_some()
        || run_options.network_throttling.is_some();
    let analysis = Analysis {
        id: id.clone(),
        url: req.url.clone(),
        status: AnalysisStatus::Pending,
        created_at: Utc::now(),
        completed_at: None,
        report: None,
        screenshot: None,
        screenshot_timeline: Vec::new(),
        last_screenshot_forward_time_ms: None,
        notes: None,
        tags: Vec::new(),
        run_options: if has_any_option { Some(run_options) } else { None },
        submitted_via_mcp: false,
    };

    state.analyses.insert(id.clone(), analysis.clone());
    state.persist_analysis(analysis);

    if use_baliverne {
        // Baliverne agent: create room, start container, store mapping. Navigate is sent when runtime connects.
        let baliverne = state.baliverne.as_ref().unwrap().clone();
        let analysis_to_baliverne = state.analysis_to_baliverne.as_ref().unwrap().clone();
        let baliverne_room_to_analysis = state.baliverne_room_to_analysis.as_ref().unwrap().clone();
        let room_id = uuid::Uuid::new_v4();
        let session_id = uuid::Uuid::new_v4();
        let (tx, _) = tokio::sync::broadcast::channel(32);
        let browser = baliverne.config.browser;
        let room = crate::baliverne::state::Room {
            id: room_id,
            session_id,
            browser,
            container_id: None,
            tx,
            runtime_tx: None,
            rtp_tx: None,
            viewer_count: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        };
        baliverne.add_room(room).await;
        let webrtc_rtp = {
            let (start, end) = (
                baliverne.config.webrtc_rtp_port_start,
                baliverne.config.webrtc_rtp_port_end,
            );
            match crate::baliverne::webrtc_stream::allocate_rtp_socket(start, end).await {
                Ok((socket, port)) => {
                    let rtp_host = baliverne
                        .config
                        .public_host
                        .as_deref()
                        .and_then(|s| s.split(':').next())
                        .unwrap_or("host.docker.internal")
                        .to_string();
                    crate::baliverne::webrtc_stream::spawn_rtp_receiver(baliverne.clone(), room_id, socket);
                    Some((rtp_host, port))
                }
                Err(e) => {
                    tracing::warn!(%room_id, error = %e, "Baliverne: WebRTC RTP allocation failed");
                    None
                }
            }
        };
        if let Ok(cid) = baliverne
            .docker
            .start_session(session_id, browser, webrtc_rtp)
            .await
        {
            baliverne.set_room_container(room_id, cid).await;
        }
        analysis_to_baliverne.insert(id.clone(), (room_id, session_id));
        baliverne_room_to_analysis.insert(room_id, id.clone());
    } else {
        let _ = state.agent_cmd_tx.send(AgentCommand::Navigate {
            analysis_id: id.clone(),
            url: req.url.clone(),
            proxy: req.proxy.clone(),
            user_agent: req.user_agent.clone(),
            timezone_id: req.timezone_id.clone(),
            locale: req.locale.clone(),
            latitude: req.latitude,
            longitude: req.longitude,
            accuracy: req.accuracy,
            viewport_width: req.viewport_width,
            viewport_height: req.viewport_height,
            device_scale_factor: req.device_scale_factor,
            is_mobile: req.is_mobile,
            network_throttling: req.network_throttling.clone(),
        });
    }

    // Force-stop analysis after 5 minutes if still running
    let state_timeout = state.clone();
    let analysis_id_timeout = id.clone();
    let cmd_tx = state.agent_cmd_tx.clone();
    let analysis_to_baliverne_timeout = state.analysis_to_baliverne.clone();
    let baliverne_timeout = state.baliverne.clone();
    let handle = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(DEFAULT_ANALYSIS_TIMEOUT_SECS)).await;
        if let (Some(ref m), Some(ref baliverne)) = (analysis_to_baliverne_timeout.as_ref(), baliverne_timeout.as_ref()) {
            if let Some(guard) = m.get(&analysis_id_timeout) {
                let (room_id, _) = *guard;
                if let Some(room) = baliverne.get_room(room_id).await {
                    if let Some(ref tx) = room.runtime_tx {
                        let stop = serde_json::json!({ "type": "stop_analysis" });
                        let _ = tx.send(serde_json::to_vec(&stop).unwrap_or_default()).await;
                    }
                }
            }
        } else {
            let _ = cmd_tx.send(AgentCommand::StopAnalysis {
                analysis_id: analysis_id_timeout.clone(),
            });
        }
        state_timeout.cancel_analysis_timeout(&analysis_id_timeout);
    });
    state.analysis_timeouts.insert(id.clone(), handle);

    Ok((
        StatusCode::CREATED,
        Json(CreateAnalysisResponse {
            id,
            url: req.url,
            status: AnalysisStatus::Pending,
        }),
    ))
}

/// GET /api/analyses — list all analyses (newest first). Returns lightweight items (no report/screenshot) for fast overview; full data is loaded on GET /api/analyses/:id when user opens one.
pub async fn list_analyses(State(state): State<AppState>) -> Json<Vec<AnalysisListItem>> {
    let mut items: Vec<AnalysisListItem> = state
        .analyses
        .iter()
        .map(|entry| {
            let a = entry.value();
            let (risk_score, network_request_count, scripts_count, redirect_count, has_clipboard, has_mixed_content) =
                a.report.as_ref().map_or(
                    (None, 0u32, 0u32, 0u32, false, false),
                    |r| {
                        (
                            Some(r.risk_score),
                            r.network_requests.len() as u32,
                            r.scripts.len() as u32,
                            r.redirect_chain.len() as u32,
                            !r.clipboard_reads.is_empty(),
                            r.security.has_mixed_content,
                        )
                    },
                );
            AnalysisListItem {
                id: a.id.clone(),
                url: a.url.clone(),
                status: a.status.clone(),
                created_at: a.created_at,
                completed_at: a.completed_at,
                notes: a.notes.clone(),
                tags: a.tags.clone(),
                risk_score,
                network_request_count,
                scripts_count,
                redirect_count,
                has_clipboard,
                has_mixed_content,
            }
        })
        .collect();
    items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Json(items)
}

/// GET /api/analyses/:id — full analysis + report; includes last screenshot for complete/error.
pub async fn get_analysis(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Analysis>, StatusCode> {
    state
        .analyses
        .get(&id)
        .map(|entry| {
            let mut a = entry.value().clone();
            // Include last screenshot for completed/error analyses so the UI can display it
            if a.status != AnalysisStatus::Complete && a.status != AnalysisStatus::Error {
                a.screenshot = None;
            }
            // Timeline is served via dedicated endpoint
            a.screenshot_timeline = Vec::new();
            Json(a)
        })
        .ok_or(StatusCode::NOT_FOUND)
}

/// GET /api/analyses/:id/screenshots — screenshot timeline (sampled entries) for that analysis.
pub async fn get_screenshots(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Vec<crate::models::ScreenshotEntry>>, StatusCode> {
    state
        .analyses
        .get(&id)
        .map(|entry| Json(entry.value().screenshot_timeline.clone()))
        .ok_or(StatusCode::NOT_FOUND)
}

/// VirusTotal API v3 URL report response (subset we care about).
#[derive(Debug, Deserialize)]
struct VirusTotalResponse {
    data: Option<VirusTotalData>,
    error: Option<VirusTotalError>,
}

#[derive(Debug, Deserialize)]
struct VirusTotalData {
    id: Option<String>,
    attributes: Option<VirusTotalAttributes>,
}

#[derive(Debug, Deserialize)]
struct VirusTotalAttributes {
    last_analysis_stats: Option<VirusTotalStats>,
    last_analysis_date: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct VirusTotalStats {
    malicious: Option<u32>,
    suspicious: Option<u32>,
    harmless: Option<u32>,
    undetected: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct VirusTotalError {
    message: Option<String>,
}

/// Response for GET /api/analyses/:id/virustotal.
#[derive(Debug, Serialize)]
pub struct VirusTotalResult {
    pub checked_url: String,
    pub malicious: u32,
    pub suspicious: u32,
    pub harmless: u32,
    pub undetected: u32,
    pub total: u32,
    pub last_analysis_date: Option<i64>,
    pub report_url: Option<String>,
}

/// GET /api/analyses/:id/virustotal — look up analysis URL on VirusTotal; returns detection stats and report link.
/// API key: from header X-VirusTotal-API-Key (sent by UI when user has set it in Settings) or from VIRUSTOTAL_API_KEY env.
pub async fn get_virustotal(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Result<Json<VirusTotalResult>, (StatusCode, String)> {
    let analysis = state
        .analyses
        .get(&id)
        .ok_or((StatusCode::NOT_FOUND, "Analysis not found".to_string()))?;

    let url = analysis
        .report
        .as_ref()
        .and_then(|r| r.final_url.as_deref())
        .unwrap_or(analysis.url.as_str());

    let api_key = headers
        .get("X-VirusTotal-API-Key")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("VIRUSTOTAL_API_KEY").ok())
        .ok_or((
            StatusCode::SERVICE_UNAVAILABLE,
            "VirusTotal API key required. Add it in Settings (gear icon) or set VIRUSTOTAL_API_KEY on the server.".to_string(),
        ))?;

    let url_id = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(url.as_bytes());
    let vt_url = format!("https://www.virustotal.com/api/v3/urls/{}", url_id);

    let client = reqwest::Client::new();
    let res = client
        .get(&vt_url)
        .header("x-apikey", api_key.trim())
        .send()
        .await
        .map_err(|e| {
            tracing::warn!("VirusTotal request failed: {}", e);
            (
                StatusCode::BAD_GATEWAY,
                format!("VirusTotal request failed: {}", e),
            )
        })?;

    let status = res.status();
    let body = res.text().await.map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("VirusTotal response read failed: {}", e),
        )
    })?;

    let vt: VirusTotalResponse = serde_json::from_str(&body).unwrap_or(VirusTotalResponse {
        data: None,
        error: Some(VirusTotalError {
            message: Some("Invalid response".to_string()),
        }),
    });

    if let Some(err) = vt.error {
        let msg = err.message.unwrap_or_else(|| "Unknown VirusTotal error".to_string());
        if status.is_client_error() && status.as_u16() == 401 {
            return Err((StatusCode::INTERNAL_SERVER_ERROR, "Invalid VirusTotal API key".to_string()));
        }
        return Err((
            StatusCode::BAD_GATEWAY,
            format!("VirusTotal: {}", msg),
        ));
    }

    let data = vt.data.ok_or((
        StatusCode::BAD_GATEWAY,
        "VirusTotal: no data in response".to_string(),
    ))?;

    let attrs = data.attributes.as_ref();
    let stats = attrs.and_then(|a| a.last_analysis_stats.as_ref());
    let malicious = stats.and_then(|s| s.malicious).unwrap_or(0);
    let suspicious = stats.and_then(|s| s.suspicious).unwrap_or(0);
    let harmless = stats.and_then(|s| s.harmless).unwrap_or(0);
    let undetected = stats.and_then(|s| s.undetected).unwrap_or(0);
    let total = malicious + suspicious + harmless + undetected;
    let last_analysis_date = attrs.and_then(|a| a.last_analysis_date);

    let report_url = data
        .id
        .as_deref()
        .map(|sid| format!("https://www.virustotal.com/gui/url/{}", sid));

    Ok(Json(VirusTotalResult {
        checked_url: url.to_string(),
        malicious,
        suspicious,
        harmless,
        undetected,
        total,
        last_analysis_date,
        report_url,
    }))
}

/// Time we wait for the Baliverne container to stop before returning from stop_analysis.
const BALIVERNE_STOP_TIMEOUT: Duration = Duration::from_secs(8);

/// POST /api/analyses/:id/stop — send StopAnalysis to agent; 202 accepted or 404/409.
pub async fn stop_analysis(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    tracing::debug!(%id, "stop_analysis: entry");
    let analysis = state
        .analyses
        .get(&id)
        .ok_or((StatusCode::NOT_FOUND, "Analysis not found".to_string()))?;

    match analysis.status {
        AnalysisStatus::Pending | AnalysisStatus::Running => {}
        _ => {
            tracing::debug!(%id, status = ?analysis.status, "stop_analysis: already finished");
            return Err((
                StatusCode::CONFLICT,
                format!("Analysis is already {}", serde_json::to_string(&analysis.status).unwrap_or_default()),
            ));
        }
    }
    drop(analysis);

    // Resolve Baliverne mapping first so we can stop the container even if the room is removed before we await stop.
    let baliverne_mapping = state
        .analysis_to_baliverne
        .as_ref()
        .and_then(|m| m.get(&id))
        .map(|guard| *guard);

    // Baliverne runtimes are not subscribed to agent_cmd_tx; send stop directly to the container's runtime channel.
    let stop_cmd = AgentCommand::StopAnalysis {
        analysis_id: id.clone(),
    };
    let sent_to_baliverne = crate::api::ws::send_viewer_command_to_agent(&state, &id, &stop_cmd).await;
    tracing::debug!(%id, sent_to_baliverne, "stop_analysis: stop command sent");
    if !sent_to_baliverne {
        let _ = state.agent_cmd_tx.send(stop_cmd);
        tracing::trace!(%id, "stop_analysis: sent via agent_cmd_tx");
    }

    // For Baliverne: always stop the container in this request (await with timeout). Use room.container_id or fallback to container name from session_id.
    if let Some((room_id, session_id)) = baliverne_mapping {
        if let Some(ref baliverne) = state.baliverne {
            let baliverne = baliverne.clone();
            let container_id_or_name = baliverne
                .get_room(room_id)
                .await
                .and_then(|r| r.container_id)
                .unwrap_or_else(|| format!("baliverne-{}", session_id.as_simple()));
            tracing::info!(%id, container = %container_id_or_name, "stop_analysis: stopping Baliverne container now");
            match tokio::time::timeout(
                BALIVERNE_STOP_TIMEOUT,
                baliverne.docker.stop_container(&container_id_or_name),
            )
            .await
            {
                Ok(Ok(())) => {
                    tracing::info!(%container_id_or_name, "stop_analysis: Baliverne container stopped");
                }
                Ok(Err(e)) => {
                    tracing::warn!(%container_id_or_name, error = %e, "stop_analysis: Baliverne container stop failed");
                }
                Err(_) => {
                    tracing::warn!(
                        %container_id_or_name,
                        "stop_analysis: Baliverne container stop timed out after {:?}",
                        BALIVERNE_STOP_TIMEOUT
                    );
                }
            }
        }
        // Baliverne runtime is stopped and may not have sent analysis_complete; mark complete and push to viewers so the UI stops handling input.
        crate::api::ws::mark_analysis_complete_and_forward(&state, &id);
    }
    state.cancel_analysis_timeout(&id);

    Ok(StatusCode::ACCEPTED)
}

/// PATCH /api/analyses/:id — update notes and/or tags; returns 200 with updated analysis or 404.
pub async fn update_analysis(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<UpdateAnalysisRequest>,
) -> Result<Json<Analysis>, StatusCode> {
    let mut analysis = state
        .analyses
        .get_mut(&id)
        .ok_or(StatusCode::NOT_FOUND)?;
    if let Some(notes_opt) = req.notes {
        analysis.notes = notes_opt;
    }
    if let Some(tags) = req.tags {
        analysis.tags = tags;
    }
    let updated = analysis.clone();
    drop(analysis);
    state.persist_analysis(updated.clone());
    Ok(Json(updated))
}

/// DELETE /api/analyses/:id — remove analysis and its viewer channel; 204 or 404.
pub async fn delete_analysis(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> StatusCode {
    if state.analyses.remove(&id).is_some() {
        state.viewer_channels.remove(&id);
        state.cancel_analysis_timeout(&id);
        state.persist_delete(&id);
        StatusCode::NO_CONTENT
    } else {
        StatusCode::NOT_FOUND
    }
}
