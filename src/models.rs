//! Data models for analyses, reports, and events.
//! Used by the REST API, WebSocket protocol, and in-memory state.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// A single screenshot in the timeline (base64 JPEG data + timestamp).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenshotEntry {
    pub data: String,
    pub timestamp: f64,
}

/// One URL analysis: id, status, optional report, last screenshot, and screenshot timeline.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Analysis {
    pub id: String,
    pub url: String,
    pub status: AnalysisStatus,
    pub created_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
    pub report: Option<AnalysisReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screenshot: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub screenshot_timeline: Vec<ScreenshotEntry>,
}

/// Lifecycle state of an analysis (pending → running → complete | error).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AnalysisStatus {
    Pending,
    Running,
    Complete,
    Error,
}

/// One intercepted clipboard write (content, time, trigger e.g. "click" or "poll").
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipboardRead {
    pub content: String,
    pub timestamp: f64,
    pub trigger: String,
}

/// Captured response body for a text-based resource (URL, content type, size, full content).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawFile {
    pub url: String,
    pub content_type: String,
    pub size: u64,
    pub content: String,
    pub timestamp: f64,
}

/// Full report for a completed (or stopped) analysis: URLs, requests, scripts, console, security, risk.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AnalysisReport {
    pub final_url: Option<String>,
    pub page_title: Option<String>,
    pub redirect_chain: Vec<RedirectEntry>,
    pub network_requests: Vec<NetworkRequest>,
    pub scripts: Vec<ScriptInfo>,
    pub console_logs: Vec<ConsoleLog>,
    #[serde(default)]
    pub clipboard_reads: Vec<ClipboardRead>,
    #[serde(default)]
    pub raw_files: Vec<RawFile>,
    #[serde(default)]
    pub page_source: Option<String>,
    #[serde(default)]
    pub dom_snapshot: Option<String>,
    #[serde(default)]
    pub storage_capture: Option<StorageCapture>,
    #[serde(default)]
    pub security_headers: Vec<HttpHeader>,
    pub security: SecurityInfo,
    pub risk_score: u32,
    pub risk_factors: Vec<String>,
}

/// One redirect step (from URL → to URL, HTTP status).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RedirectEntry {
    pub from: String,
    pub to: String,
    pub status: u16,
}

/// One captured network request (URL, method, status, content-type, third-party flag, timestamp).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkRequest {
    pub url: String,
    pub method: String,
    pub status: Option<u16>,
    pub content_type: Option<String>,
    pub size: Option<u64>,
    pub remote_ip: Option<String>,
    pub is_third_party: bool,
    pub timestamp: f64,
}

/// Script metadata and optional full source (URL or inline, size, content, timestamp).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScriptInfo {
    pub url: Option<String>,
    pub is_inline: bool,
    pub size: Option<u64>,
    pub hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default)]
    pub timestamp: Option<f64>,
}

/// One console message (level, text, timestamp).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsoleLog {
    pub level: String,
    pub text: String,
    pub timestamp: f64,
}

/// Security summary: SSL validity, mixed content, suspicious patterns.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SecurityInfo {
    pub ssl_valid: Option<bool>,
    pub ssl_issuer: Option<String>,
    pub ssl_protocol: Option<String>,
    pub has_mixed_content: bool,
    pub suspicious_patterns: Vec<String>,
}

/// One cookie (name, value, domain, path, flags). Used to flag sensitive names (session, token, etc.).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CookieInfo {
    pub name: String,
    pub value: String,
    pub domain: Option<String>,
    pub path: Option<String>,
    pub http_only: Option<bool>,
    pub secure: Option<bool>,
    pub same_site: Option<String>,
}

/// One localStorage or sessionStorage entry (key/value).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageEntry {
    pub key: String,
    pub value: String,
}

/// Captured cookies and storage for the main frame (and optionally third-party frames).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StorageCapture {
    pub cookies: Vec<CookieInfo>,
    pub local_storage: Vec<StorageEntry>,
    pub session_storage: Vec<StorageEntry>,
}

/// One HTTP response header (e.g. Content-Security-Policy, X-Frame-Options).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpHeader {
    pub name: String,
    pub value: String,
}
