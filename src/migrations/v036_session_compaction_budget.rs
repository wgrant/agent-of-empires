//! The optional session budget defaults to the harness's existing policy.

pub fn run() -> anyhow::Result<()> {
    tracing::info!(target: "migrations", "v036: per-session compaction budgets; existing sessions retain their defaults");
    Ok(())
}
