//! Baliverne application state: room store, Docker client, broadcast channels.

use crate::baliverne::config::Config;
use crate::baliverne::docker::DockerManager;
use crate::baliverne::protocol::{RoomId, SessionId};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc, RwLock};

/// Per-room state: browser type, container id, broadcast for events, channel to send commands to runtime.
#[derive(Clone)]
pub struct Room {
    pub id: RoomId,
    pub session_id: SessionId,
    pub browser: BrowserKind,
    pub container_id: Option<String>,
    pub tx: broadcast::Sender<Vec<u8>>,
    pub runtime_tx: Option<mpsc::Sender<Vec<u8>>>,
    pub rtp_tx: Option<mpsc::Sender<Vec<u8>>>,
    pub viewer_count: Arc<AtomicUsize>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BrowserKind {
    Chrome,
    Firefox,
}

impl std::str::FromStr for BrowserKind {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "chrome" => Ok(BrowserKind::Chrome),
            "firefox" => Ok(BrowserKind::Firefox),
            _ => Err(format!("unknown browser: {}", s)),
        }
    }
}

/// Global Baliverne state (rooms, Docker, session lookup).
pub struct AppState {
    pub config: Config,
    pub docker: DockerManager,
    pub rooms: Arc<RwLock<HashMap<RoomId, Room>>>,
    pub session_to_room: Arc<RwLock<HashMap<SessionId, RoomId>>>,
}

impl AppState {
    pub fn new(config: Config) -> Self {
        Self {
            config: config.clone(),
            docker: DockerManager::new(config),
            rooms: Arc::new(RwLock::new(HashMap::new())),
            session_to_room: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn add_room(&self, room: Room) {
        let id = room.id;
        let sid = room.session_id;
        self.rooms.write().await.insert(id, room);
        self.session_to_room.write().await.insert(sid, id);
    }

    pub async fn remove_room(&self, room_id: RoomId) -> Option<Room> {
        let room = self.rooms.write().await.remove(&room_id);
        if let Some(ref r) = room {
            self.session_to_room.write().await.remove(&r.session_id);
        }
        room
    }

    pub async fn get_room(&self, room_id: RoomId) -> Option<Room> {
        self.rooms.read().await.get(&room_id).cloned()
    }

    pub async fn get_room_by_session(&self, session_id: SessionId) -> Option<Room> {
        let room_id = self.session_to_room.read().await.get(&session_id).copied()?;
        self.rooms.read().await.get(&room_id).cloned()
    }

    pub async fn list_rooms(&self) -> Vec<Room> {
        self.rooms.read().await.values().cloned().collect()
    }

    pub async fn set_room_container(&self, room_id: RoomId, container_id: String) {
        if let Some(room) = self.rooms.write().await.get_mut(&room_id) {
            room.container_id = Some(container_id);
        }
    }

    pub async fn set_runtime_tx(
        &self,
        session_id: SessionId,
        tx: mpsc::Sender<Vec<u8>>,
    ) -> Option<RoomId> {
        let room_id = self.session_to_room.read().await.get(&session_id).copied()?;
        self.rooms.write().await.get_mut(&room_id).map(|r| {
            r.runtime_tx = Some(tx);
        });
        Some(room_id)
    }

    pub async fn set_room_rtp_tx(&self, room_id: RoomId, tx: Option<mpsc::Sender<Vec<u8>>>) {
        if let Some(room) = self.rooms.write().await.get_mut(&room_id) {
            room.rtp_tx = tx;
        }
    }

    pub async fn increment_viewer_count(&self, room_id: RoomId) {
        if let Some(room) = self.rooms.read().await.get(&room_id) {
            room.viewer_count.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub async fn decrement_viewer_count(&self, room_id: RoomId) -> usize {
        if let Some(room) = self.rooms.read().await.get(&room_id) {
            let prev = room.viewer_count.fetch_sub(1, Ordering::Relaxed);
            return prev.saturating_sub(1);
        }
        usize::MAX
    }
}
