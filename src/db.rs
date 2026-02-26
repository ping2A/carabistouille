//! SQLite persistence: analyses stored locally and loaded on startup.

use std::path::Path;
use std::sync::mpsc;
use std::thread;

use rusqlite::Connection;

use crate::models::{Analysis, AnalysisReport, AnalysisStatus, ScreenshotEntry};

/// Operations sent to the DB thread (insert, update, delete).
#[derive(Clone)]
pub enum DbOp {
    Insert(Analysis),
    Update(Analysis),
    Delete(String),
}

/// Create the analyses table if it does not exist.
fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        r#"
        CREATE TABLE IF NOT EXISTS analyses (
            id TEXT PRIMARY KEY,
            url TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            completed_at TEXT,
            report_json TEXT,
            screenshot TEXT,
            screenshot_timeline_json TEXT
        )
        "#,
        [],
    )?;
    Ok(())
}

fn status_to_str(s: &AnalysisStatus) -> &'static str {
    match s {
        AnalysisStatus::Pending => "pending",
        AnalysisStatus::Running => "running",
        AnalysisStatus::Complete => "complete",
        AnalysisStatus::Error => "error",
    }
}

fn str_to_status(s: &str) -> AnalysisStatus {
    match s {
        "pending" => AnalysisStatus::Pending,
        "running" => AnalysisStatus::Running,
        "complete" => AnalysisStatus::Complete,
        "error" => AnalysisStatus::Error,
        _ => AnalysisStatus::Pending,
    }
}

/// Load all analyses from the database (for startup). Call before starting the DB thread.
pub fn load_analyses(path: &Path) -> rusqlite::Result<Vec<Analysis>> {
    tracing::info!("Loading analyses from database {:?}", path);
    let conn = Connection::open(path)?;
    init_schema(&conn)?;
    let mut stmt = conn.prepare(
        "SELECT id, url, status, created_at, completed_at, report_json, screenshot, screenshot_timeline_json FROM analyses",
    )?;
    let rows = stmt.query_map([], |row| {
        let id: String = row.get(0)?;
        let url: String = row.get(1)?;
        let status: String = row.get(2)?;
        let created_at: String = row.get(3)?;
        let completed_at: Option<String> = row.get(4)?;
        let report_json: Option<String> = row.get(5)?;
        let screenshot: Option<String> = row.get(6)?;
        let screenshot_timeline_json: Option<String> = row.get(7)?;

        let created_at = chrono::DateTime::parse_from_rfc3339(&created_at)
            .map(|dt| dt.with_timezone(&chrono::Utc))
            .unwrap_or_else(|_| chrono::Utc::now());
        let completed_at = completed_at
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(&s).ok())
            .map(|dt| dt.with_timezone(&chrono::Utc));
        let report = report_json
            .as_deref()
            .and_then(|s| serde_json::from_str::<AnalysisReport>(s).ok());
        let screenshot_timeline = screenshot_timeline_json
            .as_deref()
            .and_then(|s| serde_json::from_str::<Vec<ScreenshotEntry>>(s).ok())
            .unwrap_or_default();

        Ok(Analysis {
            id,
            url,
            status: str_to_status(&status),
            created_at,
            completed_at,
            report,
            screenshot,
            screenshot_timeline,
            last_screenshot_forward_time_ms: None,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        let a = row?;
        tracing::info!("Loaded analysis {}: {}", a.id, a.url);
        out.push(a);
    }
    tracing::info!("Loaded {} analyses from database", out.len());
    Ok(out)
}

fn apply_op(conn: &Connection, op: DbOp) -> rusqlite::Result<()> {
    match op {
        DbOp::Insert(a) | DbOp::Update(a) => {
            tracing::info!("Saving analysis {} ({}) to database", a.id, a.url);
            let created_at = a.created_at.to_rfc3339();
            let completed_at = a.completed_at.as_ref().map(chrono::DateTime::to_rfc3339);
            let report_json = a.report.as_ref().and_then(|r| serde_json::to_string(r).ok());
            let timeline_json: Option<String> = if a.screenshot_timeline.is_empty() {
                None
            } else {
                serde_json::to_string(&a.screenshot_timeline).ok()
            };
            conn.execute(
                r#"
                INSERT INTO analyses (id, url, status, created_at, completed_at, report_json, screenshot, screenshot_timeline_json)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                ON CONFLICT(id) DO UPDATE SET
                    url = excluded.url,
                    status = excluded.status,
                    created_at = excluded.created_at,
                    completed_at = excluded.completed_at,
                    report_json = excluded.report_json,
                    screenshot = excluded.screenshot,
                    screenshot_timeline_json = excluded.screenshot_timeline_json
                "#,
                rusqlite::params![
                    a.id,
                    a.url,
                    status_to_str(&a.status),
                    created_at,
                    completed_at,
                    report_json,
                    a.screenshot,
                    timeline_json,
                ],
            )?;
        }
        DbOp::Delete(id) => {
            tracing::info!("Deleting analysis {} from database", id);
            conn.execute("DELETE FROM analyses WHERE id = ?1", rusqlite::params![id])?;
        }
    }
    Ok(())
}

/// Start the background thread that owns the SQLite connection and processes DB ops.
/// Returns the sender and the join handle (caller may ignore the handle or join on shutdown).
pub fn run_db_thread(path: &Path) -> rusqlite::Result<(mpsc::Sender<DbOp>, thread::JoinHandle<()>)> {
    let path = path.to_path_buf();
    let (tx, rx) = mpsc::channel();
    let handle = thread::spawn(move || {
        let Ok(conn) = Connection::open(&path) else { return };
        let _ = init_schema(&conn);
        while let Ok(op) = rx.recv() {
            if let Err(e) = apply_op(&conn, op) {
                tracing::warn!("DB op failed: {}", e);
            }
        }
    });
    Ok((tx, handle))
}
