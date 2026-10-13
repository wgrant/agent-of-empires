//! Versions 36 and 37 previously named compaction no-ops on the working branch.

pub fn run() -> anyhow::Result<()> {
    super::v036_session_creation_count::run()?;
    super::v037_trash_lifecycle_id::run()?;
    tracing::info!("v040: reconciled upstream creation counts and trash identities");
    Ok(())
}
