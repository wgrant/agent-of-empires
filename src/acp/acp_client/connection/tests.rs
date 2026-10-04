//! Connection behavior under a scripted fake agent: Cancel must not sit behind
//! a sustained update stream, and a pending approval must not hold back other
//! messages.

use super::prompt::{SelectProbe, SELECT_PROBE};
use super::*;
use crate::acp::fs_handler::FsPolicy;
use crate::acp::terminal_handler::TerminalManager;
use agent_client_protocol::schema::v1::{ContentBlock, TextContent};
use std::collections::HashMap;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

type SharedWrite = Arc<Mutex<tokio::io::DuplexStream>>;

#[tokio::test]
async fn settings_rejected_during_a_turn_retry_once_before_the_next_prompt() {
    for kind in ["model", "effort", "mode", "config-mode"] {
        for scenario in [
            "accepted",
            "rejected",
            "superseded",
            "retry-fails",
            "idle-responsive",
            "cancel-waiting-prompt",
        ] {
            settings_between_turns(kind, scenario).await;
        }
    }
    settings_between_turns("model", "batch").await;
    settings_between_turns("mode", "reset-success").await;
    settings_between_turns("mode", "reset-fails").await;
}

#[tokio::test]
#[serial_test::serial]
async fn startup_reconciles_preferences_saved_after_the_launch_snapshot() {
    let _app = crate::session::test_support::isolate_app_dir();
    settings_between_turns("model", "startup").await;
    settings_between_turns("model", "startup-revert").await;
    settings_between_turns("model", "startup-notification").await;
}

async fn settings_between_turns(kind: &str, scenario: &str) {
    let (daemon_write, agent_read) = tokio::io::duplex(65536);
    let (agent_write, daemon_read) = tokio::io::duplex(65536);
    let agent_write: SharedWrite = Arc::new(Mutex::new(agent_write));
    let (transport, (mut params, mut events, commands, ready, _temp)) =
        connection_params("settings-retry", daemon_write, daemon_read);
    let mut saved_instance = None;
    if scenario.starts_with("startup") {
        let mut instance = crate::session::Instance::new("settings", "/tmp");
        instance.agent_model = Some("high".into());
        params.resources.label = instance.id.clone();
        params.source_profile = Some("default".into());
        params.default_model = Some("default".into());
        saved_instance = Some(instance.id.clone());
        crate::session::Storage::new_unwatched("default")
            .unwrap()
            .update(|instances, _| {
                instances.push(instance);
                Ok(())
            })
            .unwrap();
    }
    let connection = tokio::spawn(run_connection_task(transport, params));
    let (requests_tx, mut requests) = mpsc::channel(16);
    let writer = agent_write.clone();
    let mode_as_config = kind == "config-mode";
    let reset_succeeds = scenario == "reset-success";
    let agent = tokio::spawn(async move {
        let mut session_count = 0;
        let mut lines = BufReader::new(agent_read).lines();
        while let Some(line) = lines.next_line().await.unwrap() {
            let request: serde_json::Value = serde_json::from_str(&line).unwrap();
            let result = match request["method"].as_str() {
                Some("initialize") => Some(serde_json::json!({
                    "protocolVersion": 1, "agentCapabilities": {}
                })),
                Some("session/new") => {
                    session_count += 1;
                    let mut result = serde_json::json!({
                    "sessionId": "settings-session",
                    "modes": {
                        "currentModeId": "default",
                        "availableModes": [
                            {"id": "default", "name": "Default"},
                            {"id": "plan", "name": "Plan"}
                        ]
                    }
                    });
                    if reset_succeeds && session_count > 1 {
                        result["sessionId"] = "settings-reset".into();
                    }
                    if mode_as_config {
                        result["configOptions"] = serde_json::json!([{
                            "id": "mode", "name": "Mode", "category": "mode",
                            "type": "select", "currentValue": "default",
                            "options": [
                                {"value": "default", "name": "Default"},
                                {"value": "plan", "name": "Plan"}
                            ]
                        }]);
                    } else {
                        result["configOptions"] = serde_json::json!([
                            {"id":"model", "name":"Model", "category":"model", "type":"select", "currentValue":"default", "options":[{"value":"default","name":"Default"},{"value":"high","name":"High"}]},
                            {"id":"effort", "name":"Effort", "category":"thought_level", "type":"select", "currentValue":"default", "options":[{"value":"default","name":"Default"},{"value":"high","name":"High"}]}
                        ]);
                    }
                    Some(result)
                }
                _ => None,
            };
            if let Some(result) = result {
                settings_reply(&writer, &request, result).await;
            } else if request.get("id").is_some() {
                requests_tx.send(request).await.unwrap();
            }
        }
    });
    tokio::time::timeout(Duration::from_secs(10), ready)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let prompt = || ClientCmd::Prompt(vec![ContentBlock::Text(TextContent::new("test"))]);
    let setting = |value: &str| {
        if kind.ends_with("mode") {
            ClientCmd::SetMode(value.to_string())
        } else {
            ClientCmd::SetConfigOption {
                config_id: kind.to_string(),
                value: value.to_string(),
            }
        }
    };
    let value = if kind.ends_with("mode") {
        "plan"
    } else {
        "high"
    };
    let method = if kind == "mode" {
        "session/set_mode"
    } else {
        "session/set_config_option"
    };
    if scenario.starts_with("reset-") {
        commands.send(setting(value)).await.unwrap();
        let old = settings_request(&mut requests).await;
        let (sent, received) = oneshot::channel();
        commands
            .send(ClientCmd::ResetSession {
                text: "/clear".into(),
                deadline: tokio::time::Instant::now() + Duration::from_secs(10),
                respond_to: sent,
            })
            .await
            .unwrap();
        let outcome = tokio::time::timeout(Duration::from_secs(10), received)
            .await
            .unwrap()
            .unwrap();
        if scenario == "reset-success" {
            assert!(matches!(
                outcome,
                crate::acp::acp_client::reset::ResetSessionOutcome::Reset { .. }
            ));
            let fresh = settings_request(&mut requests).await;
            assert_eq!(fresh["method"], "session/set_mode");
            assert_eq!(fresh["params"]["sessionId"], "settings-reset");
            assert_eq!(fresh["params"]["modeId"], "plan");
            settings_success(&agent_write, &old, kind, "default").await;
            settings_success(&agent_write, &fresh, kind, value).await;
        } else {
            assert!(matches!(
                outcome,
                crate::acp::acp_client::reset::ResetSessionOutcome::Failed { .. }
            ));
            settings_success(&agent_write, &old, kind, value).await;
        }
        commands.send(prompt()).await.unwrap();
        let next = settings_request(&mut requests).await;
        assert_eq!(next["method"], "session/prompt");
        assert_eq!(
            next["params"]["sessionId"],
            if reset_succeeds {
                "settings-reset"
            } else {
                "settings-session"
            }
        );
        settings_reply(
            &agent_write,
            &next,
            serde_json::json!({ "stopReason": "end_turn" }),
        )
        .await;
        commands.send(ClientCmd::Shutdown).await.unwrap();
        tokio::time::timeout(Duration::from_secs(10), connection)
            .await
            .unwrap()
            .unwrap();
        while let Ok(Some(event)) =
            tokio::time::timeout(Duration::from_millis(50), events.recv()).await
        {
            assert!(
                !matches!(event, Event::CurrentModeChanged { current_mode_id } if current_mode_id == "default"),
                "old-session settings response must not be published"
            );
        }
        agent.abort();
        return;
    }
    if scenario.starts_with("startup") {
        let selection = settings_request(&mut requests).await;
        assert_eq!(selection["params"]["value"], "high");
        if scenario == "startup-revert" {
            crate::session::Storage::new_unwatched("default")
                .unwrap()
                .update(|instances, _| {
                    let instance = instances
                        .iter_mut()
                        .find(|instance| Some(&instance.id) == saved_instance.as_ref())
                        .unwrap();
                    instance.agent_model = Some("default".into());
                    instance.acp_effort = Some("default".into());
                    Ok(())
                })
                .unwrap();
            commands.send(ClientCmd::ReconcileSettings).await.unwrap();
            let (sent, received) = oneshot::channel();
            commands.send(ClientCmd::FlushForTest(sent)).await.unwrap();
            received.await.unwrap();
            settings_snapshot(&agent_write, &selection, "high", "high").await;
            let revert = settings_request(&mut requests).await;
            assert_eq!(revert["params"]["configId"], "model");
            assert_eq!(revert["params"]["value"], "default");
            settings_snapshot(&agent_write, &revert, "default", "high").await;
            let effort = settings_request(&mut requests).await;
            assert_eq!(effort["params"]["configId"], "effort");
            assert_eq!(effort["params"]["value"], "default");
            settings_snapshot(&agent_write, &effort, "default", "default").await;
        } else {
            settings_success(&agent_write, &selection, kind, "high").await;
        }
        if scenario == "startup-notification" {
            tokio::time::timeout(Duration::from_secs(1), async {
                while !matches!(events.recv().await.expect("connection open"), Event::SettingApplicationChanged { application, .. } if application.status == crate::acp::state::SettingApplicationStatus::Applied) {}
            }).await.unwrap();
            write_line(&agent_write, &serde_json::json!({
                "jsonrpc": "2.0", "method": "session/update", "params": {
                    "sessionId": "settings-session", "update": {
                        "sessionUpdate": "config_option_update", "configOptions": [{
                            "id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": "default", "options": [],
                        }],
                    },
                },
            }).to_string()).await;
            tokio::time::timeout(Duration::from_secs(1), async {
                while !matches!(events.recv().await.expect("connection open"), Event::ConfigOptionsUpdated { options } if options.iter().any(|option| option.id == "model" && option.current_value == "default")) {}
            }).await.unwrap();
            commands.send(ClientCmd::ReconcileSettings).await.unwrap();
            let correction = settings_request(&mut requests).await;
            assert_eq!(correction["params"]["value"], "high");
            settings_success(&agent_write, &correction, kind, "high").await;
        }
        commands.send(prompt()).await.unwrap();
        let request = settings_request(&mut requests).await;
        assert_eq!(request["method"], "session/prompt");
        settings_reply(
            &agent_write,
            &request,
            serde_json::json!({"stopReason":"end_turn"}),
        )
        .await;
        settings_stopped(&mut events).await;
        commands.send(ClientCmd::Shutdown).await.unwrap();
        tokio::time::timeout(Duration::from_secs(10), connection)
            .await
            .unwrap()
            .unwrap();
        agent.abort();
        return;
    }
    if scenario == "idle-responsive" || scenario == "cancel-waiting-prompt" {
        commands.send(setting(value)).await.unwrap();
        let selection = settings_request(&mut requests).await;
        assert_eq!(selection["method"], method);
        if scenario == "cancel-waiting-prompt" {
            commands.send(prompt()).await.unwrap();
        }
        let (flushed, flush) = oneshot::channel();
        commands
            .send(ClientCmd::FlushForTest(flushed))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), flush)
            .await
            .unwrap()
            .unwrap();
        commands.send(ClientCmd::Cancel).await.unwrap();
        settings_stopped(&mut events).await;
        if scenario == "cancel-waiting-prompt" {
            settings_success(&agent_write, &selection, kind, value).await;
            tokio::time::timeout(Duration::from_secs(1), async {
                while !matches!(events.recv().await, Some(Event::SettingApplicationChanged { application, .. }) if application.status == crate::acp::state::SettingApplicationStatus::Applied) {}
            }).await.unwrap();
            assert!(
                tokio::time::timeout(Duration::from_millis(50), requests.recv())
                    .await
                    .is_err(),
                "stopped prompt must not run after settings settle"
            );
        }
        commands.send(ClientCmd::Shutdown).await.unwrap();
        tokio::time::timeout(Duration::from_secs(1), connection)
            .await
            .unwrap()
            .unwrap();
        agent.abort();
        return;
    }
    commands.send(prompt()).await.unwrap();
    let first_prompt = settings_request(&mut requests).await;
    assert_eq!(first_prompt["method"], "session/prompt");
    if scenario == "batch" {
        commands
            .send(ClientCmd::ApplySettings {
                options: vec![
                    ("effort".into(), "high".into()),
                    ("model".into(), "high".into()),
                ],
                mode: None,
            })
            .await
            .unwrap();
        for (expected, model, effort) in [("model", "high", "default"), ("effort", "high", "high")]
        {
            let request = settings_request(&mut requests).await;
            assert_eq!(request["params"]["configId"], expected);
            settings_snapshot(&agent_write, &request, model, effort).await;
        }
        commands.send(setting("default")).await.unwrap();
        let request = settings_request(&mut requests).await;
        assert_eq!(request["params"]["configId"], "model");
        settings_snapshot(&agent_write, &request, "default", "default").await;
        let request = settings_request(&mut requests).await;
        assert_eq!(request["params"]["configId"], "effort");
        assert_eq!(request["params"]["value"], "high");
        settings_snapshot(&agent_write, &request, "default", "high").await;
        settings_reply(
            &agent_write,
            &first_prompt,
            serde_json::json!({"stopReason":"end_turn"}),
        )
        .await;
        settings_stopped(&mut events).await;
        commands.send(ClientCmd::Shutdown).await.unwrap();
        tokio::time::timeout(Duration::from_secs(10), connection)
            .await
            .unwrap()
            .unwrap();
        agent.abort();
        return;
    }
    let old_selection = if scenario == "superseded" {
        let old_change = if mode_as_config {
            ClientCmd::SetConfigOption {
                config_id: "mode".into(),
                value: "default".into(),
            }
        } else {
            setting("default")
        };
        commands.send(old_change).await.unwrap();
        let old = settings_request(&mut requests).await;
        assert_eq!(old["method"], method);
        Some(old)
    } else {
        None
    };
    commands.send(setting(value)).await.unwrap();
    if let Some(old) = &old_selection {
        let (flushed, flush) = oneshot::channel();
        commands
            .send(ClientCmd::FlushForTest(flushed))
            .await
            .unwrap();
        flush.await.unwrap();
        settings_success(&agent_write, old, kind, "default").await;
    }
    let selection = settings_request(&mut requests).await;
    assert_eq!(selection["method"], method);
    if scenario == "accepted" {
        settings_success(&agent_write, &selection, kind, value).await;
    }
    settings_reply(
        &agent_write,
        &first_prompt,
        serde_json::json!({"stopReason": "end_turn"}),
    )
    .await;
    settings_stopped(&mut events).await;
    commands.send(prompt()).await.unwrap();
    if scenario != "accepted" {
        // The failure may arrive after the prompt finishes. It still belongs
        // to a mid-turn attempt and must be retried before the next prompt.
        settings_reject(&agent_write, &selection).await;
        let retry = settings_request(&mut requests).await;
        assert_eq!(retry["method"], method, "{kind}: {scenario}");
        let wire_value = if kind == "mode" { "modeId" } else { "value" };
        assert_eq!(retry["params"][wire_value], value);
        // The retry is on the wire but deliberately unanswered. Observe
        // that the next prompt stays blocked until its acknowledgement.
        assert!(
            tokio::time::timeout(Duration::from_millis(50), requests.recv())
                .await
                .is_err(),
            "next prompt must wait for the setting response"
        );
        if scenario == "retry-fails" {
            settings_reject(&agent_write, &retry).await;
        } else {
            settings_success(&agent_write, &retry, kind, value).await;
        }
    }
    let second_prompt = settings_request(&mut requests).await;
    assert_eq!(
        second_prompt["method"], "session/prompt",
        "{kind}: {scenario}"
    );
    settings_reply(
        &agent_write,
        &second_prompt,
        serde_json::json!({"stopReason": "end_turn"}),
    )
    .await;
    settings_stopped(&mut events).await;
    commands.send(prompt()).await.unwrap();
    let third_prompt = settings_request(&mut requests).await;
    assert_eq!(
        third_prompt["method"], "session/prompt",
        "no repeated retries"
    );
    settings_reply(
        &agent_write,
        &third_prompt,
        serde_json::json!({"stopReason": "end_turn"}),
    )
    .await;
    settings_stopped(&mut events).await;
    commands.send(ClientCmd::Shutdown).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), connection)
        .await
        .unwrap()
        .unwrap();
    agent.abort();
}

async fn settings_stopped(events: &mut mpsc::Receiver<Event>) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(event) = events.recv().await {
            match event {
                Event::Stopped { .. } => return,
                Event::ConfigOptionSwitchFailed { value, .. } => assert_ne!(value, "default"),
                Event::ModeSwitchFailed { mode_id, .. } => assert_ne!(mode_id, "default"),
                _ => {}
            }
        }
        panic!("connection closed before turn finished");
    })
    .await
    .expect("turn finishes");
}

async fn settings_snapshot(
    writer: &SharedWrite,
    request: &serde_json::Value,
    model: &str,
    effort: &str,
) {
    settings_reply(writer, request, serde_json::json!({"configOptions":[
        {"id":"model", "name":"Model", "category":"model", "type":"select", "currentValue":model, "options":[]},
        {"id":"effort", "name":"Effort", "category":"thought_level", "type":"select", "currentValue":effort, "options":[]}
    ]})).await;
}

async fn settings_request(requests: &mut mpsc::Receiver<serde_json::Value>) -> serde_json::Value {
    tokio::time::timeout(Duration::from_secs(10), requests.recv())
        .await
        .expect("adapter receives next request")
        .expect("connection remains open")
}

async fn settings_reply(
    writer: &SharedWrite,
    request: &serde_json::Value,
    result: serde_json::Value,
) {
    write_line(
        writer,
        &serde_json::json!({"jsonrpc": "2.0", "id": request["id"], "result": result}).to_string(),
    )
    .await;
}

async fn settings_reject(writer: &SharedWrite, request: &serde_json::Value) {
    write_line(
        writer,
        &serde_json::json!({
            "jsonrpc": "2.0", "id": request["id"],
            "error": {"code": -32603, "message": "Agent is busy"}
        })
        .to_string(),
    )
    .await;
}

async fn settings_success(
    writer: &SharedWrite,
    request: &serde_json::Value,
    kind: &str,
    value: &str,
) {
    let result = if kind == "mode" {
        serde_json::json!({})
    } else {
        serde_json::json!({"configOptions": [{
            "id": if kind == "config-mode" { "mode" } else { kind },
            "category": if kind == "config-mode" { "mode" } else if kind == "effort" { "thought_level" } else { "model" },
            "name": kind, "type": "select", "currentValue": value,
            "options": [{"value": value, "name": value}]
        }]})
    };
    settings_reply(writer, request, result).await;
}

async fn write_line(w: &SharedWrite, line: &str) {
    let mut guard = w.lock().await;
    guard.write_all(line.as_bytes()).await.unwrap();
    guard.write_all(b"\n").await.unwrap();
    guard.flush().await.unwrap();
}

type Harness = (
    ConnectionParams,
    mpsc::Receiver<Event>,
    mpsc::Sender<ClientCmd>,
    oneshot::Receiver<Result<(), AcpError>>,
    tempfile::TempDir,
);

fn connection_params(
    label: &str,
    daemon_write: tokio::io::DuplexStream,
    daemon_read: tokio::io::DuplexStream,
) -> (
    ByteStreams<impl futures_util::AsyncWrite, impl futures_util::AsyncRead>,
    Harness,
) {
    let (event_tx, event_rx) = mpsc::channel(64);
    let (cmd_tx, cmd_rx) = mpsc::channel::<ClientCmd>(16);
    let (ready_tx, ready_rx) = oneshot::channel::<Result<(), AcpError>>();
    let temp = tempfile::tempdir().unwrap();
    let cwd = temp.path().to_path_buf();
    let transport = ByteStreams::new(daemon_write.compat_write(), daemon_read.compat());
    let resources = SessionResources {
        fs_policy: Arc::new(FsPolicy::new(vec![cwd.clone()])),
        terminals: TerminalManager::new(),
        cwd,
        label: label.to_string(),
        sandbox: None,
    };
    let params = ConnectionParams {
        event_tx,
        cmd_rx,
        child: None,
        pending_responders: Arc::new(Mutex::new(HashMap::new())),
        resources,
        mode: ConnectMode::Fresh {
            stored_acp_session_id: None,
            seed_history_replay: false,
            fork_from: None,
        },
        ready_tx,
        profile: &crate::acp::agent_profiles::GEMINI,
        expected_agent: ExpectedAgent::Gemini,
        source_profile: None,
        default_effort: None,
        default_mode: None,
        default_model: None,
        extensions: Default::default(),
        mcp_servers: Vec::new(),
        runner: None,
    };
    (transport, (params, event_rx, cmd_tx, ready_rx, temp))
}

#[tokio::test]
async fn cancel_reaches_the_agent_while_notifications_remain_queued() {
    // Repeated contested polls make unbiased selection observable; this is
    // probabilistic mutation coverage, not a guarantee about Tokio's RNG.
    for _ in 0..32 {
        tokio::join!(cancel_under_flood(), cancel_under_flood());
    }
}

/// Fake agent: handshake, then flood updates while the turn runs; end the
/// turn only on `session/cancel`.
async fn fake_agent(
    agent_read: tokio::io::DuplexStream,
    agent_write: SharedWrite,
    flooded: Arc<AtomicBool>,
    cancelled: Arc<AtomicBool>,
) {
    let mut reader = BufReader::new(agent_read);
    let mut line = String::new();
    let mut prompt_id: Option<serde_json::Value> = None;
    loop {
        line.clear();
        if reader.read_line(&mut line).await.unwrap_or(0) == 0 {
            break;
        }
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
            continue;
        };
        let id = &msg["id"];
        let reply = match msg.get("method").and_then(|m| m.as_str()) {
            Some("initialize") => Some(format!(
                r#"{{"jsonrpc":"2.0","id":{id},"result":{{"protocolVersion":1,"agentCapabilities":{{}}}}}}"#
            )),
            Some("session/new") => Some(format!(
                r#"{{"jsonrpc":"2.0","id":{id},"result":{{"sessionId":"s-fair"}}}}"#
            )),
            Some("session/prompt") => {
                prompt_id = Some(id.clone());
                flooded.store(true, Ordering::SeqCst);
                None
            }
            Some("session/cancel") => {
                cancelled.store(true, Ordering::SeqCst);
                prompt_id.take().map(|id| {
                    format!(
                        r#"{{"jsonrpc":"2.0","id":{id},"result":{{"stopReason":"cancelled"}}}}"#
                    )
                })
            }
            _ => None,
        };
        if let Some(reply) = reply {
            write_line(&agent_write, &reply).await;
        }
    }
}

async fn cancel_under_flood() {
    let (daemon_write, agent_read) = tokio::io::duplex(1024 * 1024);
    let (agent_write, daemon_read) = tokio::io::duplex(1024 * 1024);
    let agent_write: SharedWrite = Arc::new(Mutex::new(agent_write));
    let cancelled = Arc::new(AtomicBool::new(false));
    let flooded = Arc::new(AtomicBool::new(false));

    let (transport, (params, mut event_rx, cmd_tx, ready_rx, _temp)) =
        connection_params("s-fair", daemon_write, daemon_read);
    let (paused_tx, mut paused_rx) = oneshot::channel();
    let (resume_tx, resume_rx) = oneshot::channel();
    let (winner_tx, winner_rx) = oneshot::channel();
    let probe = std::cell::RefCell::new(SelectProbe {
        gate: Some((paused_tx, resume_rx)),
        armed: false,
        winner: Some(winner_tx),
    });
    let connection =
        tokio::spawn(SELECT_PROBE.scope(probe, run_connection_task(transport, params)));
    let agent = tokio::spawn(fake_agent(
        agent_read,
        agent_write.clone(),
        flooded.clone(),
        cancelled.clone(),
    ));
    // The flood runs beside the reader so the agent keeps reading cancel.
    let flood_stop = cancelled.clone();
    let flood = tokio::spawn(async move {
        while !flooded.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        let update = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s-fair","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"flood"}}}}"#;
        while !flood_stop.load(Ordering::SeqCst) {
            write_line(&agent_write, update).await;
        }
    });

    ready_rx
        .await
        .expect("handshake completes")
        .expect("handshake ok");
    cmd_tx
        .send(ClientCmd::Prompt(vec![ContentBlock::Text(
            TextContent::new("hi"),
        )]))
        .await
        .unwrap();

    // Pause with a notification queued, then enqueue Cancel before the next
    // select can poll either receiver.
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            tokio::select! {
                ready = &mut paused_rx => { ready.unwrap(); break; }
                event = event_rx.recv() => { event.expect("connection remains open"); }
            }
        }
    })
    .await
    .expect("connection reaches the selection barrier");
    cmd_tx.send(ClientCmd::Cancel).await.unwrap();
    resume_tx.send(()).unwrap();

    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let stopped = loop {
        let event = tokio::time::timeout_at(deadline, event_rx.recv())
            .await
            .expect("cancel must be processed under sustained notifications")
            .expect("event channel open");
        if let Event::Stopped { .. } = event {
            break event;
        }
    };
    assert!(
        cancelled.load(Ordering::SeqCst),
        "session/cancel must reach the agent while notifications are queued: {stopped:?}"
    );
    assert!(
        winner_rx.await.unwrap(),
        "Cancel must beat the queued lifecycle notification"
    );

    flood.abort();
    agent.abort();
    connection.abort();
    let _ = tokio::join!(flood, agent, connection);
}

/// Handler tasks share one dispatch loop, so a request awaited there, such as
/// an approval or a terminal's command, held back every later message.
#[tokio::test]
async fn messages_keep_flowing_while_a_request_waits() {
    let cases = [
        r#"{"jsonrpc":"2.0","id":"perm","method":"session/request_permission","params":{"sessionId":"s-wait","toolCall":{"toolCallId":"t1","title":"rm -rf build"},"options":[{"optionId":"allow","name":"Allow","kind":"allow_once"}]}}"#,
        r#"{"jsonrpc":"2.0","id":"term","method":"terminal/create","params":{"sessionId":"s-wait","command":"sleep","args":["3600"]}}"#,
    ];
    for request in cases {
        update_follows(request).await;
    }
}

async fn update_follows(request: &'static str) {
    let (daemon_write, agent_read) = tokio::io::duplex(64 * 1024);
    let (agent_write, daemon_read) = tokio::io::duplex(64 * 1024);
    let agent_write: SharedWrite = Arc::new(Mutex::new(agent_write));
    let (transport, (params, mut event_rx, cmd_tx, ready_rx, _temp)) =
        connection_params("s-wait", daemon_write, daemon_read);
    let connection = tokio::spawn(run_connection_task(transport, params));
    let agent = tokio::spawn(async move {
        let mut reader = BufReader::new(agent_read);
        let mut line = String::new();
        while reader.read_line(&mut line).await.unwrap_or(0) > 0 {
            let msg: serde_json::Value = serde_json::from_str(line.trim()).unwrap_or_default();
            line.clear();
            let id = &msg["id"];
            let replies = match msg["method"].as_str() {
                Some("initialize") => vec![format!(
                    r#"{{"jsonrpc":"2.0","id":{id},"result":{{"protocolVersion":1,"agentCapabilities":{{}}}}}}"#
                )],
                Some("session/new") => vec![format!(
                    r#"{{"jsonrpc":"2.0","id":{id},"result":{{"sessionId":"s-wait"}}}}"#
                )],
                Some("session/prompt") => vec![
                    request.to_string(),
                    r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s-wait","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"meanwhile"}}}}"#.to_string(),
                ],
                _ => Vec::new(),
            };
            for reply in replies {
                write_line(&agent_write, &reply).await;
            }
        }
    });

    ready_rx
        .await
        .expect("handshake completes")
        .expect("handshake ok");
    cmd_tx
        .send(ClientCmd::Prompt(vec![ContentBlock::Text(
            TextContent::new("go"),
        )]))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            if let Event::AgentMessageChunk { text } =
                event_rx.recv().await.expect("event channel open")
            {
                if text == "meanwhile" {
                    break;
                }
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("an update after {request} arrives while it waits"));

    agent.abort();
    connection.abort();
    let _ = tokio::join!(agent, connection);
}

/// An agent lost after its session was assigned had started, so its loss is
/// an exit; lost during the handshake, it failed to start.
#[tokio::test]
async fn losing_the_agent_after_its_session_is_an_exit_not_a_startup_failure() {
    for answer_session in [true, false] {
        let (daemon_write, agent_read) = tokio::io::duplex(64 * 1024);
        let (agent_write, daemon_read) = tokio::io::duplex(64 * 1024);
        let (transport, (params, mut event_rx, _cmd_tx, ready_rx, _temp)) =
            connection_params("s-exit", daemon_write, daemon_read);
        let connection = tokio::spawn(run_connection_task(transport, params));
        // Answers the handshake, then drops both pipes as a dying process would.
        let agent = tokio::spawn(async move {
            let agent_write: SharedWrite = Arc::new(Mutex::new(agent_write));
            let mut reader = BufReader::new(agent_read);
            let mut line = String::new();
            while reader.read_line(&mut line).await.unwrap_or(0) > 0 {
                let msg: serde_json::Value = serde_json::from_str(line.trim()).unwrap_or_default();
                let id = &msg["id"];
                match msg["method"].as_str() {
                    Some("initialize") => {
                        let reply = format!(
                            r#"{{"jsonrpc":"2.0","id":{id},"result":{{"protocolVersion":1,"agentCapabilities":{{}}}}}}"#
                        );
                        write_line(&agent_write, &reply).await;
                    }
                    Some("session/new") => {
                        if answer_session {
                            let reply = format!(
                                r#"{{"jsonrpc":"2.0","id":{id},"result":{{"sessionId":"s-exit"}}}}"#
                            );
                            write_line(&agent_write, &reply).await;
                        }
                        break;
                    }
                    _ => {}
                }
                line.clear();
            }
        });
        agent.await.unwrap();
        let ready = tokio::time::timeout(Duration::from_secs(10), ready_rx)
            .await
            .expect("the spawn settles")
            .unwrap();
        let mut events = Vec::new();
        while let Some(event) = tokio::time::timeout(Duration::from_secs(10), event_rx.recv())
            .await
            .expect("the connection ends")
        {
            events.push(event);
        }
        connection.await.unwrap();
        let exited = events
            .iter()
            .any(|e| matches!(e, Event::Stopped { reason } if reason == AGENT_EXITED_REASON));
        let startup_error = events
            .iter()
            .any(|e| matches!(e, Event::AgentStartupError { .. }));
        assert!(ready.is_ok());
        assert_eq!(
            (exited, startup_error),
            (answer_session, !answer_session),
            "answer_session={answer_session}: {events:?}"
        );
    }
}

/// A new adapter process clears the previous process's identity before it can
/// report its own; a reattach to the surviving process keeps it.
#[tokio::test]
async fn auth_status_is_cleared_per_adapter_process() {
    let fresh = || ConnectMode::Fresh {
        stored_acp_session_id: None,
        seed_history_replay: false,
        fork_from: None,
    };
    let reattach = ConnectMode::Resume {
        acp_session_id: "s-auth".into(),
        in_flight_turn: false,
        subagents: Vec::new(),
        workflows: Vec::new(),
    };
    let cases = [
        ("silent replacement", fresh(), false, vec![false]),
        (
            "replacement that reports early",
            fresh(),
            true,
            vec![false, true],
        ),
        ("reattach to the surviving process", reattach, false, vec![]),
    ];
    for (name, mode, reports, want) in cases {
        assert_eq!(auth_events(mode, reports).await, want, "{name}");
    }
}

/// `AuthStatusUpdated` events up to session commit, as "carries a report".
async fn auth_events(mode: ConnectMode, reports: bool) -> Vec<bool> {
    let (daemon_write, agent_read) = tokio::io::duplex(64 * 1024);
    let (mut agent_write, daemon_read) = tokio::io::duplex(64 * 1024);
    let (event_tx, mut event_rx) = mpsc::channel(64);
    let (_cmd_tx, cmd_rx) = mpsc::channel::<ClientCmd>(1);
    let (ready_tx, _ready_rx) = oneshot::channel();
    let temp = tempfile::tempdir().unwrap();
    let cwd = temp.path().to_path_buf();
    let params = ConnectionParams {
        event_tx,
        cmd_rx,
        child: None,
        pending_responders: Arc::new(Mutex::new(HashMap::new())),
        resources: SessionResources {
            fs_policy: Arc::new(FsPolicy::new(vec![cwd.clone()])),
            terminals: TerminalManager::new(),
            cwd,
            label: "s-auth".to_string(),
            sandbox: None,
        },
        mode,
        ready_tx,
        profile: &crate::acp::agent_profiles::GEMINI,
        expected_agent: ExpectedAgent::Gemini,
        source_profile: None,
        default_effort: None,
        default_mode: None,
        default_model: None,
        extensions: Default::default(),
        mcp_servers: Vec::new(),
        runner: None,
    };
    let transport = ByteStreams::new(daemon_write.compat_write(), daemon_read.compat());
    let connection = tokio::spawn(run_connection_task(transport, params));
    // Reports right after answering `initialize`, the earliest it can.
    let agent = tokio::spawn(async move {
        let mut lines = BufReader::new(agent_read).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let msg: serde_json::Value = serde_json::from_str(&line).unwrap();
            let id = &msg["id"];
            let mut out = match msg["method"].as_str() {
                Some("initialize") => vec![format!(
                    r#"{{"jsonrpc":"2.0","id":{id},"result":{{"protocolVersion":1,"agentCapabilities":{{"_meta":{{"authStatus":{{}}}}}}}}}}"#
                )],
                Some("session/new") => vec![format!(
                    r#"{{"jsonrpc":"2.0","id":{id},"result":{{"sessionId":"s-auth"}}}}"#
                )],
                _ => vec![],
            };
            if reports && msg["method"] == "initialize" {
                out.push(r#"{"jsonrpc":"2.0","method":"_auth/status_update","params":{"authStatus":{"kind":"account","label":"Claude Max"}}}"#.into());
            }
            for line in out {
                agent_write
                    .write_all(format!("{line}\n").as_bytes())
                    .await
                    .unwrap();
            }
        }
    });

    let (mut seen, mut committed) = (Vec::new(), false);
    tokio::time::timeout(Duration::from_secs(10), async {
        while !committed || (reports && seen.last() != Some(&true)) {
            match event_rx.recv().await.expect("connection remains open") {
                Event::AuthStatusUpdated { status } => seen.push(status.is_some()),
                Event::AcpSessionAssigned { .. } => committed = true,
                _ => {}
            }
        }
    })
    .await
    .expect("session commits and any report arrives");
    agent.abort();
    connection.abort();
    let _ = tokio::join!(agent, connection);
    seen
}
