//! WebRTC RTP: port allocation and UDP receiver (container → server → viewer).

use crate::baliverne::protocol::RoomId;
use crate::baliverne::state::AppState;
use std::sync::Arc;
use tokio::net::UdpSocket;
use tracing::{debug, info, warn};

pub async fn allocate_rtp_socket(
    port_start: u16,
    port_end: u16,
) -> Result<(UdpSocket, u16), String> {
    for port in port_start..=port_end {
        let addr = (std::net::Ipv4Addr::UNSPECIFIED, port);
        match UdpSocket::bind(addr).await {
            Ok(socket) => {
                info!(%port, "WebRTC RTP listener bound on 0.0.0.0:{}", port);
                return Ok((socket, port));
            }
            Err(e) => {
                debug!(%port, error = %e, "RTP port in use");
            }
        }
    }
    Err(format!(
        "no free RTP port in range {}-{}",
        port_start, port_end
    ))
}

pub fn spawn_rtp_receiver(state: Arc<AppState>, room_id: RoomId, socket: UdpSocket) {
    tokio::spawn(async move {
        let mut buf = vec![0u8; 4096];
        let mut rtp_count: u64 = 0;
        let mut forwarded_count: u64 = 0;
        let mut no_viewer_warned = false;
        loop {
            match socket.recv_from(&mut buf).await {
                Ok((n, from)) => {
                    if n < 12 {
                        continue;
                    }
                    rtp_count += 1;
                    if rtp_count == 1 {
                        info!(%room_id, from = %from, bytes = n, "RTP first packet from container");
                    } else if rtp_count % 500 == 0 {
                        debug!(%room_id, count = rtp_count, forwarded = forwarded_count, "RTP");
                    }
                    let packet = buf[..n].to_vec();
                    let rooms = state.rooms.read().await;
                    if let Some(room) = rooms.get(&room_id) {
                        if let Some(ref tx) = room.rtp_tx {
                            if tx.send(packet).await.is_ok() {
                                forwarded_count += 1;
                            }
                        } else if !no_viewer_warned {
                            no_viewer_warned = true;
                            warn!(%room_id, "RTP received but no viewer connected");
                        }
                    }
                    drop(rooms);
                }
                Err(e) => {
                    warn!(%room_id, error = %e, "RTP recv error");
                }
            }
        }
    });
}
