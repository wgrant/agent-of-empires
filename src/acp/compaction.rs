//! Per-session working context budgets, separate from model capacity.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Budget {
    pub tokens: Option<u64>,
}

pub async fn load_budget(
    profile: Option<String>,
    session_id: String,
    agent: String,
) -> Result<Option<u64>, String> {
    let Some(profile) = profile else {
        return Ok(None);
    };
    tokio::task::spawn_blocking(move || {
        let storage = crate::session::Storage::new_unwatched(&profile)?;
        Ok::<_, anyhow::Error>(
            storage
                .load()?
                .iter()
                .find(|instance| {
                    instance.id == session_id
                        && instance
                            .agent_name
                            .as_deref()
                            .filter(|name| !name.is_empty())
                            .unwrap_or(&instance.tool)
                            == agent
                })
                .and_then(|instance| instance.auto_compact_tokens),
        )
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

pub fn bounds(agent: &str) -> Option<(u64, u64)> {
    match agent {
        "codex" => Some((10_000, 2_000_000)),
        "claude" | "claude-code" => Some((100_000, 1_000_000)),
        _ => None,
    }
}

pub fn validate(agent: &str, tokens: Option<u64>) -> Result<(), String> {
    let Some(tokens) = tokens else { return Ok(()) };
    let Some((min, max)) = bounds(agent) else {
        return Err("This agent does not support a custom auto-compaction budget".into());
    };
    if !(min..=max).contains(&tokens) {
        return Err(format!("Enter a budget between {min} and {max} tokens"));
    }
    Ok(())
}

pub fn environment(
    agent: &str,
    tokens: Option<u64>,
    environment: &[(String, String)],
) -> Result<Vec<(String, String)>, String> {
    let Some(tokens) = tokens else {
        return Ok(vec![]);
    };
    // A budget remains saved when switching to a backend without this control.
    if bounds(agent).is_none() {
        return Ok(vec![]);
    }
    validate(agent, Some(tokens))?;
    match agent {
        "codex" => {
            let existing = environment
                .iter()
                .rev()
                .find(|(key, _)| key == "CODEX_CONFIG");
            let mut config = match existing {
                Some((_, value)) => serde_json::from_str::<
                    serde_json::Map<String, serde_json::Value>,
                >(value)
                .map_err(|_| {
                    "CODEX_CONFIG must be a JSON object to set a compaction budget".to_string()
                })?,
                None => serde_json::Map::new(),
            };
            config.insert("model_auto_compact_token_limit".into(), tokens.into());
            Ok(vec![(
                "CODEX_CONFIG".into(),
                serde_json::to_string(&config).unwrap(),
            )])
        }
        "claude" | "claude-code" => Ok(vec![(
            "CLAUDE_CODE_AUTO_COMPACT_WINDOW".into(),
            tokens.to_string(),
        )]),
        _ => unreachable!(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[serial_test::serial]
    async fn saved_budget_is_reloaded_and_is_not_carried_to_another_backend() {
        let _tmp = crate::session::test_support::isolate_app_dir();
        let mut instance = crate::session::Instance::new("context", "/tmp");
        let id = instance.id.clone();
        let storage = crate::session::Storage::new_unwatched("default").unwrap();
        storage
            .update(|instances, _| {
                instances.push(instance.clone());
                Ok(())
            })
            .unwrap();
        assert_eq!(
            load_budget(Some("default".into()), id.clone(), "claude".into())
                .await
                .unwrap(),
            None
        );
        instance.auto_compact_tokens = Some(200_000);
        storage
            .update(|instances, _| {
                instances[0] = instance;
                Ok(())
            })
            .unwrap();
        assert_eq!(
            load_budget(Some("default".into()), id.clone(), "claude".into())
                .await
                .unwrap(),
            Some(200_000)
        );
        assert_eq!(
            load_budget(Some("default".into()), id, "codex".into())
                .await
                .unwrap(),
            None
        );
    }

    #[test]
    fn budgets_preserve_defaults_and_merge_only_the_threshold() {
        let existing = vec![(
            "CODEX_CONFIG".into(),
            r#"{"personality":"friendly","model_context_window":258000}"#.into(),
        )];
        assert!(environment("codex", None, &existing).unwrap().is_empty());
        let env = environment("codex", Some(120_000), &existing).unwrap();
        let config: serde_json::Value = serde_json::from_str(&env[0].1).unwrap();
        assert_eq!(config["personality"], "friendly");
        assert_eq!(config["model_context_window"], 258000);
        assert_eq!(config["model_auto_compact_token_limit"], 120000);
        assert_eq!(
            environment("claude", Some(200_000), &[]).unwrap(),
            vec![("CLAUDE_CODE_AUTO_COMPACT_WINDOW".into(), "200000".into())]
        );
        assert!(environment("opencode", Some(200_000), &[])
            .unwrap()
            .is_empty());
        for (agent, tokens, valid) in [
            ("claude", 99_999, false),
            ("claude", 100_000, true),
            ("claude", 1_000_001, false),
            ("codex", 10_000, true),
            ("opencode", 200_000, false),
        ] {
            assert_eq!(validate(agent, Some(tokens)).is_ok(), valid);
        }
        assert!(environment(
            "codex",
            Some(120_000),
            &[("CODEX_CONFIG".into(), "not json".into())]
        )
        .is_err());
    }
}
