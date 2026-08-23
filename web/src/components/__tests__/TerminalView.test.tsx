// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";

import type { SessionResponse } from "../../lib/types";
import { makeSession as baseSession } from "./fixtures";

// ── Mock the chain of dependencies the component pulls in so the render stops at the early-return without trying
// to mount a real terminal or open a WebSocket.

const ensureSession = vi.fn(async () => ({ ok: true }));
const ensureTerminal = vi.fn(async () => ({ ok: true }));
const mockedContainerRef = { current: null } as const;
const mockedTermRef = { current: null } as const;
const mockedManualReconnect = vi.fn();
const mockedSendData = vi.fn();
const mockedActivate = vi.fn();
const mockedExitScrollback = vi.fn();
const mockedCtrlActiveRef = { current: false };
const mockedClearCtrlRef = { current: null };
vi.mock("../../lib/api", () => ({
  ensureSession: (id: string, signal?: AbortSignal) => ensureSession(id, signal),
  ensureTerminal: (id: string, index?: number, container?: boolean) => ensureTerminal(id, index, container),
  isStartRefusal: (code?: string) => code === "session_archived" || code === "session_trashed",
}));

// The full hook is exercised by useTerminal.lifecycle.test.ts and the Playwright suites.
vi.mock("../../hooks/useTerminal", () => ({
  useTerminal: () => ({
    containerRef: mockedContainerRef,
    termRef: mockedTermRef,
    state: {
      connected: false,
      reconnecting: false,
      retryCount: 0,
      retryCountdown: 0,
      isPrimary: true,
      isInScrollback: false,
    },
    manualReconnect: mockedManualReconnect,
    sendData: mockedSendData,
    activate: mockedActivate,
    exitScrollback: mockedExitScrollback,
    ctrlActiveRef: mockedCtrlActiveRef,
    clearCtrlRef: mockedClearCtrlRef,
    maxRetries: 7,
  }),
}));

vi.mock("../../hooks/useMobileKeyboard", () => ({
  useMobileKeyboard: () => ({
    isMobile: false,
    keyboardOpen: false,
    keyboardHeight: 0,
    keyboardOcclusion: 0,
    stableViewportHeight: 0,
  }),
}));

import { TerminalView } from "../TerminalView";
import { LiveTerminalView } from "../LiveTerminalView";

const makeSession = (overrides: Partial<SessionResponse> = {}) =>
  baseSession({ id: "sess-1", title: "test-session", project_path: "/tmp/test", status: "Running", ...overrides });

afterEach(() => {
  ensureSession.mockReset();
  ensureSession.mockImplementation(async () => ({ ok: true }));
  mockedManualReconnect.mockReset();
  mockedSendData.mockReset();
  mockedActivate.mockReset();
  mockedExitScrollback.mockReset();
  mockedCtrlActiveRef.current = false;
  mockedClearCtrlRef.current = null;
});

describe("TerminalView lifecycle states", () => {
  it("renders the shared starting notice while ensure is pending", () => {
    // Never-resolving promise keeps ensureState at "pending" so the
    // placeholder branch stays mounted.
    ensureSession.mockReturnValue(new Promise(() => {}));
    render(<TerminalView session={makeSession()} />);
    expect(screen.getByTestId("terminal-starting-notice")).toBeDefined();
    expect(screen.getByText("Starting agent")).toBeDefined();
  });

  it("renders the error message + Retry button when ensure rejects", async () => {
    ensureSession.mockResolvedValueOnce({
      ok: false,
      message: "boom",
    });
    render(<TerminalView session={makeSession()} />);
    await waitFor(() => {
      expect(screen.getByText("boom")).toBeDefined();
    });
    expect(screen.getByText("Agent could not start")).toBeDefined();
    const retry = screen.getByRole("button", { name: "Retry start" });
    expect(retry).toBeDefined();
  });

  it("falls back to the generic error copy when ensure omits a message", async () => {
    ensureSession.mockResolvedValueOnce({ ok: false });
    render(<TerminalView session={makeSession()} />);
    await waitFor(() => {
      expect(screen.getByText(/Could not start session/i)).toBeDefined();
    });
  });

  // #4116: an archived or trashed session stays refused, so there is nothing to retry.
  it.each([
    ["agent", ensureSession],
    ["paired-container", ensureTerminal],
  ] as const)("omits Retry when the %s ensure refuses an archived or trashed session", async (surface, ensure) => {
    ensure.mockResolvedValueOnce({
      ok: false,
      error: "session_archived",
      message: "session is archived; unarchive it first",
    });
    render(<LiveTerminalView session={makeSession()} surface={surface} />);
    await waitFor(() => {
      expect(screen.getByText("session is archived; unarchive it first")).toBeDefined();
    });
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("re-runs ensure once a refused session is unarchived", async () => {
    ensureSession.mockResolvedValueOnce({
      ok: false,
      error: "session_archived",
      message: "session is archived; unarchive it first",
    });
    const { rerender } = render(<TerminalView session={makeSession({ archived_at: "2026-01-01T00:00:00Z" })} />);
    await waitFor(() => {
      expect(screen.getByText("session is archived; unarchive it first")).toBeDefined();
    });
    rerender(<TerminalView session={makeSession({ archived_at: null })} />);
    await waitFor(() => {
      expect(screen.queryByText("session is archived; unarchive it first")).toBeNull();
    });
    expect(ensureSession).toHaveBeenCalledTimes(2);
  });

  it("re-runs ensureSession when Retry is clicked", async () => {
    ensureSession.mockResolvedValueOnce({ ok: false, message: "first fail" });
    const { container } = render(<TerminalView session={makeSession()} />);
    await waitFor(() => {
      expect(screen.getByText("first fail")).toBeDefined();
    });
    ensureSession.mockResolvedValueOnce({ ok: false, message: "second fail" });
    // The error branch only ever renders one button.
    const retry = container.querySelector("button");
    if (!retry) throw new Error("no retry button rendered");
    await act(async () => {
      retry.click();
    });
    await waitFor(() => {
      expect(screen.getByText("second fail")).toBeDefined();
    });
    // First call (mount), second call (retry).
    expect(ensureSession).toHaveBeenCalledTimes(2);
  });
});
