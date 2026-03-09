//! REST API handlers: status, create/list/get/stop/delete analyses, get screenshots, VirusTotal.

use std::sync::atomic::Ordering;
use std::time::Duration;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use base64::Engine;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::models::{Analysis, AnalysisRunOptions, AnalysisStatus};
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

/// GET /api/status — agent connected flag, run mode, chrome mode, and total analyses count.
pub async fn get_status(State(state): State<AppState>) -> Json<serde_json::Value> {
    let run_mode = if state.docker_agent { "docker" } else { "local" };
    let chrome_mode: Option<&str> = if state.docker_agent {
        Some(if state.real_chrome { "real" } else { "headless" })
    } else {
        None
    };
    Json(serde_json::json!({
        "agent_connected": state.agent_connected.load(Ordering::Relaxed),
        "run_mode": run_mode,
        "chrome_mode": chrome_mode,
        "analyses_count": state.analyses.len(),
    }))
}

/// POST /api/analyses — create analysis, send Navigate to agent, return 201 or 503 if no agent.
pub async fn create_analysis(
    State(state): State<AppState>,
    Json(req): Json<CreateAnalysisRequest>,
) -> Result<(StatusCode, Json<CreateAnalysisResponse>), (StatusCode, String)> {
    if !state.agent_connected.load(Ordering::Relaxed) {
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
    };

    state.analyses.insert(id.clone(), analysis.clone());
    state.persist_analysis(analysis);

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

    // Force-stop analysis after 5 minutes if still running
    let state_timeout = state.clone();
    let analysis_id_timeout = id.clone();
    let cmd_tx = state.agent_cmd_tx.clone();
    let handle = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(DEFAULT_ANALYSIS_TIMEOUT_SECS)).await;
        let _ = cmd_tx.send(AgentCommand::StopAnalysis {
            analysis_id: analysis_id_timeout.clone(),
        });
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

/// GET /api/analyses — list all analyses (newest first), without screenshot/timeline payloads.
pub async fn list_analyses(State(state): State<AppState>) -> Json<Vec<Analysis>> {
    let mut analyses: Vec<Analysis> = state
        .analyses
        .iter()
        .map(|entry| {
            let mut a = entry.value().clone();
            a.screenshot = None;
            a.screenshot_timeline = Vec::new();
            a
        })
        .collect();
    analyses.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Json(analyses)
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

/// POST /api/analyses/:id/stop — send StopAnalysis to agent; 202 accepted or 404/409.
pub async fn stop_analysis(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    let analysis = state
        .analyses
        .get(&id)
        .ok_or((StatusCode::NOT_FOUND, "Analysis not found".to_string()))?;

    match analysis.status {
        AnalysisStatus::Pending | AnalysisStatus::Running => {}
        _ => {
            return Err((
                StatusCode::CONFLICT,
                format!("Analysis is already {}", serde_json::to_string(&analysis.status).unwrap_or_default()),
            ));
        }
    }
    drop(analysis);

    let _ = state.agent_cmd_tx.send(AgentCommand::StopAnalysis {
        analysis_id: id.clone(),
    });
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
