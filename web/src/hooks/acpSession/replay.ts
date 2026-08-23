// REST replay of ACP history: recent-first cold open, forward top-up, and older pages.

import type { AcpFrame, TranscriptRow } from "../../lib/acpTypes";
import { toActivityRows, type Action } from "./reducer";

// Re-request this many seqs behind lastSeq; the reducer's seq dedupe makes the overlap idempotent.
const REPLAY_OVERLAP = 50;
const REPLAY_PAGE_SIZE = 1000;
// Above every real seq, so `before=` returns the newest page.
const TAIL_BEFORE = Number.MAX_SAFE_INTEGER;
// The handshake lands in the first few events of a session.
const HANDSHAKE_PREFIX_SIZE = 50;

/** `acp/replay` response; `rows` is set (and `frames` empty) only for `view=rows`. */
type ReplayPageResponse = {
  frames: AcpFrame[];
  rows?: TranscriptRow[] | null;
  lost: boolean;
  highest_seq: number;
  next_cursor?: number | null;
  has_more?: boolean;
};

type Dispatch = (action: Action) => void;

export interface TransportDiagnostic {
  kind: "replay_http" | "replay_network" | "websocket_close" | "websocket_opaque" | "stale_heartbeat";
  text: string;
  at: number;
}

const getReplay = (sid: string, params: string): Promise<Response> =>
  fetch(`/api/sessions/${encodeURIComponent(sid)}/acp/replay?${params}`, { credentials: "same-origin" });

// The frames leg feeds control state the daemon doesn't model; `view=rows` feeds the transcript.
const getReplayPair = (sid: string, params: string): Promise<[Response, Response]> =>
  Promise.all([getReplay(sid, params), getReplay(sid, `${params}&view=rows`)]);

const readRows = async (res: Response): Promise<TranscriptRow[]> =>
  ((await res.json()) as ReplayPageResponse).rows ?? [];

/** Catch up from `lastSeq.current`, updating it on a cold open. Errors are swallowed; a later lagged notice retries. */
export async function fetchReplay(
  sid: string,
  lastSeq: { current: number },
  dispatch: Dispatch,
  setHasMoreOlder: (value: boolean) => void,
  setLastTransportDiagnostic?: (value: TransportDiagnostic) => void,
): Promise<void> {
  try {
    if (lastSeq.current === 0) {
      await fetchTail(sid, lastSeq, dispatch, setHasMoreOlder, setLastTransportDiagnostic);
    } else {
      await fetchForward(sid, lastSeq, dispatch, setLastTransportDiagnostic);
    }
  } catch {
    setLastTransportDiagnostic?.({
      kind: "replay_network",
      text: "Replay request failed: network error.",
      at: Date.now(),
    });
  }
}

async function fetchTail(
  sid: string,
  lastSeq: { current: number },
  dispatch: Dispatch,
  setHasMoreOlder: (value: boolean) => void,
  setLastTransportDiagnostic?: (value: TransportDiagnostic) => void,
): Promise<void> {
  const [tailRes, tailRowsRes] = await getReplayPair(sid, `before=${TAIL_BEFORE}&limit=${REPLAY_PAGE_SIZE}`);
  if (!tailRes.ok || !tailRowsRes.ok) {
    const failed = !tailRes.ok ? tailRes : tailRowsRes;
    setLastTransportDiagnostic?.({
      kind: "replay_http",
      text: `Replay request rejected: HTTP ${failed.status}${failed.statusText ? ` ${failed.statusText}` : ""}.`,
      at: Date.now(),
    });
    return;
  }
  const tail = (await tailRes.json()) as ReplayPageResponse;
  if (tail.lost) {
    dispatch({ kind: "lagged", skipped: tail.highest_seq });
    return;
  }
  const rows = toActivityRows(await readRows(tailRowsRes), sid);
  dispatch({ kind: "frames", frames: tail.frames ?? [], rows, oldestSeq: tail.next_cursor ?? 0 });
  setHasMoreOlder(tail.has_more ?? false);
  if (tail.highest_seq > lastSeq.current) lastSeq.current = tail.highest_seq;
  if ((tail.has_more ?? false) && (tail.next_cursor ?? 0) > 1) {
    const hsRes = await getReplay(sid, `since=0&limit=${HANDSHAKE_PREFIX_SIZE}`);
    if (hsRes.ok) {
      const hs = (await hsRes.json()) as ReplayPageResponse;
      if ((hs.frames ?? []).length > 0) dispatch({ kind: "handshake", frames: hs.frames });
    }
  }
  dispatch({ kind: "lagged_resolved" });
}

async function fetchForward(
  sid: string,
  lastSeq: { current: number },
  dispatch: Dispatch,
  setLastTransportDiagnostic?: (value: TransportDiagnostic) => void,
): Promise<void> {
  const firstSince = Math.max(0, lastSeq.current - REPLAY_OVERLAP);
  let cursor = firstSince;
  let target: number | null = null;
  const bufferedFrames: AcpFrame[] = [];
  const bufferedRows = [] as ReturnType<typeof toActivityRows>;
  let reset = false;
  for (;;) {
    const [res, rowsRes] = await getReplayPair(sid, `since=${cursor}&limit=${REPLAY_PAGE_SIZE}`);
    if (!res.ok || !rowsRes.ok) {
      const failed = !res.ok ? res : rowsRes;
      setLastTransportDiagnostic?.({
        kind: "replay_http",
        text: `Replay request rejected: HTTP ${failed.status}${failed.statusText ? ` ${failed.statusText}` : ""}.`,
        at: Date.now(),
      });
      return;
    }
    const data = (await res.json()) as ReplayPageResponse;
    const pageRows = await readRows(rowsRes);
    if (target === null) {
      target = data.highest_seq;
      // The server's log is behind our cursor (e.g. it was reset), so start over.
      if (data.highest_seq < firstSince) reset = true;
    }
    if (data.lost) {
      dispatch({ kind: "lagged", skipped: data.highest_seq });
      return;
    }
    if (data.frames.length > 0 || pageRows.length > 0) {
      bufferedFrames.push(...data.frames);
      bufferedRows.push(...toActivityRows(pageRows, sid));
    }
    const next = data.next_cursor;
    if (!(data.has_more && next != null && next > cursor && next < target)) break;
    cursor = next;
  }
  dispatch({ kind: "catchup", frames: bufferedFrames, rows: bufferedRows, reset });
  if (reset) {
    lastSeq.current = bufferedFrames.reduce((highest, frame) => Math.max(highest, frame.seq), 0);
  } else if (target !== null) {
    lastSeq.current = target;
  }
}

/** Fetch the page below `before`. Returns whether more older history remains, or null on failure. */
export async function fetchOlderPage(sid: string, before: number, dispatch: Dispatch): Promise<boolean | null> {
  let cursor = before;
  for (;;) {
    const res = await getReplay(sid, `before=${cursor}&limit=${REPLAY_PAGE_SIZE}&view=rows`);
    if (!res.ok) return null;
    const data = (await res.json()) as ReplayPageResponse;
    const next = data.next_cursor ?? cursor;
    const rows = toActivityRows(data.rows ?? [], sid);
    if (rows.length > 0 || !data.has_more || next >= cursor) {
      dispatch({ kind: "prepend", rows, oldestSeq: next });
      return (data.has_more ?? false) && next < cursor;
    }
    cursor = next;
  }
}
