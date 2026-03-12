//! Baliverne protocol: commands to runtime (container), events from runtime (Carabistouille-compatible names).

use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub type RoomId = Uuid;
pub type SessionId = Uuid;

/// Commands sent from server to browser runtime (container).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentCommand {
    Navigate {
        url: String,
        #[serde(default)]
        proxy: Option<String>,
        #[serde(default)]
        user_agent: Option<String>,
    },
    Click { x: f64, y: f64 },
    Scroll { dx: f64, dy: f64 },
    Mousemove { x: f64, y: f64 },
    TypeText { text: String },
    KeyPress { key: String },
    InspectElement { x: f64, y: f64 },
    StopAnalysis,
}
