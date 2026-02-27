//! Protocol tests: AgentCommand and AgentEvent JSON roundtrip and type names.

use carabistouille::models::NetworkRequest;
use carabistouille::protocol::{AgentCommand, AgentEvent, ElementRect};

#[test]
fn agent_command_navigate_roundtrip() {
    let cmd = AgentCommand::Navigate {
        analysis_id: "id-1".to_string(),
        url: "https://example.com".to_string(),
        proxy: Some("socks5://127.0.0.1:1080".to_string()),
        user_agent: Some("Custom/1.0".to_string()),
    };
    assert_eq!(cmd.type_name(), "navigate");
    let json = serde_json::to_value(&cmd).unwrap();
    assert_eq!(json["type"], "navigate");
    assert_eq!(json["analysis_id"], "id-1");
    assert_eq!(json["url"], "https://example.com");
    let back: AgentCommand = serde_json::from_value(json).unwrap();
    match &back {
        AgentCommand::Navigate { analysis_id, url, proxy, user_agent } => {
            assert_eq!(analysis_id, "id-1");
            assert_eq!(url, "https://example.com");
            assert_eq!(proxy.as_deref(), Some("socks5://127.0.0.1:1080"));
            assert_eq!(user_agent.as_deref(), Some("Custom/1.0"));
        }
        _ => panic!("expected Navigate"),
    }
}

#[test]
fn agent_command_stop_analysis_roundtrip() {
    let cmd = AgentCommand::StopAnalysis {
        analysis_id: "id-2".to_string(),
    };
    assert_eq!(cmd.type_name(), "stop_analysis");
    let json = serde_json::to_value(&cmd).unwrap();
    assert_eq!(json["type"], "stop_analysis");
    let back: AgentCommand = serde_json::from_value(json).unwrap();
    match back {
        AgentCommand::StopAnalysis { analysis_id } => assert_eq!(analysis_id, "id-2"),
        _ => panic!("expected StopAnalysis"),
    }
}

#[test]
fn agent_command_click_roundtrip() {
    let cmd = AgentCommand::Click {
        analysis_id: "id-3".to_string(),
        x: 100.0,
        y: 200.0,
    };
    assert_eq!(cmd.type_name(), "click");
    let json = serde_json::to_value(&cmd).unwrap();
    let back: AgentCommand = serde_json::from_value(json).unwrap();
    match back {
        AgentCommand::Click { analysis_id, x, y } => {
            assert_eq!(analysis_id, "id-3");
            assert_eq!((x, y), (100.0, 200.0));
        }
        _ => panic!("expected Click"),
    }
}

#[test]
fn agent_event_agent_ready_roundtrip() {
    let evt = AgentEvent::AgentReady;
    assert_eq!(evt.type_name(), "agent_ready");
    let json = serde_json::to_value(&evt).unwrap();
    assert_eq!(json["type"], "agent_ready");
    let back: AgentEvent = serde_json::from_value(json).unwrap();
    matches!(back, AgentEvent::AgentReady);
}

#[test]
fn agent_event_redirect_detected_roundtrip() {
    let evt = AgentEvent::RedirectDetected {
        analysis_id: "id-4".to_string(),
        from: "http://a.com".to_string(),
        to: "https://a.com".to_string(),
        status: 301,
    };
    assert_eq!(evt.type_name(), "redirect");
    let json = serde_json::to_value(&evt).unwrap();
    let back: AgentEvent = serde_json::from_value(json).unwrap();
    match &back {
        AgentEvent::RedirectDetected { analysis_id, from, to, status } => {
            assert_eq!(analysis_id, "id-4");
            assert_eq!(from, "http://a.com");
            assert_eq!(to, "https://a.com");
            assert_eq!(*status, 301);
        }
        _ => panic!("expected RedirectDetected"),
    }
}

#[test]
fn agent_event_error_roundtrip() {
    let evt = AgentEvent::Error {
        analysis_id: "id-5".to_string(),
        message: "Something failed".to_string(),
    };
    assert_eq!(evt.type_name(), "error");
    let json = serde_json::to_value(&evt).unwrap();
    let back: AgentEvent = serde_json::from_value(json).unwrap();
    match &back {
        AgentEvent::Error { analysis_id, message } => {
            assert_eq!(analysis_id, "id-5");
            assert_eq!(message, "Something failed");
        }
        _ => panic!("expected Error"),
    }
}

#[test]
fn agent_event_element_info_roundtrip() {
    let evt = AgentEvent::ElementInfo {
        analysis_id: "id-6".to_string(),
        tag: "button".to_string(),
        id: Some("submit".to_string()),
        classes: vec!["btn".to_string()],
        attributes: [("type".to_string(), "submit".to_string())].into_iter().collect(),
        text: "Submit".to_string(),
        rect: ElementRect {
            x: 10.0,
            y: 20.0,
            width: 100.0,
            height: 30.0,
        },
    };
    let json = serde_json::to_value(&evt).unwrap();
    let back: AgentEvent = serde_json::from_value(json).unwrap();
    match &back {
        AgentEvent::ElementInfo { tag, id, text, rect, .. } => {
            assert_eq!(tag, "button");
            assert_eq!(id.as_deref(), Some("submit"));
            assert_eq!(text, "Submit");
            assert_eq!(rect.width, 100.0);
        }
        _ => panic!("expected ElementInfo"),
    }
}

#[test]
fn agent_event_network_request_captured_roundtrip() {
    let evt = AgentEvent::NetworkRequestCaptured {
        analysis_id: "id-7".to_string(),
        request: NetworkRequest {
            url: "https://example.com/".to_string(),
            method: "GET".to_string(),
            resource_type: Some("document".to_string()),
            is_navigation: true,
            status: Some(200),
            status_text: Some("OK".to_string()),
            content_type: Some("text/html".to_string()),
            size: Some(1024),
            response_size: None,
            remote_ip: None,
            remote_port: None,
            is_third_party: false,
            from_cache: false,
            from_service_worker: false,
            timestamp: 12345.67,
            request_headers: None,
            request_body: None,
            response_headers: None,
            timing: None,
            security_details: None,
            initiator: None,
            failure: None,
        },
    };
    let json = serde_json::to_value(&evt).unwrap();
    let back: AgentEvent = serde_json::from_value(json).unwrap();
    match &back {
        AgentEvent::NetworkRequestCaptured { analysis_id, request } => {
            assert_eq!(analysis_id, "id-7");
            assert_eq!(request.url, "https://example.com/");
            assert_eq!(request.method, "GET");
            assert_eq!(request.status, Some(200));
        }
        _ => panic!("expected NetworkRequestCaptured"),
    }
}
