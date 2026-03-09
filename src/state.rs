//! Shared application state: analyses store, agent command channel, viewer channels, analysis timeouts, DB persistence.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use dashmap::DashMap;
use tokio::sync::broadcast;

use crate::db::DbOp;
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
    /// When true, the agent was started by the server in Docker; /api/status exposes run_mode and chrome_mode.
    pub docker_agent: bool,
    /// When docker_agent is true: true = real Chrome (headed), false = headless.
    pub real_chrome: bool,
    /// Per-analysis timeout task: when it fires, server sends StopAnalysis. Aborted when analysis completes or is stopped.
    pub analysis_timeouts: Arc<DashMap<String, tokio::task::JoinHandle<()>>>,
    /// Channel to send persistence ops to the SQLite thread. Fire-and-forget; failures are logged in the DB thread.
    pub db_tx: Arc<std::sync::mpsc::Sender<DbOp>>,
    /// When true, POST /mcp is enabled for MCP (Model Context Protocol) JSON-RPC.
    pub mcp_enabled: bool,
}

impl AppState {
    /// Create new state: preload analyses into the map, broadcast channel for agent commands, no viewers, no timeouts, DB sender.
    /// When docker_agent is true, run_mode/chrome_mode are exposed in /api/status.
    /// When mcp_enabled is true, POST /mcp serves MCP JSON-RPC for LLM tools.
    pub fn new(
        analyses: Vec<Analysis>,
        db_tx: std::sync::mpsc::Sender<DbOp>,
        docker_agent: bool,
        real_chrome: bool,
        mcp_enabled: bool,
    ) -> Self {
        let (agent_cmd_tx, _) = broadcast::channel(1024);
        let analyses_map = Arc::new(DashMap::new());
        for a in analyses {
            analyses_map.insert(a.id.clone(), a);
        }
        Self {
            analyses: analyses_map,
            agent_cmd_tx,
            viewer_channels: Arc::new(DashMap::new()),
            agent_connected: Arc::new(AtomicBool::new(false)),
            docker_agent,
            real_chrome,
            analysis_timeouts: Arc::new(DashMap::new()),
            db_tx: Arc::new(db_tx),
            mcp_enabled,
        }
    }

    /// Persist an analysis (insert or update). Does not block the async runtime.
    pub fn persist_analysis(&self, analysis: Analysis) {
        let _ = self.db_tx.send(DbOp::Update(analysis));
    }

    /// Remove analysis from DB. Does not block the async runtime.
    pub fn persist_delete(&self, analysis_id: &str) {
        let _ = self.db_tx.send(DbOp::Delete(analysis_id.to_string()));
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
