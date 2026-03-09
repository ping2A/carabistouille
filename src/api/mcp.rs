//! MCP (Model Context Protocol) server: optional HTTP/HTTPS endpoint for LLM tools.
//!
//! When enabled (--mcp), exposes POST /mcp for JSON-RPC 2.0: initialize, tools/list, tools/call.
//! Tools: carabistouille_submit_url, carabistouille_list_analyses, carabistouille_get_analysis, carabistouille_database_summary.

use std::sync::atomic::Ordering;
use std::time::Duration;

use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use chrono::Utc;
use serde_json::Value;
use uuid::Uuid;

use crate::models::{Analysis, AnalysisRunOptions, AnalysisStatus};
use crate::protocol::AgentCommand;
use crate::state::{AppState, MCP_ANALYSIS_TIMEOUT_SECS};

/// POST /mcp — JSON-RPC 2.0 handler. Returns 404 if MCP is disabled.
pub async fn mcp_handler(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    if !state.mcp_enabled {
        return (StatusCode::NOT_FOUND, Json(Value::Null)).into_response();
    }

    let id = body.get("id").cloned();
    let method = body
        .get("method")
        .and_then(|m| m.as_str())
        .unwrap_or("");
    let params = body.get("params").cloned().unwrap_or(Value::Null);

    let tool_name: String = if method == "tools/call" {
        params.get("name").and_then(|n| n.as_str()).unwrap_or("?").to_string()
    } else {
        String::new()
    };
    if tool_name.is_empty() {
        tracing::info!(rpc_method = %method, rpc_id = ?id, "MCP request");
    } else {
        tracing::info!(rpc_method = %method, tool = %tool_name, rpc_id = ?id, "MCP request");
    }

    let result = match method {
        "initialize" => handle_initialize(params),
        "tools/list" => handle_tools_list(),
        "tools/call" => handle_tools_call(State(state.clone()), params).await,
        _ => Err((
            -32601,
            format!("Method not found: {}", method),
        )),
    };

    match result {
        Ok(result) => {
            if !tool_name.is_empty() {
                tracing::info!(tool = %tool_name, rpc_id = ?id, "MCP response OK");
            }
            let response = serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": result,
            });
            (StatusCode::OK, Json(response)).into_response()
        }
        Err((code, message)) => {
            tracing::warn!(rpc_method = %method, error_code = code, error = %message, rpc_id = ?id, "MCP response error");
            let response = serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": code, "message": message },
            });
            (StatusCode::OK, Json(response)).into_response()
        }
    }
}

fn handle_initialize(_params: Value) -> Result<Value, (i32, String)> {
    Ok(serde_json::json!({
        "protocolVersion": "2024-11-05",
        "capabilities": {
            "tools": {}
        },
        "serverInfo": {
            "name": "carabistouille",
            "version": env!("CARGO_PKG_VERSION")
        }
    }))
}

fn handle_tools_list() -> Result<Value, (i32, String)> {
    Ok(serde_json::json!({
        "tools": [
            {
                "name": "carabistouille_submit_url",
                "description": "Submit a URL for analysis. The analysis runs in a headless browser; returns analysis id and status. Use carabistouille_get_analysis to poll for completion and report.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "url": { "type": "string", "description": "URL to analyze (e.g. https://example.com)" },
                        "proxy": { "type": "string", "description": "Optional proxy (e.g. socks5://host:port)" },
                        "user_agent": { "type": "string", "description": "Optional User-Agent string" }
                    },
                    "required": ["url"]
                }
            },
            {
                "name": "carabistouille_list_analyses",
                "description": "List analyses in the database (newest first). Optionally filter by status or limit count.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "limit": { "type": "integer", "description": "Max number of analyses to return (default 20)" },
                        "status": { "type": "string", "enum": ["pending", "running", "complete", "error"], "description": "Filter by status" }
                    }
                }
            },
            {
                "name": "carabistouille_get_analysis",
                "description": "Get a single analysis by id: status, URL, report summary (risk score, risk factors, redirect chain, etc.). Use after submit_url to check completion.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "string", "description": "Analysis UUID" }
                    },
                    "required": ["id"]
                }
            },
            {
                "name": "carabistouille_database_summary",
                "description": "Get a summary of the analysis database: total count, counts by status, and recent analyses (url, status, risk score).",
                "inputSchema": { "type": "object" }
            }
        ]
    }))
}

async fn handle_tools_call(
    State(state): State<AppState>,
    params: Value,
) -> Result<Value, (i32, String)> {
    let args = params.get("arguments").unwrap_or(&params);
    let name = params
        .get("name")
        .and_then(|n| n.as_str())
        .unwrap_or("");

    match name {
        "carabistouille_get_analysis" => {
            let resp = get_analysis(State(state), args)?;
            let mut content = vec![serde_json::json!({ "type": "text", "text": resp.text })];
            if let Some((ref data, ref media_type)) = resp.screenshot {
                content.push(serde_json::json!({
                    "type": "image",
                    "data": data,
                    "mediaType": media_type
                }));
            }
            return Ok(serde_json::json!({ "content": content }));
        }
        _ => {
            let text = match name {
                "carabistouille_submit_url" => submit_url(State(state), args).await?,
                "carabistouille_list_analyses" => list_analyses(State(state), args)?,
                "carabistouille_database_summary" => database_summary(State(state))?,
                _ => return Err((-32602, format!("Unknown tool: {}", name))),
            };
            Ok(serde_json::json!({
                "content": [{ "type": "text", "text": text }]
            }))
        }
    }
}

async fn submit_url(
    State(state): State<AppState>,
    args: &Value,
) -> Result<String, (i32, String)> {
    if !state.agent_connected.load(Ordering::Relaxed) {
        return Err((
            -32000,
            "No agent connected. Start the agent (local or Docker) first.".to_string(),
        ));
    }
    let url = args
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or((-32602, "Missing required argument: url".to_string()))?
        .to_string();
    let proxy = args.get("proxy").and_then(|v| v.as_str()).map(String::from);
    let user_agent = args.get("user_agent").and_then(|v| v.as_str()).map(String::from);

    let id = Uuid::new_v4().to_string();
    let run_options = AnalysisRunOptions {
        proxy: proxy.clone(),
        user_agent: user_agent.clone(),
        ..Default::default()
    };
    let has_any = run_options.proxy.is_some() || run_options.user_agent.is_some();
    let analysis = Analysis {
        id: id.clone(),
        url: url.clone(),
        status: AnalysisStatus::Pending,
        created_at: Utc::now(),
        completed_at: None,
        report: None,
        screenshot: None,
        screenshot_timeline: Vec::new(),
        last_screenshot_forward_time_ms: None,
        notes: None,
        tags: Vec::new(),
        run_options: if has_any { Some(run_options) } else { None },
        submitted_via_mcp: true,
    };

    state.analyses.insert(id.clone(), analysis.clone());
    state.persist_analysis(analysis);

    tracing::info!(
        analysis_id = %id,
        url = %url,
        "MCP analysis submitted"
    );

    let _ = state.agent_cmd_tx.send(AgentCommand::Navigate {
        analysis_id: id.clone(),
        url: url.clone(),
        proxy: proxy.clone(),
        user_agent: user_agent.clone(),
        timezone_id: None,
        locale: None,
        latitude: None,
        longitude: None,
        accuracy: None,
        viewport_width: None,
        viewport_height: None,
        device_scale_factor: None,
        is_mobile: None,
        network_throttling: None,
    });

    // MCP analyses use a shorter timeout so they always auto-stop and return results to the client.
    let state_tt = state.clone();
    let id_tt = id.clone();
    let cmd_tx = state.agent_cmd_tx.clone();
    let handle = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(MCP_ANALYSIS_TIMEOUT_SECS)).await;
        let _ = cmd_tx.send(AgentCommand::StopAnalysis {
            analysis_id: id_tt.clone(),
        });
        state_tt.cancel_analysis_timeout(&id_tt);
        state_tt.cancel_mcp_no_data_timer(&id_tt);
    });
    state.analysis_timeouts.insert(id.clone(), handle);

    Ok(format!(
        "Analysis submitted.\nid: {}\nurl: {}\nstatus: pending\n\nUse carabistouille_get_analysis with id \"{}\" to poll for completion and the report.",
        id, url, id
    ))
}

fn list_analyses(State(state): State<AppState>, args: &Value) -> Result<String, (i32, String)> {
    let limit = args
        .get("limit")
        .and_then(|v| v.as_u64())
        .unwrap_or(20) as usize;
    let status_filter: Option<AnalysisStatus> = match args.get("status").and_then(|v| v.as_str()) {
        None => None,
        Some(s) => Some(match s {
            "pending" => AnalysisStatus::Pending,
            "running" => AnalysisStatus::Running,
            "complete" => AnalysisStatus::Complete,
            "error" => AnalysisStatus::Error,
            _ => return Err((-32602, format!("Invalid status: {}", s))),
        }),
    };

    let mut analyses: Vec<Analysis> = state
        .analyses
        .iter()
        .map(|e| {
            let mut a = e.value().clone();
            a.screenshot = None;
            a.screenshot_timeline = Vec::new();
            a
        })
        .filter(|a| status_filter.as_ref().map_or(true, |s| a.status == *s))
        .collect();
    analyses.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    analyses.truncate(limit);

    let lines: Vec<String> = analyses
        .iter()
        .map(|a| {
            let risk = a
                .report
                .as_ref()
                .map(|r| r.risk_score.to_string())
                .unwrap_or_else(|| "-".to_string());
            format!(
                "{}  {}  {}  {}  risk={}",
                a.id,
                a.status.status_str(),
                a.created_at.to_rfc3339(),
                a.url,
                risk
            )
        })
        .collect();
    Ok(if lines.is_empty() {
        "No analyses found.".to_string()
    } else {
        lines.join("\n")
    })
}

/// Response for get_analysis: text summary and optional screenshot for MCP content array.
struct GetAnalysisResponse {
    text: String,
    /// (base64_data, media_type) e.g. ("...", "image/webp")
    screenshot: Option<(String, String)>,
}

fn get_analysis(State(state): State<AppState>, args: &Value) -> Result<GetAnalysisResponse, (i32, String)> {
    let id = args
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or((-32602, "Missing required argument: id".to_string()))?;
    let analysis = state.analyses.get(id).ok_or((
        -32001,
        format!("Analysis not found: {}", id),
    ))?;
    let a = analysis.value();

    let mut out = format!(
        "id: {}\nurl: {}\nstatus: {}\ncreated_at: {}\n",
        a.id,
        a.url,
        a.status.status_str(),
        a.created_at.to_rfc3339()
    );
    if let Some(ref r) = a.report {
        out.push_str(&format!("final_url: {}\n", r.final_url.as_deref().unwrap_or("-")));
        out.push_str(&format!("page_title: {}\n", r.page_title.as_deref().unwrap_or("-")));
        out.push_str(&format!("risk_score: {}\n", r.risk_score));
        if !r.risk_factors.is_empty() {
            out.push_str("risk_factors:\n");
            for f in &r.risk_factors {
                out.push_str(&format!("  - {}\n", f));
            }
        }
        if !r.phishing_indicators.is_empty() {
            out.push_str("phishing_indicators:\n");
            for p in &r.phishing_indicators {
                out.push_str(&format!("  - {}\n", p));
            }
        }
        out.push_str(&format!("redirect_chain length: {}\n", r.redirect_chain.len()));
        out.push_str(&format!("network_requests: {}\n", r.network_requests.len()));
        out.push_str(&format!("scripts: {}\n", r.scripts.len()));
    }
    if !a.tags.is_empty() {
        out.push_str(&format!("tags: {}\n", a.tags.join(", ")));
    }
    // Screenshot is typically WebP from the agent; include so MCP clients can show it.
    let screenshot = a.screenshot.as_ref().map(|s| (s.clone(), "image/webp".to_string()));
    Ok(GetAnalysisResponse { text: out, screenshot })
}

fn database_summary(State(state): State<AppState>) -> Result<String, (i32, String)> {
    let mut pending = 0usize;
    let mut running = 0usize;
    let mut complete = 0usize;
    let mut error = 0usize;
    let mut all: Vec<Analysis> = Vec::new();
    for entry in state.analyses.iter() {
        let a = entry.value().clone();
        match a.status {
            AnalysisStatus::Pending => pending += 1,
            AnalysisStatus::Running => running += 1,
            AnalysisStatus::Complete => complete += 1,
            AnalysisStatus::Error => error += 1,
        }
        all.push(a);
    }
    all.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    let recent: Vec<String> = all
        .iter()
        .take(10)
        .map(|a| {
            format!(
                "{}  {}  {}  risk={}",
                a.url,
                a.status.status_str(),
                a.created_at.to_rfc3339(),
                a.report.as_ref().map(|r| r.risk_score).unwrap_or(0)
            )
        })
        .collect();

    let total = pending + running + complete + error;
    let mut out = format!(
        "Total analyses: {}\nBy status: pending={} running={} complete={} error={}\n\nRecent (up to 10):\n",
        total, pending, running, complete, error
    );
    for line in recent {
        out.push_str(&format!("  {}\n", line));
    }
    Ok(out)
}

impl AnalysisStatus {
    fn status_str(&self) -> &'static str {
        match self {
            AnalysisStatus::Pending => "pending",
            AnalysisStatus::Running => "running",
            AnalysisStatus::Complete => "complete",
            AnalysisStatus::Error => "error",
        }
    }
}
