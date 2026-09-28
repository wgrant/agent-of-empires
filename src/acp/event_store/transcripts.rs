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
/// How often reads look for folds to drop.
const SWEEP_INTERVAL: Duration = Duration::from_secs(5);

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
    /// Each row change, in seq order. A run of patches to one row, such as a
    /// streamed reply, keeps one entry at its latest seq.
    touches: Vec<(u64, Touch, String)>,
    /// Bytes measured at a seq, reused until the fold moves on.
    size: Option<(u64, usize)>,
}

impl Fold {
    fn apply(&mut self, seq: u64, event: &Event, at: DateTime<Utc>) {
        for delta in self.model.apply_event_at(seq, event, at) {
            let (touch, id) = match delta {
                TranscriptDelta::Append(row) => (Touch::Append, row.id),
                TranscriptDelta::Patch { id, .. } => (Touch::Patch, id),
                TranscriptDelta::Remove(id) => (Touch::Remove, id),
            };
            match self.touches.last_mut() {
                // A later range still sees the patch; an earlier one never
                // needed the row at a version older than now.
                Some(last) if touch == Touch::Patch && last.1 == Touch::Patch && last.2 == id => {
                    last.0 = seq;
                }
                _ => self.touches.push((seq, touch, id)),
            }
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

    /// Roughly how much memory the fold holds, its rows and its change log.
    fn bytes(&mut self) -> usize {
        let seq = self.model.last_seq();
        if let Some((_, bytes)) = self.size.filter(|(at, _)| *at == seq) {
            return bytes;
        }
        let touches: usize = self
            .touches
            .iter()
            .map(|(_, _, id)| std::mem::size_of::<(u64, Touch, String)>() + id.len())
            .sum();
        let bytes = self.model.approx_bytes() + touches;
        self.size = Some((seq, bytes));
        bytes
    }
}

#[derive(Default)]
struct Held {
    fold: Option<Fold>,
    /// Bumped when the log is deleted, so a build that read the old log is
    /// discarded rather than installed over the new one.
    epoch: u64,
}

#[derive(Default)]
struct Usage {
    holders: usize,
    last_used: Option<Instant>,
}

#[derive(Default)]
struct Slot {
    held: Mutex<Held>,
    /// Serialises building the fold, so concurrent readers fold the log once.
    building: Mutex<()>,
    usage: Mutex<Usage>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Folds of the sessions being read. `usage` and `held` are never held together.
pub(super) struct TranscriptCache {
    slots: Mutex<HashMap<String, Arc<Slot>>>,
    idle_bytes_cap: usize,
    last_sweep: Mutex<Option<Instant>>,
}

impl Default for TranscriptCache {
    fn default() -> Self {
        Self {
            slots: Mutex::default(),
            idle_bytes_cap: IDLE_BYTES_CAP,
            last_sweep: Mutex::default(),
        }
    }
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
            lock(&slot.held).fold = None;
            return;
        }
        let mut held = lock(&slot.held);
        let Some(fold) = held.fold.as_mut() else {
            return;
        };
        let last = fold.model.last_seq();
        // Already folded by a build that read it from the log.
        if seq == last {
            return;
        }
        if seq != last + 1 {
            // Missed events, or a log that restarted: the next read rebuilds.
            held.fold = None;
            return;
        }
        fold.apply(seq, event, at);
    }

    pub(super) fn forget(&self, session_id: &str) {
        if let Some(slot) = self.slot(session_id) {
            let mut held = lock(&slot.held);
            held.fold = None;
            held.epoch += 1;
        }
    }

    fn hold(&self, session_id: &str) -> TranscriptHold {
        let slot = self.slot_or_create(session_id);
        {
            let mut usage = lock(&slot.usage);
            usage.holders += 1;
            usage.last_used = Some(Instant::now());
        }
        TranscriptHold { slot }
    }

    /// [`Self::sweep_now`], at most once per [`SWEEP_INTERVAL`].
    fn sweep(&self) {
        let now = Instant::now();
        {
            let mut last = lock(&self.last_sweep);
            if last.is_some_and(|at| now.duration_since(at) < SWEEP_INTERVAL) {
                return;
            }
            *last = Some(now);
        }
        self.sweep_now();
    }

    /// Drops expired folds nobody holds, then the least recently used idle
    /// ones past the byte cap, always keeping the most recently used.
    fn sweep_now(&self) {
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
                lock(&slot.held).fold = None;
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
        for (index, (_, slot)) in idle.into_iter().enumerate() {
            let mut held = lock(&slot.held);
            kept += held.fold.as_mut().map_or(0, Fold::bytes);
            if index > 0 && kept > self.idle_bytes_cap {
                held.fold = None;
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
        // Most recently used before building, so a sweep keeps what this builds.
        lock(&slot.usage).last_used = Some(Instant::now());
        let changes = {
            let held = self.folded(session_id, &slot);
            let fold = held.fold.as_ref().expect("a fold was just installed");
            fold.changes(after, through.unwrap_or(u64::MAX))
        };
        self.transcripts.sweep();
        changes
    }

    /// [`Self::transcript_changes`] through the latest event, or `None` when the
    /// session has no fold to read without folding the log.
    pub fn transcript_changes_if_folded(&self, session_id: &str, after: u64) -> Option<RowChanges> {
        let slot = self.transcripts.slot(session_id)?;
        let held = lock(&slot.held);
        Some(held.fold.as_ref()?.changes(after, u64::MAX))
    }

    /// The slot's lock with its fold present, building it from the log if not.
    fn folded<'a>(&self, session_id: &str, slot: &'a Slot) -> MutexGuard<'a, Held> {
        {
            let held = lock(&slot.held);
            if held.fold.is_some() {
                return held;
            }
        }
        let _building = lock(&slot.building);
        loop {
            let epoch = {
                let held = lock(&slot.held);
                if held.fold.is_some() {
                    return held;
                }
                held.epoch
            };
            let fold = self.fold_log(session_id);
            if let Some(held) = self.install_fold(session_id, slot, fold, epoch) {
                return held;
            }
        }
    }

    fn fold_log(&self, session_id: &str) -> Fold {
        let mut fold = Fold::default();
        for e in self.replay_recorded_from(session_id, 0) {
            fold.apply(e.seq, &e.event, e.recorded_at);
        }
        fold
    }

    /// Install a fold built from the log at `epoch`, first taking the events
    /// recorded meanwhile, which found no fold to join. `None` if the log was
    /// deleted since. `record` takes this lock only after releasing the
    /// connection, so reading the log while holding it is safe.
    fn install_fold<'a>(
        &self,
        session_id: &str,
        slot: &'a Slot,
        mut fold: Fold,
        epoch: u64,
    ) -> Option<MutexGuard<'a, Held>> {
        let mut held = lock(&slot.held);
        if held.epoch != epoch {
            return None;
        }
        for e in self.replay_recorded_from(session_id, fold.model.last_seq()) {
            fold.apply(e.seq, &e.event, e.recorded_at);
        }
        held.fold = Some(fold);
        Some(held)
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
        store.record("s", 4, &agent_chunk("!")).unwrap();
        let later = store.transcript_changes_if_folded("s", 2).expect("folded");
        assert_eq!(ids(&later), [("msg-2", false)]);
        assert_eq!(later.rows[0].0.text, "Hello!");
        assert_eq!(later.through, 4);
        // An earlier range returns the row as it is now.
        let early = store.transcript_changes("s", 1, Some(2));
        assert_eq!(early.rows[0].0.text, "Hello!");
        assert_eq!(early.through, 2);
        assert!(store.transcript_changes("s", 4, None).rows.is_empty());
        // The streamed reply's patches share one entry.
        let slot = store.transcripts.slot("s").unwrap();
        let touches: Vec<_> = lock(&slot.held).fold.as_ref().unwrap().touches.clone();
        assert_eq!(
            touches,
            [
                (1, Touch::Append, "user-seq-1".to_owned()),
                (2, Touch::Append, "msg-2".to_owned()),
                (4, Touch::Patch, "msg-2".to_owned()),
            ]
        );
    }

    /// A gap, a restarted log, or a deleted one drops the fold, and the next
    /// read rebuilds it from the log.
    #[test]
    fn a_missed_event_or_a_new_log_rebuilds_the_fold() {
        let (_tmp, store) = open_store(1000);
        store.record("s", 1, &user_prompt("go")).unwrap();
        store.transcript_changes("s", 0, None);
        store.record_at("s", 2, &agent_chunk("missed"), 2).unwrap();
        store.record("s", 3, &agent_chunk(" and found")).unwrap();
        assert!(store.transcript_changes_if_folded("s", 0).is_none());
        let rebuilt = store.transcript_changes("s", 0, None);
        assert_eq!(rebuilt.rows[1].0.text, "missed and found");

        // A seq behind the fold means the log started over.
        store.record("t", 5, &user_prompt("old")).unwrap();
        store.transcript_changes("t", 0, None);
        store.record("t", 1, &user_prompt("new")).unwrap();
        assert!(store.transcript_changes_if_folded("t", 0).is_none());

        store.delete_session("s");
        assert!(store.transcript_changes_if_folded("s", 0).is_none());
        store.record("s", 1, &user_prompt("again")).unwrap();
        assert_eq!(
            ids(&store.transcript_changes("s", 0, None)),
            [("user-seq-1", true)]
        );
    }

    /// A build takes the events recorded while it read the log, and is
    /// discarded if the log was deleted meanwhile.
    #[test]
    fn a_build_catches_up_unless_its_log_was_deleted() {
        let (_tmp, store) = open_store(1000);
        store.record("s", 1, &user_prompt("go")).unwrap();
        let slot = store.transcripts.slot_or_create("s");
        let fold = store.fold_log("s");
        // Recorded after the read: no fold yet to join.
        store.record("s", 2, &agent_chunk("late")).unwrap();
        let installed = store.install_fold("s", &slot, fold, 0).expect("same log");
        let rows = installed.fold.as_ref().unwrap().changes(0, u64::MAX);
        assert_eq!(ids(&rows), [("user-seq-1", true), ("msg-2", true)]);
        drop(installed);

        let epoch = lock(&slot.held).epoch;
        let stale = store.fold_log("s");
        store.delete_session("s");
        store.record("s", 1, &user_prompt("fresh")).unwrap();
        assert!(store.install_fold("s", &slot, stale, epoch).is_none());
        let fresh = store.transcript_changes("s", 0, None);
        assert_eq!(fresh.rows[0].0.text, "fresh");
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
        store.transcripts.sweep_now();
        assert!(store.transcript_changes_if_folded("held", 0).is_some());
        assert!(store.transcript_changes_if_folded("idle", 0).is_none());
        drop(hold);
    }

    /// Past the byte cap the least recently used idle folds go, but a read
    /// still gets its rows and the fold it just used stays.
    #[test]
    fn the_byte_cap_keeps_the_most_recent_fold() {
        let (_tmp, mut store) = open_store(1000);
        store.transcripts.idle_bytes_cap = 1;
        for id in ["older", "newer"] {
            store.record(id, 1, &user_prompt(id)).unwrap();
            let changes = store.transcript_changes(id, 0, None);
            assert_eq!(changes.rows.len(), 1, "{id}");
        }
        let earlier = Instant::now()
            .checked_sub(Duration::from_secs(1))
            .expect("clock past boot");
        lock(&store.transcripts.slot("older").unwrap().usage).last_used = Some(earlier);
        store.transcripts.sweep_now();
        assert!(store.transcript_changes_if_folded("older", 0).is_none());
        assert!(store.transcript_changes_if_folded("newer", 0).is_some());
    }
}
