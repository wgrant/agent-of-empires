//! Live transcript folds for the sessions someone is reading, fed as events
//! are recorded. A replay page or a connect reads the rows its range changed
//! instead of folding the whole log again.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};

use super::EventStore;
use crate::acp::state::Event;
use crate::acp::transcript::{TranscriptDelta, TranscriptModel, TranscriptRow};

/// How long a fold nobody holds stays for a reader to come back to.
const IDLE_GRACE: Duration = Duration::from_secs(10 * 60);
/// The most row bytes kept in folds nobody holds; the least recently used go first.
const IDLE_BYTES_CAP: usize = 512 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Touch {
    Append,
    Patch,
    Remove,
}

/// The rows a range of events appended, patched or removed, as the fold now
/// holds them.
#[derive(Debug, Default)]
pub struct RowChanges {
    /// In transcript order, each with whether the range created it.
    pub rows: Vec<(TranscriptRow, bool)>,
    /// Sorted.
    pub removed: Vec<String>,
    /// The last seq the fold had applied.
    pub through: u64,
}

#[derive(Default)]
struct Fold {
    model: TranscriptModel,
    /// Each row change, in seq order.
    touches: Vec<(u64, Touch, String)>,
}

impl Fold {
    fn apply(&mut self, seq: u64, event: &Event, at: DateTime<Utc>) {
        for delta in self.model.apply_event_at(seq, event, at) {
            let (touch, id) = match delta {
                TranscriptDelta::Append(row) => (Touch::Append, row.id),
                TranscriptDelta::Patch { id, .. } => (Touch::Patch, id),
                TranscriptDelta::Remove(id) => (Touch::Remove, id),
            };
            self.touches.push((seq, touch, id));
        }
    }

    /// The net changes of the events in `(after, through]`.
    fn changes(&self, after: u64, through: u64) -> RowChanges {
        let start = self.touches.partition_point(|(seq, ..)| *seq <= after);
        let end = self.touches.partition_point(|(seq, ..)| *seq <= through);
        let mut changed = HashSet::new();
        let mut appended = HashSet::new();
        let mut removed = HashSet::new();
        for (_, touch, id) in &self.touches[start..end.max(start)] {
            let id = id.as_str();
            if *touch == Touch::Remove {
                changed.remove(id);
                appended.remove(id);
                removed.insert(id);
            } else {
                removed.remove(id);
                changed.insert(id);
                if *touch == Touch::Append {
                    appended.insert(id);
                }
            }
        }
        let mut positions: Vec<usize> = changed
            .iter()
            .filter_map(|id| self.model.position(id))
            .collect();
        positions.sort_unstable();
        let rows = positions
            .into_iter()
            .map(|index| {
                let row = self.model.rows()[index].clone();
                let created = appended.contains(row.id.as_str());
                (row, created)
            })
            .collect();
        let mut removed: Vec<String> = removed.into_iter().map(str::to_owned).collect();
        removed.sort();
        RowChanges {
            rows,
            removed,
            through: self.model.last_seq().min(through),
        }
    }
}

#[derive(Default)]
struct Usage {
    holders: usize,
    last_used: Option<Instant>,
}

#[derive(Default)]
struct Slot {
    fold: Mutex<Option<Fold>>,
    /// Serialises building the fold, so concurrent readers fold the log once.
    building: Mutex<()>,
    usage: Mutex<Usage>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Folds of the sessions being read. `usage` and `fold` are never held together.
#[derive(Default)]
pub(super) struct TranscriptCache {
    slots: Mutex<HashMap<String, Arc<Slot>>>,
}

/// Keeps a session's fold while a reader, such as an open connection, holds it.
pub struct TranscriptHold {
    slot: Arc<Slot>,
}

impl Drop for TranscriptHold {
    fn drop(&mut self) {
        let mut usage = lock(&self.slot.usage);
        usage.holders = usage.holders.saturating_sub(1);
        usage.last_used = Some(Instant::now());
    }
}

impl TranscriptCache {
    fn slot(&self, session_id: &str) -> Option<Arc<Slot>> {
        lock(&self.slots).get(session_id).cloned()
    }

    fn slot_or_create(&self, session_id: &str) -> Arc<Slot> {
        Arc::clone(lock(&self.slots).entry(session_id.to_owned()).or_default())
    }

    /// Fold a just-recorded event into the session's fold, if it has one.
    pub(super) fn observe(&self, session_id: &str, seq: u64, event: &Event, at: DateTime<Utc>) {
        let Some(slot) = self.slot(session_id) else {
            return;
        };
        if is_expired(&lock(&slot.usage), Instant::now()) {
            *lock(&slot.fold) = None;
            return;
        }
        let mut fold = lock(&slot.fold);
        let Some(current) = fold.as_mut() else {
            return;
        };
        let last = current.model.last_seq();
        if seq <= last {
            return;
        }
        if seq != last + 1 {
            // A missed event: the next read builds the fold again.
            *fold = None;
            return;
        }
        current.apply(seq, event, at);
    }

    pub(super) fn forget(&self, session_id: &str) {
        if let Some(slot) = self.slot(session_id) {
            *lock(&slot.fold) = None;
        }
    }

    fn hold(&self, session_id: &str) -> TranscriptHold {
        let slot = self.slot_or_create(session_id);
        {
            let mut usage = lock(&slot.usage);
            usage.holders += 1;
            usage.last_used = Some(Instant::now());
        }
        self.sweep();
        TranscriptHold { slot }
    }

    /// Drops expired folds nobody holds, then the least recently used idle
    /// ones past the byte cap.
    fn sweep(&self) {
        let now = Instant::now();
        let slots: Vec<(String, Arc<Slot>)> = lock(&self.slots)
            .iter()
            .map(|(id, slot)| (id.clone(), Arc::clone(slot)))
            .collect();
        let mut idle = Vec::new();
        for (id, slot) in slots {
            let (holders, last_used, expired) = {
                let usage = lock(&slot.usage);
                (usage.holders, usage.last_used, is_expired(&usage, now))
            };
            if holders > 0 {
                continue;
            }
            if expired {
                *lock(&slot.fold) = None;
                let mut map = lock(&self.slots);
                // Only if nobody took it up since.
                if map.get(&id).is_some_and(|s| Arc::ptr_eq(s, &slot))
                    && Arc::strong_count(&slot) <= 2
                {
                    map.remove(&id);
                }
                continue;
            }
            idle.push((last_used, slot));
        }
        idle.sort_by_key(|(last_used, _)| std::cmp::Reverse(*last_used));
        let mut kept = 0;
        for (_, slot) in idle {
            let mut fold = lock(&slot.fold);
            kept += fold.as_ref().map_or(0, |f| f.model.approx_bytes());
            if kept > IDLE_BYTES_CAP {
                *fold = None;
            }
        }
    }
}

fn is_expired(usage: &Usage, now: Instant) -> bool {
    usage.holders == 0
        && usage
            .last_used
            .is_some_and(|at| now.duration_since(at) > IDLE_GRACE)
}

impl EventStore {
    /// Keep the session's fold while the returned hold lives.
    pub fn hold_transcript(&self, session_id: &str) -> TranscriptHold {
        self.transcripts.hold(session_id)
    }

    /// The rows the events in `(after, through]` changed, as the session's
    /// transcript now holds them. Folds the log first if the session has no
    /// fold, so call it off the async runtime.
    pub fn transcript_changes(
        &self,
        session_id: &str,
        after: u64,
        through: Option<u64>,
    ) -> RowChanges {
        let slot = self.transcripts.slot_or_create(session_id);
        self.build_fold(session_id, &slot);
        let changes = lock(&slot.fold)
            .as_ref()
            .map(|fold| fold.changes(after, through.unwrap_or(u64::MAX)))
            .unwrap_or_default();
        lock(&slot.usage).last_used = Some(Instant::now());
        self.transcripts.sweep();
        changes
    }

    /// [`Self::transcript_changes`] through the latest event, or `None` when the
    /// session has no fold to read without folding the log.
    pub fn transcript_changes_if_folded(&self, session_id: &str, after: u64) -> Option<RowChanges> {
        let slot = self.transcripts.slot(session_id)?;
        let fold = lock(&slot.fold);
        Some(fold.as_ref()?.changes(after, u64::MAX))
    }

    fn build_fold(&self, session_id: &str, slot: &Slot) {
        if lock(&slot.fold).is_some() {
            return;
        }
        let _building = lock(&slot.building);
        if lock(&slot.fold).is_some() {
            return;
        }
        let mut fold = Fold::default();
        for e in self.replay_recorded_from(session_id, 0) {
            fold.apply(e.seq, &e.event, e.recorded_at);
        }
        let mut installed = lock(&slot.fold);
        // Events recorded meanwhile found no fold to join; `record` takes this
        // lock only after releasing the connection, so reading here is safe.
        for e in self.replay_recorded_from(session_id, fold.model.last_seq()) {
            fold.apply(e.seq, &e.event, e.recorded_at);
        }
        *installed = Some(fold);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::event_store::test_support::{agent_chunk, open_store, user_prompt};

    fn ids(changes: &RowChanges) -> Vec<(&str, bool)> {
        changes
            .rows
            .iter()
            .map(|(row, created)| (row.id.as_str(), *created))
            .collect()
    }

    /// A range's changes are net and current, whether the fold was built from
    /// the log or kept up as events were recorded.
    #[test]
    fn changes_cover_a_range_as_the_fold_now_holds_it() {
        let (_tmp, store) = open_store(1000);
        store.record("s", 1, &user_prompt("go")).unwrap();
        store.record("s", 2, &agent_chunk("Hel")).unwrap();
        // Built from the log on first read.
        let first = store.transcript_changes("s", 0, None);
        assert_eq!(ids(&first), [("user-seq-1", true), ("msg-2", true)]);
        assert_eq!(first.through, 2);
        // Kept up as events are recorded from then on.
        store.record("s", 3, &agent_chunk("lo")).unwrap();
        let later = store.transcript_changes_if_folded("s", 2).expect("folded");
        assert_eq!(ids(&later), [("msg-2", false)]);
        assert_eq!(later.rows[0].0.text, "Hello");
        assert_eq!(later.through, 3);
        // An earlier range returns the row as it is now.
        let early = store.transcript_changes("s", 1, Some(2));
        assert_eq!(early.rows[0].0.text, "Hello");
        assert_eq!(early.through, 2);
        assert!(store.transcript_changes("s", 3, None).rows.is_empty());
    }

    /// A gap in the recorded seqs drops the fold, and the next read rebuilds
    /// it from the log; deleting the session drops it too.
    #[test]
    fn a_missed_event_or_a_deleted_log_rebuilds_the_fold() {
        let (_tmp, store) = open_store(1000);
        store.record("s", 1, &user_prompt("go")).unwrap();
        store.transcript_changes("s", 0, None);
        store.record_at("s", 2, &agent_chunk("missed"), 2).unwrap();
        store.record("s", 3, &agent_chunk(" and found")).unwrap();
        assert!(store.transcript_changes_if_folded("s", 0).is_none());
        let rebuilt = store.transcript_changes("s", 0, None);
        assert_eq!(rebuilt.rows[1].0.text, "missed and found");

        store.delete_session("s");
        assert!(store.transcript_changes_if_folded("s", 0).is_none());
        store.record("s", 1, &user_prompt("again")).unwrap();
        assert_eq!(
            ids(&store.transcript_changes("s", 0, None)),
            [("user-seq-1", true)]
        );
    }

    /// A held fold outlives the idle grace; an unheld one past it goes.
    #[test]
    fn only_folds_nobody_holds_expire() {
        let (_tmp, store) = open_store(1000);
        store.record("held", 1, &user_prompt("a")).unwrap();
        store.record("idle", 1, &user_prompt("b")).unwrap();
        let hold = store.hold_transcript("held");
        store.transcript_changes("held", 0, None);
        store.transcript_changes("idle", 0, None);
        let long_ago = Instant::now()
            .checked_sub(IDLE_GRACE + Duration::from_secs(1))
            .expect("clock far enough past boot");
        for id in ["held", "idle"] {
            lock(&store.transcripts.slot(id).unwrap().usage).last_used = Some(long_ago);
        }
        store.transcripts.sweep();
        assert!(store.transcript_changes_if_folded("held", 0).is_some());
        assert!(store.transcript_changes_if_folded("idle", 0).is_none());
        drop(hold);
    }
}
