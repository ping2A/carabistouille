//! XTest-based input injector for Baliverne.
//!
//! Equivalent to Neko's server/pkg/xorg: one persistent X connection,
//! inject mouse/key via XTest (no process spawn per event).
//!
//! Reads commands from stdin, one per line:
//!   m X Y     - move cursor to (X, Y)
//!   c X Y     - click at (X, Y) (button 1 down + up)
//!   b N 1     - button N down (N=1,2,3,4,5)
//!   b N 0     - button N up
//!
//! Exit 0 on EOF, 1 on connection/parse error.

use std::io::{self, BufRead};
use std::process::exit;

use x11rb::connection::Connection;
use x11rb::protocol::xtest::ConnectionExt as XtestExt;

const MOTION_NOTIFY: u8 = 6;
const BUTTON_PRESS: u8 = 4;
const BUTTON_RELEASE: u8 = 5;

fn main() {
    let display = std::env::var("DISPLAY").unwrap_or_else(|_| ":0".into());
    let (conn, screen_num) = match x11rb::connect(Some(display.as_str())) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("xtest-injector: X11 connect failed: {}", e);
            exit(1);
        }
    };

    let setup = conn.setup();
    let root = setup.roots[screen_num].root;
    let mut time = 0u32;

    let stdin = io::stdin();
    let mut lines = stdin.lock().lines();

    while let Some(Ok(line)) = lines.next() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let parts: Vec<&str> = line.split_ascii_whitespace().collect();
        if parts.is_empty() {
            continue;
        }

        let ok = match parts[0] {
            "m" => {
                if parts.len() >= 3 {
                    let x: i16 = parts[1].parse().unwrap_or(0);
                    let y: i16 = parts[2].parse().unwrap_or(0);
                    conn.xtest_fake_input(MOTION_NOTIFY, 0, time, root, x, y, 0)
                        .map(|_| {
                            conn.flush().ok();
                        })
                        .is_ok()
                } else {
                    false
                }
            }
            "c" => {
                if parts.len() >= 3 {
                    let x: i16 = parts[1].parse().unwrap_or(0);
                    let y: i16 = parts[2].parse().unwrap_or(0);
                    let mut ok = true;
                    ok &= conn.xtest_fake_input(MOTION_NOTIFY, 0, time, root, x, y, 0).is_ok();
                    conn.flush().ok();
                    time = time.wrapping_add(1);
                    ok &= conn.xtest_fake_input(BUTTON_PRESS, 1, time, root, x, y, 0).is_ok();
                    conn.flush().ok();
                    time = time.wrapping_add(1);
                    ok &= conn.xtest_fake_input(BUTTON_RELEASE, 1, time, root, x, y, 0).is_ok();
                    conn.flush().ok();
                    ok
                } else {
                    false
                }
            }
            "b" => {
                if parts.len() >= 3 {
                    let button: u8 = parts[1].parse().unwrap_or(1).min(5).max(1);
                    let down: bool = parts[2] == "1";
                    let ev = if down { BUTTON_PRESS } else { BUTTON_RELEASE };
                    conn.xtest_fake_input(ev, button, time, root, 0, 0, 0)
                        .map(|_| {
                            conn.flush().ok();
                        })
                        .is_ok()
                } else {
                    false
                }
            }
            _ => true,
        };

        if !ok {
            eprintln!("xtest-injector: failed to send: {}", line);
        }
    }

    exit(0);
}
