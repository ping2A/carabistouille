//! REST API handlers: status, create/list/get/stop/delete analyses, get screenshots.

use std::sync::atomic::Ordering;
use std::time::Duration;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::models::{Analysis, AnalysisStatus};
use crate::protocol::AgentCommand;
use crate::state::{AppState, DEFAULT_ANALYSIS_TIMEOUT_SECS};

/// Request body for POST /api/analyses (url required; proxy and user_agent optional).
#[derive(Deserialize)]
pub struct CreateAnalysisRequest {
    pub url: String,
    pub proxy: Option<String>,
    pub user_agent: Option<String>,
}

/// Response for POST /api/analyses (id, url, status).
#[derive(Serialize)]
pub struct CreateAnalysisResponse {
    pub id: String,
    pub url: String,
    pub status: AnalysisStatus,
}

/// GET /api/status — agent connected flag and total analyses count.
pub async fn get_status(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "agent_connected": state.agent_connected.load(Ordering::Relaxed),
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
    let analysis = Analysis {
        id: id.clone(),
        url: req.url.clone(),
        status: AnalysisStatus::Pending,
        created_at: Utc::now(),
        completed_at: None,
        report: None,
        screenshot: None,
        screenshot_timeline: Vec::new(),
    };

    state.analyses.insert(id.clone(), analysis.clone());
    state.persist_analysis(analysis);

    let _ = state.agent_cmd_tx.send(AgentCommand::Navigate {
        analysis_id: id.clone(),
        url: req.url.clone(),
        proxy: req.proxy.clone(),
        user_agent: req.user_agent.clone(),
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
