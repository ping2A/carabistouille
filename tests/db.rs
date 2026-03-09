//! Database tests: load_analyses, run_db_thread, persist and reload.

use carabistouille::db::{load_analyses, run_db_thread, DbOp};
use carabistouille::models::{Analysis, AnalysisStatus};
use chrono::Utc;
use std::path::Path;

fn sample_analysis(id: &str, url: &str, status: AnalysisStatus) -> Analysis {
    Analysis {
        id: id.to_string(),
        url: url.to_string(),
        status,
        created_at: Utc::now(),
        completed_at: None,
        report: None,
        screenshot: None,
        screenshot_timeline: vec![],
        last_screenshot_forward_time_ms: None,
        notes: None,
        tags: vec![],
        run_options: None,
    }
}

#[test]
fn load_analyses_empty_creates_schema() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("empty.db");
    let analyses = load_analyses(&path).unwrap();
    assert!(analyses.is_empty());
}

#[test]
fn persist_and_load_roundtrip() {
    let file = tempfile::NamedTempFile::new().unwrap();
    let path = file.path().to_path_buf();

    // Create DB and schema via load
    let _ = load_analyses(&path).unwrap();

    let (tx, handle) = run_db_thread(&path).unwrap();
    let a = sample_analysis("roundtrip-1", "https://example.com", AnalysisStatus::Complete);
    tx.send(DbOp::Update(a)).unwrap();
    drop(tx);
    handle.join().unwrap();

    let loaded = load_analyses(Path::new(path.as_path())).unwrap();
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].id, "roundtrip-1");
    assert_eq!(loaded[0].url, "https://example.com");
    assert_eq!(loaded[0].status, AnalysisStatus::Complete);
}

#[test]
fn delete_removes_analysis() {
    let file = tempfile::NamedTempFile::new().unwrap();
    let path = file.path().to_path_buf();
    let _ = load_analyses(&path).unwrap();

    let (tx, handle) = run_db_thread(&path).unwrap();
    tx.send(DbOp::Update(sample_analysis(
        "del-1",
        "https://a.com",
        AnalysisStatus::Pending,
    )))
    .unwrap();
    drop(tx);
    handle.join().unwrap();

    let loaded = load_analyses(Path::new(path.as_path())).unwrap();
    assert_eq!(loaded.len(), 1);

    let (tx2, handle2) = run_db_thread(&path).unwrap();
    tx2.send(DbOp::Delete("del-1".to_string())).unwrap();
    drop(tx2);
    handle2.join().unwrap();

    let after = load_analyses(Path::new(path.as_path())).unwrap();
    assert!(after.is_empty());
}
