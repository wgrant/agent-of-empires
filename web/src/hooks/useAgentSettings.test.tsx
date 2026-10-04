// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentSettingsSnapshot } from "../lib/agentSettings";
import { readLaunchIntent } from "../lib/agentSettingsIntent";
import { useAgentSettings } from "./useAgentSettings";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const snapshot: AgentSettingsSnapshot = {
  agent: "opencode",
  running: true,
  starting: false,
  mode_id: null,
  selectors: [],
  config_options: [],
  yolo_mode: { enabled: false, applied_known: false, applied_enabled: null },
  auto_compaction: { tokens: null, bounds: [100000, 1000000], applied_known: false, applied_tokens: null },
};
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

it("retains explicit resets across reloads and clears them only on confirmed application", async () => {
  let current = structuredClone(snapshot);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => (init?.method === "PATCH" ? response({}) : response(current))),
  );
  const first = renderHook(() => useAgentSettings("one", false));
  await waitFor(() => expect(first.result.current.snapshot).not.toBeNull());
  await act(() => first.result.current.save({ auto_compaction: { tokens: null }, yolo_mode: false, restart: false }));
  expect(first.result.current.launchIntent).toEqual({ auto_compaction: { tokens: null }, yolo_mode: false });
  first.unmount();
  const second = renderHook(() => useAgentSettings("one", false));
  await waitFor(() =>
    expect(second.result.current.launchIntent).toEqual({ auto_compaction: { tokens: null }, yolo_mode: false }),
  );
  second.unmount();
  current = {
    ...current,
    yolo_mode: { ...current.yolo_mode, applied_known: true, applied_enabled: false },
    auto_compaction: { ...current.auto_compaction, applied_known: true, applied_tokens: null },
  };
  const third = renderHook(() => useAgentSettings("one", false));
  await waitFor(() => expect(third.result.current.snapshot).not.toBeNull());
  expect(third.result.current.launchIntent).toEqual({});
  expect(readLaunchIntent("one", "opencode")).toEqual({});
});

it("keeps successful saves pending in memory when browser storage is full", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => (init?.method === "PATCH" ? response({}) : response(snapshot))),
  );
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Full", "QuotaExceededError");
  });
  const hook = renderHook(() => useAgentSettings("one", false));
  await waitFor(() => expect(hook.result.current.snapshot).not.toBeNull());
  await act(() => hook.result.current.save({ auto_compaction: { tokens: null }, restart: false }));
  expect(hook.result.current.launchIntent).toEqual({ auto_compaction: { tokens: null } });
  expect(hook.result.current.error).toBeNull();
});

it("ignores a stale poll that completes after a saved value has been read back", async () => {
  let poll: () => void = () => {};
  const interval = window.setInterval.bind(window);
  vi.spyOn(window, "setInterval").mockImplementation((handler, delay) => {
    if (delay === 5000 && typeof handler === "function") poll = () => handler();
    return interval(handler, delay);
  });
  let resolveStale: (response: Response) => void = () => {};
  const stale = new Promise<Response>((resolve) => {
    resolveStale = resolve;
  });
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) =>
    init?.method === "PATCH" ? response({}) : response(snapshot),
  );
  vi.stubGlobal("fetch", fetchMock);
  const hook = renderHook(() => useAgentSettings("one", false));
  await waitFor(() => expect(hook.result.current.snapshot).not.toBeNull());
  fetchMock.mockImplementationOnce(() => stale);
  act(() => poll());
  const saved = { ...snapshot, auto_compaction: { ...snapshot.auto_compaction, tokens: 200000 } };
  fetchMock.mockImplementation(async (_url, init) => (init?.method === "PATCH" ? response({}) : response(saved)));
  await act(() => hook.result.current.save({ auto_compaction: { tokens: 200000 }, restart: false }));
  await act(async () => {
    resolveStale(response(snapshot));
    await stale;
  });
  expect(hook.result.current.snapshot?.auto_compaction.tokens).toBe(200000);
});
