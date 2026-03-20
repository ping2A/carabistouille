//! Shared application state: analyses store, agent command channel, viewer channels, analysis timeouts, DB persistence.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use dashmap::{DashMap, DashSet};
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::db::DbOp;
use crate::models::Analysis;
use crate::protocol::AgentCommand;

/// Default analysis timeout: force-stop after this many seconds if still running.
pub const DEFAULT_ANALYSIS_TIMEOUT_SECS: u64 = 5 * 60; // 5 minutes

/// For MCP-submitted analyses only: if after navigation we still have no network data after this many seconds, finish the analysis.
pub const MCP_NO_DATA_DELAY_SECS: u64 = 12;

/// Max duration for MCP-submitted analyses: force-stop the analysis and the agent run after this many seconds so MCP clients get results automatically.
pub const MCP_ANALYSIS_TIMEOUT_SECS: u64 = 60;

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
    /// When docker_agent is true: true = real Chrome (headed), false = headless (or lightpanda if lightpanda is true).
    pub real_chrome: bool,
    /// When docker_agent is true: use Lightpanda browser (CDP) instead of Chromium/Chrome.
    pub lightpanda: bool,
    /// Per-analysis timeout task: when it fires, server sends StopAnalysis. Aborted when analysis completes or is stopped.
    pub analysis_timeouts: Arc<DashMap<String, tokio::task::JoinHandle<()>>>,
    /// For MCP analyses: timer that stops the analysis if no network data after MCP_NO_DATA_DELAY_SECS. Aborted when we get any network request.
    pub mcp_no_data_timers: Arc<DashMap<String, tokio::task::JoinHandle<()>>>,
    /// Channel to send persistence ops to the SQLite thread. Fire-and-forget; failures are logged in the DB thread.
    pub db_tx: Arc<std::sync::mpsc::Sender<DbOp>>,
    /// When true, POST /mcp is enabled for MCP (Model Context Protocol) JSON-RPC.
    pub mcp_enabled: bool,
    /// When Some, Baliverne agent is enabled: Docker sessions, WebRTC, X11 dummy driver.
    pub baliverne: Option<Arc<crate::baliverne::state::AppState>>,
    /// analysis_id -> (room_id, session_id) for Baliverne-backed analyses.
    pub analysis_to_baliverne: Option<Arc<DashMap<String, (Uuid, Uuid)>>>,
    /// room_id -> analysis_id for forwarding runtime events to the correct analysis.
    pub baliverne_room_to_analysis: Option<Arc<DashMap<Uuid, String>>>,
    /// Analysis IDs for which we already sent stop_analysis to the agent (stale/orphan sessions). Avoids spamming stop.
    pub stale_analysis_stop_sent: Arc<DashSet<String>>,
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
        lightpanda: bool,
        mcp_enabled: bool,
        baliverne: Option<Arc<crate::baliverne::state::AppState>>,
        analysis_to_baliverne: Option<Arc<DashMap<String, (Uuid, Uuid)>>>,
        baliverne_room_to_analysis: Option<Arc<DashMap<Uuid, String>>>,
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
            lightpanda,
            analysis_timeouts: Arc::new(DashMap::new()),
            mcp_no_data_timers: Arc::new(DashMap::new()),
            db_tx: Arc::new(db_tx),
            mcp_enabled,
            baliverne,
            analysis_to_baliverne,
            baliverne_room_to_analysis,
            stale_analysis_stop_sent: Arc::new(DashSet::new()),
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

    /// Cancel the MCP no-data timer for this analysis (e.g. when we received network data). No-op if none.
    pub fn cancel_mcp_no_data_timer(&self, analysis_id: &str) {
        if let Some((_, handle)) = self.mcp_no_data_timers.remove(analysis_id) {
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
