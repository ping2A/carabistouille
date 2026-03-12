//! TURN relay server for WebRTC NAT traversal.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use dashmap::DashMap;
use tokio::net::UdpSocket;
use tokio::sync::mpsc;
use tokio::time::Duration;
use tracing::{info, warn};
use turn::allocation::AllocationInfo;
use turn::auth::{generate_auth_key, AuthHandler};
use turn::relay::relay_static::RelayAddressGeneratorStatic;
use turn::server::config::{ConnConfig, ServerConfig};
use turn::server::Server;
use turn::Error as TurnError;
use webrtc_util::vnet::net::Net;

#[derive(Clone, Debug)]
pub struct TurnRelayConfig {
    pub bind_addr: SocketAddr,
    pub relay_public_ip: IpAddr,
    pub realm: String,
    pub auth_static: Option<(String, String)>,
    pub auth_dynamic_registry: Option<Arc<DashMap<String, Vec<u8>>>>,
}

#[derive(Clone)]
struct StaticAuthHandler {
    realm: String,
    keys: HashMap<String, Vec<u8>>,
}

impl StaticAuthHandler {
    fn new(username: String, realm: String, password: String) -> Self {
        let mut keys = HashMap::new();
        keys.insert(username.clone(), generate_auth_key(&username, &realm, &password));
        Self { realm, keys }
    }
}

impl AuthHandler for StaticAuthHandler {
    fn auth_handle(
        &self,
        username: &str,
        realm: &str,
        src_addr: SocketAddr,
    ) -> Result<Vec<u8>, TurnError> {
        if realm != self.realm {
            return Err(TurnError::ErrNoSuchUser);
        }
        match self.keys.get(username) {
            Some(key) => {
                info!("TURN: client from {}", src_addr);
                Ok(key.clone())
            }
            None => Err(TurnError::ErrNoSuchUser),
        }
    }
}

#[derive(Clone)]
struct DynamicAuthHandler {
    realm: String,
    registry: Arc<DashMap<String, Vec<u8>>>,
}

impl AuthHandler for DynamicAuthHandler {
    fn auth_handle(
        &self,
        username: &str,
        realm: &str,
        src_addr: SocketAddr,
    ) -> Result<Vec<u8>, TurnError> {
        if realm != self.realm {
            return Err(TurnError::ErrNoSuchUser);
        }
        match self.registry.get(username) {
            Some(key) => {
                info!("TURN: client from {}", src_addr);
                Ok(key.clone())
            }
            None => Err(TurnError::ErrNoSuchUser),
        }
    }
}

pub async fn run_turn_relay(cfg: TurnRelayConfig) -> Result<(), TurnError> {
    let conn = Arc::new(UdpSocket::bind(cfg.bind_addr).await?);
    info!(
        "TURN listening on {} (relay_public_ip={})",
        cfg.bind_addr, cfg.relay_public_ip
    );

    let (alloc_tx, mut alloc_rx) = mpsc::channel::<AllocationInfo>(1024);
    tokio::spawn(async move {
        loop {
            tokio::select! {
                opt = alloc_rx.recv() => {
                    if opt.is_none() { break; }
                }
            }
        }
    });

    let auth_handler: Arc<dyn AuthHandler + Send + Sync> =
        if let Some(registry) = cfg.auth_dynamic_registry {
            Arc::new(DynamicAuthHandler {
                realm: cfg.realm.clone(),
                registry,
            })
        } else if let Some((username, password)) = cfg.auth_static {
            Arc::new(StaticAuthHandler::new(username, cfg.realm.clone(), password))
        } else {
            warn!("TURN: auth_static or auth_dynamic_registry must be set");
            return Ok(());
        };

    let _server = Server::new(ServerConfig {
        conn_configs: vec![ConnConfig {
            conn,
            relay_addr_generator: Box::new(RelayAddressGeneratorStatic {
                relay_address: cfg.relay_public_ip,
                address: "0.0.0.0".to_string(),
                net: Arc::new(Net::new(None)),
            }),
        }],
        realm: cfg.realm.clone(),
        auth_handler,
        channel_bind_timeout: Duration::from_secs(0),
        alloc_close_notify: Some(alloc_tx),
    })
    .await?;

    std::future::pending::<()>().await;
    Ok(())
}
