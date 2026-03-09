use std::sync::mpsc;

use axum::body::Body;
use carabistouille::{build_router, AppState};
use http::{Request, Response, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt;

/// Build app state for tests: empty analyses, dummy DB channel (sends are no-op), local mode.
fn test_state() -> AppState {
    let (db_tx, _) = mpsc::channel();
    AppState::new(vec![], db_tx, false, false)
}

/// Build app state with agent marked connected (for create_analysis success path).
fn test_state_with_agent() -> AppState {
    let state = test_state();
    state.agent_connected.store(true, std::sync::atomic::Ordering::Relaxed);
    state
}

fn app() -> axum::Router {
    build_router(test_state())
}

async fn get_json(res: Response<Body>) -> serde_json::Value {
    let body = res.into_body();
    let bytes = body.collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn get_status_returns_ok_and_shape() {
    let app = app();
    let req = Request::builder()
        .uri("/api/status")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let json = get_json(res).await;
    assert!(json.get("agent_connected").is_some());
    assert!(json.get("analyses_count").is_some());
    assert_eq!(json["analyses_count"], 0);
}

#[tokio::test]
async fn create_analysis_fails_when_agent_disconnected() {
    let app = app();
    let body = serde_json::json!({ "url": "https://example.com" });
    let req = Request::builder()
        .method("POST")
        .uri("/api/analyses")
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn list_analyses_returns_empty_array() {
    let app = app();
    let req = Request::builder()
        .uri("/api/analyses")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let json = get_json(res).await;
    assert!(json.is_array());
    assert!(json.as_array().unwrap().is_empty());
}

#[tokio::test]
async fn get_analysis_returns_404_for_unknown_id() {
    let app = app();
    let req = Request::builder()
        .uri("/api/analyses/00000000-0000-0000-0000-000000000000")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn get_screenshots_returns_404_for_unknown_id() {
    let app = app();
    let req = Request::builder()
        .uri("/api/analyses/00000000-0000-0000-0000-000000000000/screenshots")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn stop_analysis_returns_404_for_unknown_id() {
    let app = app();
    let req = Request::builder()
        .method("POST")
        .uri("/api/analyses/00000000-0000-0000-0000-000000000000/stop")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn delete_analysis_returns_404_for_unknown_id() {
    let app = app();
    let req = Request::builder()
        .method("DELETE")
        .uri("/api/analyses/00000000-0000-0000-0000-000000000000")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn delete_analysis_returns_204_when_exists() {
    let state = test_state();
    state.analyses.insert(
        "test-id-123".to_string(),
        carabistouille::models::Analysis {
            id: "test-id-123".to_string(),
            url: "https://example.com".to_string(),
            status: carabistouille::models::AnalysisStatus::Complete,
            created_at: chrono::Utc::now(),
            completed_at: None,
            report: None,
            screenshot: None,
            screenshot_timeline: vec![],
            last_screenshot_forward_time_ms: None,
            notes: None,
            tags: vec![],
            run_options: None,
        },
    );
    let app = build_router(state);
    let req = Request::builder()
        .method("DELETE")
        .uri("/api/analyses/test-id-123")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn update_analysis_returns_200_and_updates_notes_and_tags() {
    let state = test_state();
    state.analyses.insert(
        "patch-me".to_string(),
        carabistouille::models::Analysis {
            id: "patch-me".to_string(),
            url: "https://example.com".to_string(),
            status: carabistouille::models::AnalysisStatus::Complete,
            created_at: chrono::Utc::now(),
            completed_at: None,
            report: None,
            screenshot: None,
            screenshot_timeline: vec![],
            last_screenshot_forward_time_ms: None,
            notes: None,
            tags: vec![],
            run_options: None,
        },
    );
    let app = build_router(state);
    let body = serde_json::json!({ "notes": "my note", "tags": ["phishing", "reviewed"] });
    let req = Request::builder()
        .method("PATCH")
        .uri("/api/analyses/patch-me")
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let json = get_json(res).await;
    assert_eq!(json["notes"], "my note");
    assert_eq!(json["tags"].as_array().map(|a| a.len()), Some(2));
}

#[tokio::test]
async fn get_status_includes_run_mode_and_analyses_count() {
    let app = app();
    let req = Request::builder()
        .uri("/api/status")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let json = get_json(res).await;
    assert_eq!(json["run_mode"], "local");
    // chrome_mode is null or absent when not in docker mode
    assert!(json.get("chrome_mode").map_or(true, |v| v.is_null()));
    assert_eq!(json["analyses_count"], 0);
}

#[tokio::test]
async fn get_status_docker_mode_exposes_chrome_mode() {
    let (db_tx, _) = mpsc::channel();
    let state = AppState::new(vec![], db_tx, true, true);
    let app = build_router(state);
    let req = Request::builder()
        .uri("/api/status")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let json = get_json(res).await;
    assert_eq!(json["run_mode"], "docker");
    assert_eq!(json["chrome_mode"], "real");
}

#[tokio::test]
async fn create_analysis_returns_201_when_agent_connected() {
    let app = build_router(test_state_with_agent());
    let body = serde_json::json!({ "url": "https://example.com" });
    let req = Request::builder()
        .method("POST")
        .uri("/api/analyses")
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
    let json = get_json(res).await;
    assert!(json.get("id").and_then(|v| v.as_str()).unwrap().len() > 0);
    assert_eq!(json["url"], "https://example.com");
    assert_eq!(json["status"], "pending");
}

#[tokio::test]
async fn create_analysis_accepts_optional_proxy_and_user_agent() {
    let app = build_router(test_state_with_agent());
    let body = serde_json::json!({
        "url": "https://example.com",
        "proxy": "socks5://127.0.0.1:1080",
        "user_agent": "CustomAgent/1.0"
    });
    let req = Request::builder()
        .method("POST")
        .uri("/api/analyses")
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
}

#[tokio::test]
async fn create_analysis_stores_run_options_and_returns_them_on_get() {
    let state = test_state_with_agent();
    let app = build_router(state.clone());
    let body = serde_json::json!({
        "url": "https://example.com",
        "proxy": "socks5://127.0.0.1:1080",
        "viewport_width": 1920,
        "viewport_height": 1080,
        "network_throttling": "slow3g",
        "timezone_id": "Europe/Paris",
        "locale": "fr-FR"
    });
    let req = Request::builder()
        .method("POST")
        .uri("/api/analyses")
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
    let json = get_json(res).await;
    let id = json["id"].as_str().unwrap();

    let app2 = build_router(state);
    let get_req = Request::builder()
        .uri(format!("/api/analyses/{}", id))
        .body(Body::empty())
        .unwrap();
    let get_res = app2.oneshot(get_req).await.unwrap();
    assert_eq!(get_res.status(), StatusCode::OK);
    let analysis = get_json(get_res).await;
    let opts = &analysis["run_options"];
    assert!(opts.is_object());
    assert_eq!(opts["proxy"], "socks5://127.0.0.1:1080");
    assert_eq!(opts["viewport_width"], 1920);
    assert_eq!(opts["viewport_height"], 1080);
    assert_eq!(opts["network_throttling"], "slow3g");
    assert_eq!(opts["timezone_id"], "Europe/Paris");
    assert_eq!(opts["locale"], "fr-FR");
}

#[tokio::test]
async fn list_analyses_returns_newest_first() {
    let state = test_state();
    let now = chrono::Utc::now();
    let base = carabistouille::models::Analysis {
        id: String::new(),
        url: "https://example.com".to_string(),
        status: carabistouille::models::AnalysisStatus::Complete,
        created_at: now,
        completed_at: None,
        report: None,
        screenshot: None,
        screenshot_timeline: vec![],
        last_screenshot_forward_time_ms: None,
        notes: None,
        tags: vec![],
        run_options: None,
    };
    state.analyses.insert(
        "old".to_string(),
        carabistouille::models::Analysis {
            id: "old".to_string(),
            created_at: now - chrono::Duration::seconds(10),
            ..base.clone()
        },
    );
    state.analyses.insert(
        "new".to_string(),
        carabistouille::models::Analysis {
            id: "new".to_string(),
            created_at: now,
            ..base
        },
    );
    let app = build_router(state);
    let req = Request::builder()
        .uri("/api/analyses")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let json = get_json(res).await;
    let arr = json.as_array().unwrap();
    assert_eq!(arr.len(), 2);
    assert_eq!(arr[0]["id"], "new");
    assert_eq!(arr[1]["id"], "old");
}

#[tokio::test]
async fn get_analysis_returns_200_and_body_when_exists() {
    let state = test_state();
    state.analyses.insert(
        "get-me".to_string(),
        carabistouille::models::Analysis {
            id: "get-me".to_string(),
            url: "https://example.com".to_string(),
            status: carabistouille::models::AnalysisStatus::Running,
            created_at: chrono::Utc::now(),
            completed_at: None,
            report: None,
            screenshot: None,
            screenshot_timeline: vec![],
            last_screenshot_forward_time_ms: None,
            notes: None,
            tags: vec![],
            run_options: None,
        },
    );
    let app = build_router(state);
    let req = Request::builder()
        .uri("/api/analyses/get-me")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let json = get_json(res).await;
    assert_eq!(json["id"], "get-me");
    assert_eq!(json["url"], "https://example.com");
    assert_eq!(json["status"], "running");
}

#[tokio::test]
async fn stop_analysis_returns_202_when_pending() {
    let state = test_state();
    state.analyses.insert(
        "stop-me".to_string(),
        carabistouille::models::Analysis {
            id: "stop-me".to_string(),
            url: "https://example.com".to_string(),
            status: carabistouille::models::AnalysisStatus::Pending,
            created_at: chrono::Utc::now(),
            completed_at: None,
            report: None,
            screenshot: None,
            screenshot_timeline: vec![],
            last_screenshot_forward_time_ms: None,
            notes: None,
            tags: vec![],
            run_options: None,
        },
    );
    let app = build_router(state);
    let req = Request::builder()
        .method("POST")
        .uri("/api/analyses/stop-me/stop")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::ACCEPTED);
}

#[tokio::test]
async fn stop_analysis_returns_409_when_already_complete() {
    let state = test_state();
    state.analyses.insert(
        "done".to_string(),
        carabistouille::models::Analysis {
            id: "done".to_string(),
            url: "https://example.com".to_string(),
            status: carabistouille::models::AnalysisStatus::Complete,
            created_at: chrono::Utc::now(),
            completed_at: None,
            report: None,
            screenshot: None,
            screenshot_timeline: vec![],
            last_screenshot_forward_time_ms: None,
            notes: None,
            tags: vec![],
            run_options: None,
        },
    );
    let app = build_router(state);
    let req = Request::builder()
        .method("POST")
        .uri("/api/analyses/done/stop")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::CONFLICT);
}
