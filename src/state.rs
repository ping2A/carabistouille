use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use dashmap::DashMap;
use tokio::sync::broadcast;

use crate::models::Analysis;
use crate::protocol::AgentCommand;

#[derive(Clone)]
pub struct AppState {
    pub analyses: Arc<DashMap<String, Analysis>>,
    pub agent_cmd_tx: broadcast::Sender<AgentCommand>,
    pub viewer_channels: Arc<DashMap<String, broadcast::Sender<String>>>,
    pub agent_connected: Arc<AtomicBool>,
}

impl AppState {
    pub fn new() -> Self {
        let (agent_cmd_tx, _) = broadcast::channel(1024);
        Self {
            analyses: Arc::new(DashMap::new()),
            agent_cmd_tx,
            viewer_channels: Arc::new(DashMap::new()),
            agent_connected: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn get_viewer_tx(&self, analysis_id: &str) -> broadcast::Sender<String> {
        self.viewer_channels
            .entry(analysis_id.to_string())
            .or_insert_with(|| broadcast::channel(512).0)
            .clone()
    }
}
