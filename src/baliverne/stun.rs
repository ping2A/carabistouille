//! Minimal RFC 5389 STUN server (Binding request/response only) for WebRTC ICE.

use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::UdpSocket;
use tracing::{debug, info, warn};

const MAGIC_COOKIE: u32 = 0x2112_A442;
const MSG_BINDING_REQUEST: u16 = 0x0001;
const MSG_BINDING_RESPONSE: u16 = 0x0101;
const ATTR_XOR_MAPPED_ADDRESS: u16 = 0x0020;
const FAMILY_IPV4: u8 = 0x01;
const STUN_HEADER_LEN: usize = 20;

pub async fn run(bind_addr: SocketAddr) -> std::io::Result<()> {
    let socket = UdpSocket::bind(bind_addr).await?;
    info!("STUN listening on {} (ICE/NAT traversal)", bind_addr);
    let socket = Arc::new(socket);
    loop {
        let mut buf = [0u8; 512];
        let (n, peer) = match socket.recv_from(&mut buf).await {
            Ok(x) => x,
            Err(e) => {
                warn!("STUN recv error: {e}");
                continue;
            }
        };
        let socket_clone = Arc::clone(&socket);
        let buf = buf[..n].to_vec();
        tokio::spawn(async move {
            if let Some(response) = handle_binding_request(&buf, peer) {
                if socket_clone.send_to(&response, peer).await.is_err() {
                    warn!("STUN: send to {} failed", peer);
                } else {
                    debug!("STUN: Binding response sent to {}", peer);
                }
            }
        });
    }
}

fn handle_binding_request(req: &[u8], client_addr: SocketAddr) -> Option<Vec<u8>> {
    if req.len() < STUN_HEADER_LEN {
        return None;
    }
    let msg_type = u16::from_be_bytes([req[0], req[1]]);
    if msg_type != MSG_BINDING_REQUEST {
        return None;
    }
    let length = u16::from_be_bytes([req[2], req[3]]) as usize;
    let cookie = u32::from_be_bytes([req[4], req[5], req[6], req[7]]);
    if cookie != MAGIC_COOKIE {
        return None;
    }
    let transaction_id = &req[8..20];
    if req.len() < STUN_HEADER_LEN + length {
        return None;
    }
    info!("STUN: Binding request from {} (ICE)", client_addr);
    build_binding_response(transaction_id, client_addr)
}

fn build_binding_response(transaction_id: &[u8], peer: SocketAddr) -> Option<Vec<u8>> {
    let (port_xor, addr_bytes) = match peer {
        SocketAddr::V4(v4) => {
            let port = peer.port();
            let port_xor = (port ^ (MAGIC_COOKIE >> 16) as u16).to_be_bytes();
            let ip = v4.ip().octets();
            let ip_u32 = u32::from_be_bytes(ip) ^ MAGIC_COOKIE;
            (port_xor, ip_u32.to_be_bytes())
        }
        SocketAddr::V6(_) => return None,
    };
    const XOR_MAPPED_VALUE_LEN: usize = 8;
    let attr_len = 2 + 2 + XOR_MAPPED_VALUE_LEN;
    const MIN_BODY_LEN: usize = 52;
    let msg_len = (std::cmp::max(attr_len, MIN_BODY_LEN) + 3) & !3;
    let mut out = Vec::with_capacity(STUN_HEADER_LEN + msg_len);
    out.extend_from_slice(&MSG_BINDING_RESPONSE.to_be_bytes());
    out.extend_from_slice(&(msg_len as u16).to_be_bytes());
    out.extend_from_slice(&MAGIC_COOKIE.to_be_bytes());
    out.extend_from_slice(transaction_id);
    out.extend_from_slice(&ATTR_XOR_MAPPED_ADDRESS.to_be_bytes());
    out.extend_from_slice(&(XOR_MAPPED_VALUE_LEN as u16).to_be_bytes());
    out.push(0);
    out.push(FAMILY_IPV4);
    out.extend_from_slice(&port_xor);
    out.extend_from_slice(&addr_bytes);
    for _ in attr_len..msg_len {
        out.push(0);
    }
    Some(out)
}
