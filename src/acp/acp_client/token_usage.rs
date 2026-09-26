//! Token counts from a turn's `PromptResponse`: the ACP `usage` for totals
//! and the `_meta.quota.model_usage` split that claude-agent-acp and codex-acp
//! share.

use agent_client_protocol::schema::v1::PromptResponse;
use serde_json::Value;

use crate::acp::state::{ModelTokenCounts, TokenCounts, TurnTokenUsage};

pub(super) fn turn_token_usage(response: &PromptResponse) -> Option<TurnTokenUsage> {
    let usage = response.usage.as_ref()?;
    let total = TokenCounts {
        input: usage.input_tokens,
        output: usage.output_tokens,
        cache_read: usage.cached_read_tokens,
        cache_write: usage.cached_write_tokens,
    };
    let by_model = response
        .meta
        .as_ref()
        .and_then(|meta| meta.get("quota"))
        .and_then(|quota| quota.get("model_usage"))
        .and_then(Value::as_array)
        .map(|entries| entries.iter().filter_map(model_counts).collect())
        .unwrap_or_default();
    Some(TurnTokenUsage { total, by_model })
}

fn model_counts(entry: &Value) -> Option<ModelTokenCounts> {
    let model = entry.get("model")?.as_str()?.to_string();
    let count = entry.get("token_count")?;
    let n = |key: &str| count.get(key).and_then(Value::as_u64);
    Some(ModelTokenCounts {
        model,
        counts: TokenCounts {
            input: n("inputTokens")?,
            output: n("outputTokens").unwrap_or(0),
            cache_read: n("cachedInputTokens"),
            cache_write: n("cachedWriteTokens"),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn response(v: Value) -> PromptResponse {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn reads_totals_and_the_per_model_split() {
        let r = response(json!({
            "stopReason": "end_turn",
            "usage": {"totalTokens": 1310, "inputTokens": 10, "outputTokens": 300,
                      "cachedReadTokens": 900, "cachedWriteTokens": 100},
            "_meta": {"quota": {"model_usage": [
                {"model": "claude-opus-5-5", "token_count": {"inputTokens": 8, "outputTokens": 250,
                    "cachedInputTokens": 900, "cachedWriteTokens": 100, "totalTokens": 1258}},
                {"model": "claude-haiku-4-5", "token_count": {"inputTokens": 2, "outputTokens": 50}},
                {"model": "broken"}
            ]}}
        }));
        let usage = turn_token_usage(&r).expect("usage");
        assert_eq!(
            usage.total,
            TokenCounts {
                input: 10,
                output: 300,
                cache_read: Some(900),
                cache_write: Some(100)
            }
        );
        let models: Vec<(&str, u64, Option<u64>)> = usage
            .by_model
            .iter()
            .map(|m| (m.model.as_str(), m.counts.output, m.counts.cache_read))
            .collect();
        assert_eq!(
            models,
            [
                ("claude-opus-5-5", 250, Some(900)),
                ("claude-haiku-4-5", 50, None)
            ]
        );

        assert!(turn_token_usage(&response(json!({"stopReason": "end_turn"}))).is_none());
    }
}
