pub fn run() -> anyhow::Result<()> {
    tracing::info!(target: "migrations", "v039: optional idle compaction; existing sessions remain disabled");
    Ok(())
}
