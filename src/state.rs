//! Shared application state: analyses store, agent command channel, viewer channels, analysis timeouts.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use dashmap::DashMap;
use tokio::sync::broadcast;

use crate::models::Analysis;
use crate::protocol::AgentCommand;

/// Default analysis timeout: force-stop after this many seconds if still running.
pub const DEFAULT_ANALYSIS_TIMEOUT_SECS: u64 = 5 * 60; // 5 minutes

/// Global state shared by REST handlers and WebSocket handlers.
/// Analyses are keyed by UUID; viewer_channels are created on demand per analysis.
#[derive(Clone)]
pub struct AppState {
    pub analyses: Arc<DashMap<String, Analysis>>,
    pub agent_cmd_tx: broadcast::Sender<AgentCommand>,
    pub viewer_channels: Arc<DashMap<String, broadcast::Sender<String>>>,
    pub agent_connected: Arc<AtomicBool>,
    /// Per-analysis timeout task: when it fires, server sends StopAnalysis. Aborted when analysis completes or is stopped.
    pub analysis_timeouts: Arc<DashMap<String, tokio::task::JoinHandle<()>>>,
}

impl AppState {
    /// Create new state: empty analyses map, broadcast channel for agent commands, no viewers, no timeouts.
    pub fn new() -> Self {
        let (agent_cmd_tx, _) = broadcast::channel(1024);
        Self {
            analyses: Arc::new(DashMap::new()),
            agent_cmd_tx,
            viewer_channels: Arc::new(DashMap::new()),
            agent_connected: Arc::new(AtomicBool::new(false)),
            analysis_timeouts: Arc::new(DashMap::new()),
        }
    }

    /// Cancel the timeout task for this analysis (on complete, error, or user stop). No-op if none.
    pub fn cancel_analysis_timeout(&self, analysis_id: &str) {
        if let Some((_, handle)) = self.analysis_timeouts.remove(analysis_id) {
            handle.abort();
        }
    }

    /// Get or create the broadcast sender for viewers watching this analysis.
    /// Each viewer subscribes to this channel to receive forwarded agent events.
    pub fn get_viewer_tx(&self, analysis_id: &str) -> broadcast::Sender<String> {
        self.viewer_channels
            .entry(analysis_id.to_string())
            .or_insert_with(|| broadcast::channel(512).0)
            .clone()
    }
}
