use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenshotEntry {
    pub data: String,
    pub timestamp: f64,
}

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AnalysisStatus {
    Pending,
    Running,
    Complete,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipboardRead {
    pub content: String,
    pub timestamp: f64,
    pub trigger: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawFile {
    pub url: String,
    pub content_type: String,
    pub size: u64,
    pub content: String,
    pub timestamp: f64,
}

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
    pub security: SecurityInfo,
    pub risk_score: u32,
    pub risk_factors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RedirectEntry {
    pub from: String,
    pub to: String,
    pub status: u16,
}

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsoleLog {
    pub level: String,
    pub text: String,
    pub timestamp: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SecurityInfo {
    pub ssl_valid: Option<bool>,
    pub ssl_issuer: Option<String>,
    pub ssl_protocol: Option<String>,
    pub has_mixed_content: bool,
    pub suspicious_patterns: Vec<String>,
}
