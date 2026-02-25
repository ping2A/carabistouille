use axum::body::Body;
use carabistouille::{build_router, AppState};
use http::{Request, Response, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt;

fn app() -> axum::Router {
    build_router(AppState::new())
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
    use std::sync::atomic::Ordering;

    let state = AppState::new();
    state.agent_connected.store(true, Ordering::Relaxed);
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
