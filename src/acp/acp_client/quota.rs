//! Plan quota from `usage_update` metadata: claude-agent-acp's
//! `_claude/rateLimit` and codex-acp's `_codex/rateLimits` mapped onto one shape.

use agent_client_protocol::schema::v1::Meta;
use chrono::{DateTime, Utc};
use serde_json::Value;

use super::rate_limit::epoch_secs;
use crate::acp::state::{AgentQuota, QuotaWindow};

const WEEK_MINS: u64 = 7 * 24 * 60;

pub(super) fn quota_from_meta(meta: Option<&Meta>, now: DateTime<Utc>) -> Option<AgentQuota> {
    let meta = meta?;
    let (windows, limited) = if let Some(info) = meta.get("_claude/rateLimit") {
        claude_windows(info)
    } else if let Some(Value::Array(limits)) = meta.get("_codex/rateLimits") {
        codex_windows(limits)
    } else {
        return None;
    };
    (!windows.is_empty() || limited).then_some(AgentQuota {
        windows,
        limited,
        observed_at: now,
    })
}

fn resets_at(v: Option<&Value>) -> Option<DateTime<Utc>> {
    v.and_then(epoch_secs)
        .and_then(|secs| DateTime::from_timestamp(secs, 0))
}

/// Claude names its windows rather than giving their length.
fn claude_window_shape(name: &str) -> (Option<u64>, Option<String>) {
    let duration = if name.starts_with("five_hour") {
        Some(5 * 60)
    } else if name.starts_with("seven_day") {
        Some(WEEK_MINS)
    } else {
        None
    };
    let scope = match name {
        "seven_day_opus" => Some("Opus"),
        "seven_day_sonnet" => Some("Sonnet"),
        _ => None,
    };
    (duration, scope.map(String::from))
}

fn claude_windows(info: &Value) -> (Vec<QuotaWindow>, bool) {
    let limited = info.get("status").and_then(Value::as_str) == Some("rejected");
    let window = |name: &str, w: &Value| {
        let utilization = w.get("utilization")?.as_f64()?;
        let (duration_mins, scope) = claude_window_shape(name);
        Some(QuotaWindow {
            id: name.to_string(),
            duration_mins,
            scope,
            used_percent: utilization * 100.0,
            resets_at: resets_at(w.get("resetsAt")),
        })
    };
    let mut windows: Vec<QuotaWindow> = match info.get("unifiedWindows").and_then(Value::as_object)
    {
        Some(unified) => unified
            .iter()
            .filter_map(|(name, w)| window(name, w))
            .collect(),
        // Without `unifiedWindows` only the window the status is about is reported.
        None => info
            .get("rateLimitType")
            .and_then(Value::as_str)
            .and_then(|name| window(name, info))
            .into_iter()
            .collect(),
    };
    windows.sort_by(|a, b| {
        (a.duration_mins.unwrap_or(u64::MAX), &a.id)
            .cmp(&(b.duration_mins.unwrap_or(u64::MAX), &b.id))
    });
    (windows, limited)
}

fn codex_windows(limits: &[Value]) -> (Vec<QuotaWindow>, bool) {
    let mut windows = Vec::new();
    let mut limited = false;
    for limit in limits {
        let id = limit
            .get("limitId")
            .and_then(Value::as_str)
            .unwrap_or("codex");
        // The account-wide limit needs no qualifier; per-model limits name themselves.
        let scope = (id != "codex").then(|| {
            limit
                .get("limitName")
                .and_then(Value::as_str)
                .unwrap_or(id)
                .to_string()
        });
        limited |= limit
            .get("rateLimitReachedType")
            .is_some_and(|v| !v.is_null());
        for slot in ["primary", "secondary"] {
            let Some(w) = limit.get(slot).filter(|w| !w.is_null()) else {
                continue;
            };
            let Some(used_percent) = w.get("usedPercent").and_then(Value::as_f64) else {
                continue;
            };
            windows.push(QuotaWindow {
                id: format!("{id}/{slot}"),
                duration_mins: w.get("windowDurationMins").and_then(Value::as_u64),
                scope: scope.clone(),
                used_percent,
                resets_at: resets_at(w.get("resetsAt")),
            });
        }
    }
    (windows, limited)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn meta(v: Value) -> Meta {
        v.as_object().unwrap().clone()
    }

    fn at(secs: i64) -> Option<DateTime<Utc>> {
        DateTime::from_timestamp(secs, 0)
    }

    /// (window id, duration, scope, used %, reset) for compact comparison.
    type Row = (
        String,
        Option<u64>,
        Option<String>,
        f64,
        Option<DateTime<Utc>>,
    );

    fn rows(q: &AgentQuota) -> Vec<Row> {
        q.windows
            .iter()
            .map(|w| {
                (
                    w.id.clone(),
                    w.duration_mins,
                    w.scope.clone(),
                    w.used_percent,
                    w.resets_at,
                )
            })
            .collect()
    }

    #[test]
    fn maps_each_agents_metadata_onto_quota_windows() {
        let now = Utc::now();
        let row = |id: &str, dur: Option<u64>, scope: Option<&str>, used: f64, reset: i64| -> Row {
            (id.into(), dur, scope.map(String::from), used, at(reset))
        };
        let cases: Vec<(&str, Value, Option<(Vec<Row>, bool)>)> = vec![
            (
                "claude unified windows, shortest first, ms resets normalized",
                json!({"_claude/rateLimit": {
                    "status": "allowed", "rateLimitType": "five_hour",
                    "unifiedWindows": {
                        "seven_day_opus": {"utilization": 0.5, "resetsAt": 1_790_812_800_000_i64},
                        "seven_day": {"utilization": 0.25, "resetsAt": 1_790_812_800},
                        "five_hour": {"utilization": 0.62, "resetsAt": 1_790_396_400}
                    }
                }}),
                Some((
                    vec![
                        row("five_hour", Some(300), None, 62.0, 1_790_396_400),
                        row("seven_day", Some(WEEK_MINS), None, 25.0, 1_790_812_800),
                        row(
                            "seven_day_opus",
                            Some(WEEK_MINS),
                            Some("Opus"),
                            50.0,
                            1_790_812_800,
                        ),
                    ],
                    false,
                )),
            ),
            (
                "claude single window, rejected",
                json!({"_claude/rateLimit": {
                    "status": "rejected", "rateLimitType": "five_hour",
                    "utilization": 1.0, "resetsAt": 1_790_396_400
                }}),
                Some((
                    vec![row("five_hour", Some(300), None, 100.0, 1_790_396_400)],
                    true,
                )),
            ),
            (
                "codex: account limit unscoped, per-model limit scoped, reached flag",
                json!({"_codex/rateLimits": [
                    {"limitId": "codex", "limitName": null,
                     "primary": {"usedPercent": 41.0, "windowDurationMins": 300, "resetsAt": 1_790_396_400},
                     "secondary": {"usedPercent": 12.5, "windowDurationMins": 10080, "resetsAt": 1_790_812_800},
                     "rateLimitReachedType": null},
                    {"limitId": "codex_bengal", "limitName": "GPT-6 Astra",
                     "primary": {"usedPercent": 100.0, "windowDurationMins": 300, "resetsAt": null},
                     "secondary": null,
                     "rateLimitReachedType": "primary"}
                ]}),
                Some((
                    vec![
                        row("codex/primary", Some(300), None, 41.0, 1_790_396_400),
                        row("codex/secondary", Some(10080), None, 12.5, 1_790_812_800),
                        (
                            "codex_bengal/primary".into(),
                            Some(300),
                            Some("GPT-6 Astra".into()),
                            100.0,
                            None,
                        ),
                    ],
                    true,
                )),
            ),
            (
                "claude status without any utilization",
                json!({"_claude/rateLimit": {"status": "allowed", "resetsAt": 1_790_396_400}}),
                None,
            ),
            (
                "unrelated metadata",
                json!({"_claude/model": "claude-opus-5-5"}),
                None,
            ),
        ];
        for (name, raw, want) in cases {
            let got = quota_from_meta(Some(&meta(raw)), now);
            assert_eq!(got.as_ref().map(|q| (rows(q), q.limited)), want, "{name}");
            if let Some(q) = got {
                assert_eq!(q.observed_at, now, "{name}");
            }
        }
        assert!(quota_from_meta(None, now).is_none());
    }
}
