use serde::Serialize;

use crate::acp::state::{AcpState, ConfigOptionCategory, SettingApplicationStatus};

#[derive(Debug, Serialize)]
pub(super) struct SavedSelector {
    pub config_id: String,
    pub category: ConfigOptionCategory,
    pub value: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub(super) struct PendingSetting {
    pub id: String,
    pub name: String,
    pub application: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

pub(super) fn pending_selector(
    id: &str,
    name: &str,
    desired: &str,
    observed: Option<&str>,
    control: &AcpState,
    running: bool,
    starting: bool,
) -> Option<PendingSetting> {
    let operation = control
        .setting_applications
        .get(id)
        .filter(|operation| operation.value == desired);
    let (application, reason) = if !running && !starting {
        ("next_start", None)
    } else if let Some(operation) = operation {
        match &operation.status {
            SettingApplicationStatus::Applying => ("applying", None),
            SettingApplicationStatus::Queued => ("queued", None),
            _ if observed == Some(desired) => return None,
            SettingApplicationStatus::Failed { reason } => ("rejected", Some(reason.clone())),
            SettingApplicationStatus::Applied => ("confirmation", None),
        }
    } else if observed == Some(desired) {
        return None;
    } else if let Some(failure) = control
        .config_option_switch_failed
        .as_ref()
        .filter(|failure| failure.config_id == id && failure.value == desired)
    {
        ("rejected", Some(failure.reason.clone()))
    } else {
        (if starting { "applying" } else { "confirmation" }, None)
    };
    Some(PendingSetting {
        id: id.into(),
        name: name.into(),
        application,
        reason,
    })
}

pub(super) fn pending_launch(
    id: &str,
    name: &str,
    customized: bool,
    applied_known: bool,
    matches_applied: bool,
    running: bool,
    starting: bool,
) -> Option<PendingSetting> {
    if applied_known && matches_applied || !running && !starting && !customized {
        return None;
    }
    let application = if !running && !starting {
        "next_start"
    } else if applied_known || customized {
        "restart"
    } else {
        "confirmation"
    };
    let reason = (!applied_known && (running || starting))
        .then(|| "The running agent’s applied value is unknown".into());
    Some(PendingSetting {
        id: id.into(),
        name: name.into(),
        application,
        reason,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::state::{Event, SettingApplication};

    #[test]
    fn pending_settings_follow_operations_and_worker_lifecycle() {
        let mut control = AcpState::default();
        for (revision, status, expected) in [
            (1, SettingApplicationStatus::Applying, "applying"),
            (2, SettingApplicationStatus::Queued, "queued"),
            (
                3,
                SettingApplicationStatus::Failed {
                    reason: "busy".into(),
                },
                "rejected",
            ),
        ] {
            for id in ["model", "effort"] {
                control
                    .apply_event(Event::SettingApplicationChanged {
                        config_id: id.into(),
                        application: SettingApplication {
                            value: "high".into(),
                            revision,
                            status: status.clone(),
                        },
                    })
                    .unwrap();
                let pending =
                    pending_selector(id, id, "high", Some("low"), &control, true, false).unwrap();
                assert_eq!(pending.application, expected);
                assert_eq!(
                    pending.reason.as_deref(),
                    (expected == "rejected").then_some("busy")
                );
            }
        }
        assert_eq!(control.setting_applications.len(), 2);
        assert!(pending_selector(
            "effort",
            "Effort",
            "high",
            Some("high"),
            &control,
            true,
            false
        )
        .is_none());
        control
            .apply_event(Event::SettingApplicationChanged {
                config_id: "model".into(),
                application: SettingApplication {
                    value: "old".into(),
                    revision: 1,
                    status: SettingApplicationStatus::Applying,
                },
            })
            .unwrap();
        assert_eq!(control.setting_applications["model"].value, "high");
        assert_eq!(
            pending_selector(
                "model",
                "Model",
                "high",
                Some("high"),
                &control,
                false,
                false
            )
            .unwrap()
            .application,
            "next_start"
        );
        control
            .apply_event(Event::SettingApplicationChanged {
                config_id: "model".into(),
                application: SettingApplication {
                    value: "high".into(),
                    revision: 4,
                    status: SettingApplicationStatus::Applied,
                },
            })
            .unwrap();
        assert!(pending_selector(
            "model",
            "Model",
            "high",
            Some("high"),
            &control,
            true,
            false
        )
        .is_none());
        control
            .apply_event(Event::AcpSessionAssigned {
                acp_session_id: "new".into(),
            })
            .unwrap();
        assert!(control.setting_applications.is_empty());
        assert_eq!(
            pending_selector("model", "Model", "high", Some("low"), &control, false, true)
                .unwrap()
                .application,
            "applying"
        );
    }

    #[test]
    fn launch_settings_do_not_promise_to_apply_to_an_already_starting_process() {
        for (running, starting) in [(true, false), (false, true)] {
            assert_eq!(
                pending_launch("budget", "Budget", true, true, false, running, starting)
                    .unwrap()
                    .application,
                "restart"
            );
            assert_eq!(
                pending_launch("budget", "Budget", false, false, false, running, starting)
                    .unwrap()
                    .application,
                "confirmation"
            );
            assert!(
                pending_launch("budget", "Budget", false, true, true, running, starting).is_none()
            );
        }
        assert!(pending_launch("budget", "Budget", false, false, false, false, false).is_none());
        assert_eq!(
            pending_launch("budget", "Budget", true, false, false, false, false)
                .unwrap()
                .application,
            "next_start"
        );
    }
}
