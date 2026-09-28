// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useSessions } from "./useSessions";
import * as api from "../lib/api";

describe("useSessions / loaded sentinel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts loaded=false before the first fetch resolves", () => {
    let resolveFetch: (value: api.SessionsEnvelope | null) => void = () => {};
    vi.spyOn(api, "fetchSessions").mockImplementation(() => new Promise((r) => (resolveFetch = r)));

    const { result } = renderHook(() => useSessions());

    expect(result.current.loaded).toBe(false);
    expect(result.current.sessions).toEqual([]);
    resolveFetch(null);
  });

  it.each([
    ["a successful fetch", { sessions: [], workspace_ordering: [] }, false],
    ["a failed fetch", null, true],
  ] as [string, api.SessionsEnvelope | null, boolean][])(
    "flips loaded=true after %s",
    async (_label, envelope, error) => {
      vi.spyOn(api, "fetchSessions").mockResolvedValue(envelope);
      const { result } = renderHook(() => useSessions());
      await waitFor(() => expect(result.current.loaded).toBe(true));
      expect(result.current.error).toBe(error);
    },
  );
});

describe("useSessions / a session this client created", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("survives a poll that began before it existed, and is listed once when the server has it", async () => {
    vi.useFakeTimers();
    const session = (id: string) => ({ id, title: id }) as unknown as api.SessionsEnvelope["sessions"][number];
    let resolveStale: (value: api.SessionsEnvelope | null) => void = () => {};
    const fetchSessions = vi
      .spyOn(api, "fetchSessions")
      .mockImplementationOnce(() => new Promise((r) => (resolveStale = r)));
    const { result } = renderHook(() => useSessions());

    act(() => result.current.injectSession(session("new")));
    await act(async () => resolveStale({ sessions: [session("old")], workspace_ordering: [] }));
    expect(result.current.sessions.map((s) => s.id)).toEqual(["new", "old"]);

    fetchSessions.mockResolvedValue({ sessions: [session("new"), session("old")], workspace_ordering: [] });
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(result.current.sessions.map((s) => s.id)).toEqual(["new", "old"]);
  });
});
