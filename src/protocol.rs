use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::models::{AnalysisReport, ClipboardRead, ConsoleLog, NetworkRequest, RawFile, ScriptInfo};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentCommand {
    Navigate { analysis_id: String, url: String, proxy: Option<String> },
    Click { analysis_id: String, x: f64, y: f64 },
    Scroll { analysis_id: String, delta_x: f64, delta_y: f64 },
    MoveMouse { analysis_id: String, x: f64, y: f64 },
    #[serde(rename = "type_text")]
    TypeText { analysis_id: String, text: String },
    KeyPress { analysis_id: String, key: String },
    InspectElement { analysis_id: String, x: f64, y: f64 },
    StopAnalysis { analysis_id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    Screenshot {
        analysis_id: String,
        data: String,
        width: u32,
        height: u32,
    },
    NetworkRequestCaptured {
        analysis_id: String,
        request: NetworkRequest,
    },
    ConsoleLogCaptured {
        analysis_id: String,
        log: ConsoleLog,
    },
    RedirectDetected {
        analysis_id: String,
        from: String,
        to: String,
        status: u16,
    },
    ScriptLoaded {
        analysis_id: String,
        script: ScriptInfo,
    },
    NavigationComplete {
        analysis_id: String,
        url: String,
        title: Option<String>,
    },
    AnalysisComplete {
        analysis_id: String,
        report: AnalysisReport,
    },
    ElementInfo {
        analysis_id: String,
        tag: String,
        id: Option<String>,
        classes: Vec<String>,
        attributes: HashMap<String, String>,
        text: String,
        rect: ElementRect,
    },
    RawFileCaptured {
        analysis_id: String,
        file: RawFile,
    },
    PageSourceCaptured {
        analysis_id: String,
        html: String,
    },
    ClipboardCaptured {
        analysis_id: String,
        read: ClipboardRead,
    },
    Error {
        analysis_id: String,
        message: String,
    },
    AgentReady,
}

impl AgentCommand {
    pub fn type_name(&self) -> &'static str {
        match self {
            Self::Navigate { .. } => "navigate",
            Self::Click { .. } => "click",
            Self::Scroll { .. } => "scroll",
            Self::MoveMouse { .. } => "move_mouse",
            Self::TypeText { .. } => "type_text",
            Self::KeyPress { .. } => "key_press",
            Self::InspectElement { .. } => "inspect_element",
            Self::StopAnalysis { .. } => "stop_analysis",
        }
    }
}

impl AgentEvent {
    pub fn type_name(&self) -> &'static str {
        match self {
            Self::Screenshot { .. } => "screenshot",
            Self::NetworkRequestCaptured { .. } => "network_request",
            Self::ConsoleLogCaptured { .. } => "console_log",
            Self::RedirectDetected { .. } => "redirect",
            Self::ScriptLoaded { .. } => "script_loaded",
            Self::NavigationComplete { .. } => "navigation_complete",
            Self::AnalysisComplete { .. } => "analysis_complete",
            Self::ElementInfo { .. } => "element_info",
            Self::RawFileCaptured { .. } => "raw_file_captured",
            Self::PageSourceCaptured { .. } => "page_source_captured",
            Self::ClipboardCaptured { .. } => "clipboard_captured",
            Self::Error { .. } => "error",
            Self::AgentReady => "agent_ready",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ElementRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
