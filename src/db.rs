//! SQLite persistence: analyses stored locally and loaded on startup.

use std::path::Path;
use std::sync::mpsc;
use std::thread;

use rusqlite::Connection;

use crate::models::{Analysis, AnalysisReport, AnalysisRunOptions, AnalysisStatus, ScreenshotEntry};

/// Operations sent to the DB thread (insert, update, delete).
#[derive(Clone)]
pub enum DbOp {
    Insert(Analysis),
    Update(Analysis),
    Delete(String),
}

/// Create the `analyses` table if it does not exist (id, url, status, timestamps, report_json, screenshot, timeline, notes, tags, run_options_json).
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
            screenshot_timeline_json TEXT,
            notes TEXT,
            tags_json TEXT,
            run_options_json TEXT
        )
        "#,
        [],
    )?;
    // Migration: add columns to existing tables (ignore if already present)
    let _ = conn.execute("ALTER TABLE analyses ADD COLUMN notes TEXT", []);
    let _ = conn.execute("ALTER TABLE analyses ADD COLUMN tags_json TEXT", []);
    let _ = conn.execute("ALTER TABLE analyses ADD COLUMN run_options_json TEXT", []);
    Ok(())
}

/// Serialize analysis status for storage (pending | running | complete | error).
fn status_to_str(s: &AnalysisStatus) -> &'static str {
    match s {
        AnalysisStatus::Pending => "pending",
        AnalysisStatus::Running => "running",
        AnalysisStatus::Complete => "complete",
        AnalysisStatus::Error => "error",
    }
}

/// Parse stored status string into `AnalysisStatus`; defaults to Pending on unknown.
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
        "SELECT id, url, status, created_at, completed_at, report_json, screenshot, screenshot_timeline_json, notes, tags_json, run_options_json FROM analyses",
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
        let notes: Option<String> = row.get::<_, Option<String>>(8).ok().flatten();
        let tags_json: Option<String> = row.get::<_, Option<String>>(9).ok().flatten();
        let run_options_json: Option<String> = row.get::<_, Option<String>>(10).ok().flatten();

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
        let tags: Vec<String> = tags_json
            .as_deref()
            .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
            .unwrap_or_default();
        let run_options = run_options_json
            .as_deref()
            .and_then(|s| serde_json::from_str::<AnalysisRunOptions>(s).ok());

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
            notes,
            tags,
            run_options,
            submitted_via_mcp: false,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        let a = row?;
        tracing::info!("Loaded analysis {}: {}", a.id, a.url);
        out.push(a);
    }
    // After a restart, analyses that were "pending" or "running" are stale (no live agent); mark as complete and persist.
    let mut to_persist = Vec::new();
    for a in out.iter_mut() {
        let was = a.status.clone();
        if was == AnalysisStatus::Pending || was == AnalysisStatus::Running {
            tracing::info!(
                "Loaded analysis {} was {}, marking as complete",
                a.id,
                if was == AnalysisStatus::Pending { "pending" } else { "running" }
            );
            a.status = AnalysisStatus::Complete;
            if a.completed_at.is_none() {
                a.completed_at = Some(chrono::Utc::now());
            }
            to_persist.push(a.clone());
        }
    }
    for a in to_persist {
        if let Err(e) = apply_op(&conn, DbOp::Update(a)) {
            tracing::warn!("Failed to persist status update to database: {}", e);
        }
    }
    tracing::info!("Loaded {} analyses from database", out.len());
    Ok(out)
}

/// Apply a single DB operation: insert/update analysis or delete by id.
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
            let tags_json: Option<String> = if a.tags.is_empty() {
                None
            } else {
                serde_json::to_string(&a.tags).ok()
            };
            let run_options_json: Option<String> = a.run_options.as_ref().and_then(|o| serde_json::to_string(o).ok());
            conn.execute(
                r#"
                INSERT INTO analyses (id, url, status, created_at, completed_at, report_json, screenshot, screenshot_timeline_json, notes, tags_json, run_options_json)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                ON CONFLICT(id) DO UPDATE SET
                    url = excluded.url,
                    status = excluded.status,
                    created_at = excluded.created_at,
                    completed_at = excluded.completed_at,
                    report_json = excluded.report_json,
                    screenshot = excluded.screenshot,
                    screenshot_timeline_json = excluded.screenshot_timeline_json,
                    notes = excluded.notes,
                    tags_json = excluded.tags_json,
                    run_options_json = excluded.run_options_json
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
                    a.notes,
                    tags_json,
                    run_options_json,
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
