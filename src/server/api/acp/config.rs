//! Session mode and config-option selectors.

use serde::{Deserialize, Serialize};

use crate::acp::state::ConfigOptionCategory;

use super::settings::{pending_launch, pending_selector, SavedSelector};
use super::*;

#[derive(Debug, Deserialize)]
pub struct SetModeRequest {
    pub mode_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SetConfigOptionRequest {
    pub config_id: String,
    pub value: String,
}

/// Tally plan-mode adoption. `"plan"` is the plan value on both the mode and
/// the config-option channel, and no other category uses it.
fn count_plan_mode(state: &AppState, value: &str) {
    if value == "plan" {
        state
            .telemetry_structured
            .plan_mode_seen
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }
}

pub async fn acp_set_mode(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    req: Result<Json<SetModeRequest>, axum::extract::rejection::JsonRejection>,
) -> impl IntoResponse {
    if let Some(resp) = read_only_block(&state) {
        return resp;
    }
    if let Some(resp) = cityhall_block(&state) {
        return resp;
    }
    let Json(req) = match req {
        Ok(j) => j,
        Err(rej) => return rej.into_response(),
    };
    acp_update_launch_options(
        State(state),
        Path(id),
        Ok(Json(UpdateLaunchOptionsRequest {
            mode_id: Some(req.mode_id),
            restart: Some(false),
            ..Default::default()
        })),
    )
    .await
    .into_response()
}

/// The persisted `Instance` field a config-option pick writes back to, so the
/// pick survives a worker respawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PersistedSelector {
    Model,
    Mode,
    ThoughtLevel,
}

impl PersistedSelector {
    fn apply(self, inst: &mut crate::session::Instance, value: String) {
        match self {
            Self::Model => inst.agent_model = Some(value),
            Self::Mode => inst.acp_mode_id = Some(value),
            Self::ThoughtLevel => inst.acp_effort = Some(value),
        }
    }
}

/// Prefer session-local descriptors; the catalog is only a fallback.
async fn config_option_category(
    state: &Arc<AppState>,
    id: &str,
    config_id: &str,
) -> Option<ConfigOptionCategory> {
    let agent = {
        let instances = state.instances.read().await;
        instances.iter().find(|i| i.id == id).map(|i| {
            i.agent_name
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or(i.tool.as_str())
                .to_string()
        })
    }?;
    let control = state.session_service.fold_control_state(id).await;
    if control.agent.0 == agent {
        if let Some(option) = control
            .config_options
            .iter()
            .find(|option| option.id == config_id)
        {
            return Some(option.category.clone());
        }
    }
    crate::acp::option_catalog::load()
        .agents
        .get(&agent)
        .into_iter()
        .flat_map(|entry| entry.options.iter())
        .find(|opt| opt.id == config_id)
        .map(|opt| opt.category.clone())
}

/// Set a selector via ACP `session/set_config_option` (#1403). Rejection
/// surfaces as a `ConfigOptionSwitchFailed` event, not an HTTP error.
pub async fn acp_set_config_option(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    req: Result<Json<SetConfigOptionRequest>, axum::extract::rejection::JsonRejection>,
) -> impl IntoResponse {
    if let Some(resp) = read_only_block(&state) {
        return resp;
    }
    if let Some(resp) = cityhall_block(&state) {
        return resp;
    }
    let Json(req) = match req {
        Ok(j) => j,
        Err(rej) => return rej.into_response(),
    };
    acp_update_launch_options(
        State(state),
        Path(id),
        Ok(Json(UpdateLaunchOptionsRequest {
            config_options: vec![req],
            restart: Some(false),
            ..Default::default()
        })),
    )
    .await
    .into_response()
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateLaunchOptionsRequest {
    pub yolo_mode: Option<bool>,
    pub auto_compaction: Option<crate::acp::compaction::Budget>,
    pub restart: Option<bool>,
    #[serde(default)]
    pub config_options: Vec<SetConfigOptionRequest>,
    pub mode_id: Option<String>,
}

pub async fn acp_launch_options(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    let instance = {
        let instances = state.instances.read().await;
        let Some(instance) = instances.iter().find(|instance| instance.id == id) else {
            return session_not_found();
        };
        instance.clone()
    };
    let agent = instance
        .agent_name
        .as_deref()
        .filter(|name| !name.is_empty())
        .unwrap_or(&instance.tool);
    let control = state.session_service.fold_control_state(&id).await;
    let options = if control.agent.0 == agent && !control.config_options.is_empty() {
        control.config_options.clone()
    } else {
        crate::acp::option_catalog::load()
            .agents
            .get(agent)
            .map(|entry| entry.options.clone())
            .unwrap_or_default()
    };
    let mut selectors: Vec<_> = options
        .iter()
        .filter_map(|option| {
            let value = match option.category {
                ConfigOptionCategory::Model => &instance.agent_model,
                ConfigOptionCategory::Mode => &instance.acp_mode_id,
                ConfigOptionCategory::ThoughtLevel => &instance.acp_effort,
                ConfigOptionCategory::Other(_) => return None,
            };
            Some(SavedSelector {
                config_id: option.id.clone(),
                category: option.category.clone(),
                value: value.clone(),
            })
        })
        .collect();
    if !options
        .iter()
        .any(|option| option.category == ConfigOptionCategory::Model)
        && instance.agent_model.is_some()
    {
        selectors.push(SavedSelector {
            config_id: "model".into(),
            category: ConfigOptionCategory::Model,
            value: instance.agent_model.clone(),
        });
    }
    let applied = state.acp_supervisor.compaction_budget(&id).await;
    let applied_yolo = state.acp_supervisor.launch_yolo(&id).await;
    let worker_state = state.acp_supervisor.worker_state(&id).await;
    let running = worker_state == crate::daemon::AcpWorkerState::Running;
    let starting = worker_state == crate::daemon::AcpWorkerState::Resuming;
    let budget_known = (running || starting) && applied.is_some();
    let yolo_known = (running || starting) && applied_yolo.is_some();
    let yolo_requires_restart = supports_yolo_launch(agent);
    let mut pending = Vec::new();
    for selector in &selectors {
        let Some(desired) = &selector.value else {
            continue;
        };
        let descriptor = options
            .iter()
            .find(|option| option.id == selector.config_id);
        let name = descriptor.map_or("Model", |option| option.name.as_str());
        let observed = control
            .config_options
            .iter()
            .find(|option| option.id == selector.config_id)
            .map(|option| option.current_value.as_str());
        if let Some(setting) = pending_selector(
            &selector.config_id,
            name,
            desired,
            observed,
            &control,
            running,
            starting,
        ) {
            pending.push(setting);
        }
    }
    if !selectors
        .iter()
        .any(|selector| selector.category == ConfigOptionCategory::Mode && selector.value.is_some())
    {
        if let Some(mode) = &instance.acp_mode_id {
            if let Some(setting) = pending_selector(
                "legacy_mode",
                "Mode",
                mode,
                control.current_mode_id.as_deref(),
                &control,
                running,
                starting,
            ) {
                pending.push(setting);
            }
        }
    }
    if crate::acp::compaction::bounds(agent).is_some() {
        if let Some(setting) = pending_launch(
            "auto_compaction",
            "Auto-compaction",
            instance.auto_compact_tokens.is_some(),
            budget_known,
            instance.auto_compact_tokens == applied.flatten(),
            running,
            starting,
        ) {
            pending.push(setting);
        }
    }
    if yolo_requires_restart {
        if let Some(setting) = pending_launch(
            "yolo_mode",
            "Yolo",
            instance.yolo_mode,
            yolo_known,
            applied_yolo == Some(instance.yolo_mode),
            running,
            starting,
        ) {
            pending.push(setting);
        }
    }
    Json(serde_json::json!({
        "agent": agent,
        "running": running,
        "starting": worker_state == crate::daemon::AcpWorkerState::Resuming,
        "selectors": selectors,
        "pending": pending,
        "config_options": options,
        "mode_id": instance.acp_mode_id,
        "yolo_mode": {
            "enabled": instance.yolo_mode,
            "requires_restart": yolo_requires_restart,
            "applied_known": yolo_known,
            "applied_enabled": applied_yolo,
        },
        "auto_compaction": {
            "tokens": instance.auto_compact_tokens,
            "bounds": crate::acp::compaction::bounds(agent),
            "applied_known": budget_known,
            "applied_tokens": applied.flatten(),
            "running": running,
            "starting": worker_state == crate::daemon::AcpWorkerState::Resuming,
        }
    }))
    .into_response()
}

#[derive(Debug, Serialize)]
pub struct UpdateLaunchOptionsResponse {
    pub status: &'static str,
    pub restarted: bool,
    pub yolo_mode: bool,
}

fn supports_yolo_launch(agent: &str) -> bool {
    crate::agents::get_agent(agent).is_some_and(|definition| {
        matches!(definition.yolo, Some(crate::agents::YoloMode::EnvVar(_, _)))
    })
}

/// Save desired settings, dispatch live selectors, and optionally restart the worker.
pub async fn acp_update_launch_options(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    req: Result<Json<UpdateLaunchOptionsRequest>, axum::extract::rejection::JsonRejection>,
) -> impl IntoResponse {
    if let Some(resp) = read_only_block(&state) {
        return resp;
    }
    if let Some(resp) = cityhall_block(&state) {
        return resp;
    }
    let Json(req) = match req {
        Ok(json) => json,
        Err(rejection) => return rejection.into_response(),
    };
    if req.yolo_mode.is_none()
        && req.auto_compaction.is_none()
        && req.config_options.is_empty()
        && req.mode_id.is_none()
        && req.restart != Some(true)
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "empty_patch",
                "message": "No settings were provided",
            })),
        )
            .into_response();
    }

    let instance_lock = state.instance_lock(&id).await;
    let _guard = instance_lock.lock().await;
    let (profile, agent, previous, previous_tokens) = {
        let instances = state.instances.read().await;
        let Some(instance) = instances.iter().find(|instance| instance.id == id) else {
            return session_not_found();
        };
        if !instance.is_structured() {
            return super::worker::not_structured_response();
        }
        let agent = instance
            .agent_name
            .as_deref()
            .filter(|name| !name.is_empty())
            .unwrap_or(instance.tool.as_str())
            .to_string();
        (
            instance.source_profile.clone(),
            agent,
            instance.yolo_mode,
            instance.auto_compact_tokens,
        )
    };
    let yolo_mode = req.yolo_mode.unwrap_or(previous);
    let mut selectors = Vec::new();
    let control = state.session_service.fold_control_state(&id).await;
    let live_options = state.acp_supervisor.worker_state(&id).await
        == crate::daemon::AcpWorkerState::Running
        && control.agent.0 == agent
        && !control.config_options.is_empty();
    let catalog = crate::acp::option_catalog::load();
    let options = if live_options {
        control.config_options.as_slice()
    } else {
        catalog
            .agents
            .get(&agent)
            .map(|entry| entry.options.as_slice())
            .unwrap_or_default()
    };
    for option in &req.config_options {
        if option.value.trim().is_empty() {
            return (StatusCode::BAD_REQUEST, "Setting values must not be empty").into_response();
        }
        let descriptor = options
            .iter()
            .find(|descriptor| descriptor.id == option.config_id);
        if live_options
            && descriptor.is_some_and(|descriptor| {
                !descriptor.options.is_empty()
                    && !descriptor
                        .options
                        .iter()
                        .any(|choice| choice.value == option.value)
            })
        {
            return (
                StatusCode::BAD_REQUEST,
                format!("Unsupported value for {}", option.config_id),
            )
                .into_response();
        }
        let selector = if option.config_id == "model" {
            Some(PersistedSelector::Model)
        } else {
            match config_option_category(&state, &id, &option.config_id).await {
                Some(ConfigOptionCategory::Model) => Some(PersistedSelector::Model),
                Some(ConfigOptionCategory::Mode) => Some(PersistedSelector::Mode),
                Some(ConfigOptionCategory::ThoughtLevel) => Some(PersistedSelector::ThoughtLevel),
                _ => None,
            }
        };
        let Some(selector) = selector else {
            return (
                StatusCode::BAD_REQUEST,
                format!("Unsupported saved setting {}", option.config_id),
            )
                .into_response();
        };
        if selectors.iter().any(|(existing, _)| *existing == selector) {
            return (StatusCode::BAD_REQUEST, "Duplicate setting category").into_response();
        }
        selectors.push((selector, option.value.clone()));
    }
    if let Some(mode) = &req.mode_id {
        if mode.trim().is_empty()
            || selectors
                .iter()
                .any(|(selector, _)| *selector == PersistedSelector::Mode)
        {
            return (
                StatusCode::BAD_REQUEST,
                "Invalid or duplicate permission mode",
            )
                .into_response();
        }
        if live_options
            && !control.available_modes.is_empty()
            && !control.available_modes.iter().any(|available| {
                available
                    .id
                    .replace('_', "")
                    .eq_ignore_ascii_case(&mode.replace('_', ""))
            })
            && !control.config_options.iter().any(|option| {
                option.category == ConfigOptionCategory::Mode
                    && option.options.iter().any(|choice| choice.value == *mode)
            })
        {
            return (StatusCode::BAD_REQUEST, "Unsupported permission mode").into_response();
        }
        selectors.push((PersistedSelector::Mode, mode.clone()));
    }
    let tokens = req
        .auto_compaction
        .map_or(previous_tokens, |budget| budget.tokens);
    if req.auto_compaction.is_some() {
        if let Err(message) = crate::acp::compaction::validate(&agent, tokens) {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"message": message})),
            )
                .into_response();
        }
    }
    let restart = req.restart.unwrap_or(false);

    if req.yolo_mode.is_some() && !supports_yolo_launch(&agent) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "unsupported_launch_option",
                "message": format!("Change the permission mode for {agent:?}; it has no launch-only auto-approval setting"),
            })),
        )
            .into_response();
    }
    if previous == yolo_mode
        && previous_tokens == tokens
        && req.auto_compaction.is_none()
        && selectors.is_empty()
        && !restart
    {
        return Json(UpdateLaunchOptionsResponse {
            status: "unchanged",
            restarted: false,
            yolo_mode,
        })
        .into_response();
    }

    let storage = match crate::session::Storage::new(&profile, state.file_watch.clone()) {
        Ok(storage) => storage,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("could not open session storage: {error}"),
            )
                .into_response();
        }
    };
    let id_for_persist = id.clone();
    let persisted_selectors = selectors.clone();
    let persisted = tokio::task::spawn_blocking(move || {
        storage.update(|instances, _groups| {
            let Some(instance) = instances
                .iter_mut()
                .find(|instance| instance.id == id_for_persist)
            else {
                anyhow::bail!("session disappeared while saving settings");
            };
            instance.yolo_mode = yolo_mode;
            instance.auto_compact_tokens = tokens;
            for (selector, value) in &persisted_selectors {
                selector.apply(instance, value.clone());
            }
            Ok(())
        })
    })
    .await;
    if let Err(message) = match persisted {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(format!("could not save settings: {error}")),
        Err(error) => Err(format!("settings persistence task failed: {error}")),
    } {
        return (StatusCode::INTERNAL_SERVER_ERROR, message).into_response();
    }

    {
        let mut instances = state.instances.write().await;
        let Some(instance) = instances.iter_mut().find(|instance| instance.id == id) else {
            return (
                StatusCode::NOT_FOUND,
                "session disappeared after persistence",
            )
                .into_response();
        };
        instance.yolo_mode = yolo_mode;
        instance.auto_compact_tokens = tokens;
        for (selector, value) in &selectors {
            selector.apply(instance, value.clone());
        }
    }

    let generation = state
        .acp_supervisor
        .running_identity(&id)
        .map(|identity| identity.generation)
        .or_else(|| {
            crate::process::worker_registry::load(&id)
                .ok()
                .flatten()
                .map(|record| record.generation)
        });
    let worker_state = state.acp_supervisor.worker_state(&id).await;
    let running = worker_state == crate::daemon::AcpWorkerState::Running;
    if !restart || generation.is_none() {
        let applying = !selectors.is_empty()
            && (running || worker_state == crate::daemon::AcpWorkerState::Resuming);
        if applying {
            let supervisor = Arc::clone(&state.acp_supervisor);
            let session = id.clone();
            tokio::spawn(async move {
                if let Err(error) = supervisor.reconcile_settings(&session).await {
                    tracing::warn!(target: "http.api.acp", session = %session, %error, "saved settings could not be reconciled; retained for next start");
                }
            });
        }
        for (_, value) in &selectors {
            count_plan_mode(&state, value);
        }
        return Json(UpdateLaunchOptionsResponse {
            status: if applying {
                "applying"
            } else {
                "saved_for_next_start"
            },
            restarted: false,
            yolo_mode,
        })
        .into_response();
    }
    let id_for_restart = id.clone();
    let _ = tokio::task::spawn_blocking(move || {
        if let Some(generation) = generation {
            crate::process::worker_registry::mark_restart_pending(&id_for_restart, generation);
        }
        crate::process::worker_registry::terminate(&id_for_restart);
    })
    .await;
    state.acp_supervisor.request_respawn(&id);

    (
        StatusCode::ACCEPTED,
        Json(UpdateLaunchOptionsResponse {
            status: "restarting",
            restarted: true,
            yolo_mode,
        }),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::state::{ConfigOptionChoice, ConfigOptionDescriptor};
    use crate::session::test_support::isolate_app_dir;

    async fn wait_for_reconciliation(commands: &std::sync::Mutex<Vec<&'static str>>) {
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while commands.lock().unwrap().is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("saved settings are delivered to the worker");
        assert_eq!(*commands.lock().unwrap(), vec!["reconcile_settings"]);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn live_settings_use_session_descriptors_and_canonical_confirmation() {
        use crate::acp::state::{Event, SettingApplication, SettingApplicationStatus};
        use crate::acp::supervisor::{BroadcastSink, ChannelSink};
        let _app = isolate_app_dir();
        let mut instance = crate::session::Instance::new("settings", "/tmp");
        instance.view = crate::session::View::Structured;
        instance.agent_model = Some("old".into());
        let id = instance.id.clone();
        let storage = crate::session::Storage::new_unwatched(&instance.source_profile).unwrap();
        storage
            .update(|instances, _| {
                instances.push(instance.clone());
                Ok(())
            })
            .unwrap();
        let state = crate::server::test_support::build_test_app_state(vec![instance]);
        let option = |value: &str| ConfigOptionDescriptor {
            id: "model".into(),
            name: "Model".into(),
            description: None,
            category: ConfigOptionCategory::Model,
            current_value: "old".into(),
            options: vec![ConfigOptionChoice {
                value: value.into(),
                name: value.into(),
                description: None,
            }],
        };
        crate::acp::option_catalog::record("claude", &[option("catalog-only")], "now".into())
            .unwrap();
        state.session_service.fold_control_state(&id).await;
        let sink = ChannelSink {
            tx: state.acp_events_tx.clone(),
            event_store: Arc::clone(&state.acp_event_store),
            control_cache: Arc::clone(&state.acp_control_cache),
        };
        assert!(sink.publish_persisted(
            &id,
            1,
            &Event::ConfigOptionsUpdated {
                options: vec![option("local-choice")]
            }
        ));
        let commands = state.acp_supervisor.test_insert_recording_worker(&id).await;
        for (value, accepted) in [("catalog-only", false), ("local-choice", true)] {
            let response = acp_set_config_option(
                State(state.clone()),
                Path(id.clone()),
                Ok(Json(SetConfigOptionRequest {
                    config_id: "model".into(),
                    value: value.into(),
                })),
            )
            .await
            .into_response();
            assert_eq!(response.status().is_success(), accepted, "{value}");
            assert_eq!(
                storage.load().unwrap()[0].agent_model.as_deref(),
                Some(if accepted { "local-choice" } else { "old" })
            );
        }
        wait_for_reconciliation(&commands).await;
        let mut confirmed = option("local-choice");
        confirmed.current_value = "canonical-choice".into();
        assert!(sink.publish_persisted(
            &id,
            2,
            &Event::ConfigOptionsUpdated {
                options: vec![confirmed]
            }
        ));
        assert!(sink.publish_persisted(
            &id,
            3,
            &Event::SettingApplicationChanged {
                config_id: "model".into(),
                application: SettingApplication {
                    value: "local-choice".into(),
                    applied_value: Some("canonical-choice".into()),
                    revision: 1,
                    status: SettingApplicationStatus::Applied,
                },
            }
        ));
        let response = acp_launch_options(State(state), Path(id)).await;
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(!body["pending"]
            .as_array()
            .unwrap()
            .iter()
            .any(|setting| setting["id"] == "model"));
        assert_eq!(body["selectors"][0]["value"], "local-choice");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn compaction_settings_persist_without_waking_dormant_agents() {
        let _tmp = isolate_app_dir();
        let mut instance = crate::session::Instance::new("budget", "/tmp");
        instance.view = crate::session::View::Structured;
        instance.source_profile = "default".into();
        let id = instance.id.clone();
        let storage = crate::session::Storage::new_unwatched("default").unwrap();
        storage
            .update(|instances, _| {
                instances.push(instance.clone());
                Ok(())
            })
            .unwrap();
        let state = crate::server::test_support::build_test_app_state(vec![instance]);
        for (tokens, restart, expected_status) in [
            (Some(200_000), false, StatusCode::OK),
            (Some(99_999), false, StatusCode::BAD_REQUEST),
            (Some(300_000), true, StatusCode::OK),
            (None, false, StatusCode::OK),
        ] {
            let previous = state.instances.read().await[0].auto_compact_tokens;
            let response = acp_update_launch_options(
                State(state.clone()),
                Path(id.clone()),
                Ok(Json(UpdateLaunchOptionsRequest {
                    yolo_mode: None,
                    auto_compaction: Some(crate::acp::compaction::Budget { tokens }),
                    restart: Some(restart),
                    ..Default::default()
                })),
            )
            .await
            .into_response();
            assert_eq!(response.status(), expected_status);
            let expected = if expected_status.is_success() {
                tokens
            } else {
                previous
            };
            assert_eq!(
                state.instances.read().await[0].auto_compact_tokens,
                expected
            );
            assert_eq!(storage.load().unwrap()[0].auto_compact_tokens, expected);
            assert!(state.acp_supervisor.running_identity(&id).is_none());
            let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            if expected_status.is_success() {
                let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
                assert_eq!(body["status"], "saved_for_next_start");
                assert_eq!(body["restarted"], false);
            }
        }
        let restart = acp_update_launch_options(
            State(state.clone()),
            Path(id.clone()),
            Ok(Json(UpdateLaunchOptionsRequest {
                restart: Some(true),
                ..Default::default()
            })),
        )
        .await
        .into_response();
        assert_eq!(restart.status(), StatusCode::OK);
        let restart = axum::body::to_bytes(restart.into_body(), usize::MAX)
            .await
            .unwrap();
        let restart: serde_json::Value = serde_json::from_slice(&restart).unwrap();
        assert_eq!(restart["status"], "saved_for_next_start");
        assert_eq!(restart["restarted"], false);
        assert!(state.acp_supervisor.running_identity(&id).is_none());
        let response = acp_launch_options(State(state), Path(id)).await;
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["auto_compaction"]["tokens"], serde_json::Value::Null);
        assert_eq!(
            body["auto_compaction"]["bounds"],
            serde_json::json!([100000, 1000000])
        );
        assert_eq!(body["auto_compaction"]["applied_known"], false);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn yolo_launch_patch_uses_backend_policy_and_never_implicitly_restarts() {
        let _app = isolate_app_dir();
        for (agent, accepted) in [("opencode", true), ("claude", false), ("codex", false)] {
            let mut instance = crate::session::Instance::new(agent, "/tmp");
            instance.tool = agent.into();
            instance.view = crate::session::View::Structured;
            let id = instance.id.clone();
            let storage = crate::session::Storage::new_unwatched(&instance.source_profile).unwrap();
            storage
                .update(|instances, _| {
                    instances.push(instance.clone());
                    Ok(())
                })
                .unwrap();
            let state = crate::server::test_support::build_test_app_state(vec![instance]);
            for enabled in [true, false] {
                let response = acp_update_launch_options(
                    State(state.clone()),
                    Path(id.clone()),
                    Ok(Json(UpdateLaunchOptionsRequest {
                        yolo_mode: Some(enabled),
                        ..Default::default()
                    })),
                )
                .await
                .into_response();
                assert_eq!(response.status().is_success(), accepted, "{agent}");
                assert!(state.acp_supervisor.running_identity(&id).is_none());
                assert_eq!(
                    storage
                        .load()
                        .unwrap()
                        .iter()
                        .find(|instance| instance.id == id)
                        .unwrap()
                        .yolo_mode,
                    accepted && enabled
                );
            }
        }
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn dormant_selectors_persist_without_worker_requests() {
        let cases = [
            (PersistedSelector::Model, "claude-sonnet-5"),
            (PersistedSelector::Mode, "agent-full-access"),
            (PersistedSelector::ThoughtLevel, "high"),
        ];
        for (selector, value) in cases {
            let _tmp = isolate_app_dir();
            let mut inst = crate::session::Instance::new("t", "/tmp");
            inst.source_profile = "default".to_string();
            inst.view = crate::session::View::Structured;
            inst.agent_model = Some("claude-sonnet-4-6".to_string());
            let id = inst.id.clone();
            let seed = inst.clone();
            crate::session::Storage::new_unwatched("default")
                .unwrap()
                .update(|instances, _groups| {
                    instances.push(seed);
                    Ok(())
                })
                .unwrap();

            let state = crate::server::test_support::build_test_app_state(vec![inst]);
            let category = match selector {
                PersistedSelector::Model => ConfigOptionCategory::Model,
                PersistedSelector::Mode => ConfigOptionCategory::Mode,
                PersistedSelector::ThoughtLevel => ConfigOptionCategory::ThoughtLevel,
            };
            crate::acp::option_catalog::record(
                "claude",
                &[ConfigOptionDescriptor {
                    id: "pick".into(),
                    name: "Pick".into(),
                    description: None,
                    category,
                    current_value: String::new(),
                    options: vec![ConfigOptionChoice {
                        value: value.into(),
                        name: value.into(),
                        description: None,
                    }],
                }],
                "now".into(),
            )
            .unwrap();
            let response = acp_set_config_option(
                State(state.clone()),
                Path(id.clone()),
                Ok(Json(SetConfigOptionRequest {
                    config_id: "pick".into(),
                    value: value.into(),
                })),
            )
            .await
            .into_response();
            assert!(response.status().is_success());
            let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(body["status"], "saved_for_next_start");
            assert!(state.acp_supervisor.running_identity(&id).is_none());

            let field = |inst: &crate::session::Instance| match selector {
                PersistedSelector::Model => inst.agent_model.clone(),
                PersistedSelector::Mode => inst.acp_mode_id.clone(),
                PersistedSelector::ThoughtLevel => inst.acp_effort.clone(),
            };
            assert_eq!(
                field(&state.instances.read().await[0]).as_deref(),
                Some(value)
            );
            let reloaded = crate::session::Storage::new_unwatched("default")
                .unwrap()
                .load()
                .unwrap();
            let on_disk = reloaded.iter().find(|i| i.id == id).unwrap();
            assert_eq!(field(on_disk).as_deref(), Some(value), "{selector:?}");
        }
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn settings_batch_validates_before_persistence_and_reports_storage_failures() {
        let _tmp = isolate_app_dir();
        let mut instance = crate::session::Instance::new("batch", "/tmp");
        instance.view = crate::session::View::Structured;
        instance.source_profile = "default".into();
        instance.agent_model = Some("old-model".into());
        let id = instance.id.clone();
        let storage = crate::session::Storage::new_unwatched("default").unwrap();
        storage
            .update(|instances, _| {
                instances.push(instance.clone());
                Ok(())
            })
            .unwrap();
        let state = crate::server::test_support::build_test_app_state(vec![instance]);
        let response = acp_update_launch_options(
            State(state.clone()),
            Path(id.clone()),
            Ok(Json(UpdateLaunchOptionsRequest {
                config_options: vec![
                    SetConfigOptionRequest {
                        config_id: "model".into(),
                        value: "new-model".into(),
                    },
                    SetConfigOptionRequest {
                        config_id: "unknown-option".into(),
                        value: "unknown".into(),
                    },
                ],
                restart: Some(false),
                ..Default::default()
            })),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            storage.load().unwrap()[0].agent_model.as_deref(),
            Some("old-model")
        );
        assert_eq!(
            state.instances.read().await[0].agent_model.as_deref(),
            Some("old-model")
        );
        let duplicate = acp_update_launch_options(
            State(state.clone()),
            Path(id.clone()),
            Ok(Json(UpdateLaunchOptionsRequest {
                config_options: vec![
                    SetConfigOptionRequest {
                        config_id: "model".into(),
                        value: "new-model".into(),
                    },
                    SetConfigOptionRequest {
                        config_id: "model".into(),
                        value: "another-model".into(),
                    },
                ],
                restart: Some(false),
                ..Default::default()
            })),
        )
        .await
        .into_response();
        assert_eq!(duplicate.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            storage.load().unwrap()[0].agent_model.as_deref(),
            Some("old-model")
        );

        let response = acp_set_mode(
            State(state.clone()),
            Path(id.clone()),
            Ok(Json(SetModeRequest {
                mode_id: "plan".into(),
            })),
        )
        .await
        .into_response();
        assert!(response.status().is_success());
        assert_eq!(
            storage.load().unwrap()[0].acp_mode_id.as_deref(),
            Some("plan")
        );
        assert!(state.acp_supervisor.running_identity(&id).is_none());

        let commands = state.acp_supervisor.test_insert_recording_worker(&id).await;
        let response = acp_set_config_option(
            State(state.clone()),
            Path(id.clone()),
            Ok(Json(SetConfigOptionRequest {
                config_id: "model".into(),
                value: "new-model".into(),
            })),
        )
        .await
        .into_response();
        assert!(response.status().is_success());
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["status"], "applying");
        wait_for_reconciliation(&commands).await;
        assert_eq!(
            storage.load().unwrap()[0].agent_model.as_deref(),
            Some("new-model")
        );

        let snapshot = acp_launch_options(State(state.clone()), Path(id.clone())).await;
        let snapshot = axum::body::to_bytes(snapshot.into_body(), usize::MAX)
            .await
            .unwrap();
        let snapshot: serde_json::Value = serde_json::from_slice(&snapshot).unwrap();
        assert_eq!(snapshot["running"], true);
        assert_eq!(snapshot["yolo_mode"]["applied_known"], false);
        assert_eq!(snapshot["auto_compaction"]["applied_known"], false);

        storage
            .update(|instances, _| {
                instances.clear();
                Ok(())
            })
            .unwrap();
        let response = acp_set_config_option(
            State(state.clone()),
            Path(id.clone()),
            Ok(Json(SetConfigOptionRequest {
                config_id: "model".into(),
                value: "failed-model".into(),
            })),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            state.instances.read().await[0].agent_model.as_deref(),
            Some("new-model")
        );
        let response = acp_set_config_option(
            State(state),
            Path("missing-session".into()),
            Ok(Json(SetConfigOptionRequest {
                config_id: "model".into(),
                value: "new-model".into(),
            })),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn config_option_category_resolves_categories_from_catalog() {
        let _tmp = isolate_app_dir();
        let mut inst = crate::session::Instance::new("codex", "/tmp");
        inst.agent_name = Some("codex".to_string());
        let id = inst.id.clone();

        let option =
            |id: &str, category, choices: Vec<ConfigOptionChoice>| ConfigOptionDescriptor {
                id: id.to_string(),
                name: id.to_string(),
                description: None,
                category,
                current_value: String::new(),
                options: choices,
            };
        let choice = |value: &str| ConfigOptionChoice {
            value: value.to_string(),
            name: value.to_string(),
            description: None,
        };
        let opts = vec![
            option(
                "codex-mode",
                ConfigOptionCategory::Mode,
                vec![choice("agent-full-access")],
            ),
            option("model", ConfigOptionCategory::Model, vec![]),
            option(
                "reasoning-effort",
                ConfigOptionCategory::ThoughtLevel,
                vec![choice("high")],
            ),
        ];
        crate::acp::option_catalog::record("codex", &opts, "2026-07-24T00:00:00Z".to_string())
            .unwrap();
        let state = crate::server::test_support::build_test_app_state(vec![inst]);

        for (config_id, expected) in [
            ("codex-mode", Some(ConfigOptionCategory::Mode)),
            ("model", Some(ConfigOptionCategory::Model)),
            ("reasoning-effort", Some(ConfigOptionCategory::ThoughtLevel)),
            ("unknown", None),
        ] {
            assert_eq!(
                config_option_category(&state, &id, config_id).await,
                expected
            );
        }
    }
}
