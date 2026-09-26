// @vitest-environment jsdom
//
// User stories (#2800): hovering the composer usage indicator must explain
// what the numbers mean, not just restate them. The token figure is current
// context-window usage; the dollar amount is cumulative session spend since
// the last /clear or /compact. When the agent reports no cost, the tooltip
// explains context usage and omits the cost sentence.
//
// The indicator lives in UsageHint (Composer.tsx) wrapped in the shared
// <Tooltip>, so hovering the trigger reveals the explanatory text.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AssistantRuntimeProvider, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";

import { Composer } from "./Composer";
import type { AgentQuota, SessionUsage } from "../../lib/acpTypes";

function Harness({ usage, quota = null }: { usage: SessionUsage | null; quota?: AgentQuota | null }) {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: [],
    isRunning: false,
    convertMessage: (m) => m,
    onNew: async () => {},
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Composer
        sessionId="sess-usage"
        currentAgent="claude"
        availableModes={[]}
        currentModeId={null}
        legacyMode="Default"
        configOptions={[]}
        pendingConfigOption={null}
        setConfigOption={() => {}}
        sessionUsage={usage}
        quota={quota}
        availableCommands={[]}
        availability={{ kind: "send_now" }}
        turnActive={false}
        queuedCount={0}
        enqueuePrompt={() => {}}
        promptCapabilities={null}
        pendingAttachments={[]}
        setPendingAttachments={() => {}}
        queuedPrompts={[]}
        editQueuedPrompt={() => {}}
      />
    </AssistantRuntimeProvider>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ files: [] }),
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("composer usage indicator tooltip", () => {
  it("explains context-window usage and cumulative cost on hover", () => {
    render(<Harness usage={{ used: 120_000, size: 200_000, cost: { amount: 0.42, currency: "USD" } }} />);
    // aria-label carries the same explanation for screen readers; use it to
    // locate the trigger, then hover its Tooltip wrapper (the parent span).
    const indicator = screen.getAllByLabelText(/Context window:/)[0]!;
    fireEvent.mouseEnter(indicator.parentElement!);

    const tip = screen.getByRole("tooltip").textContent ?? "";
    expect(tip).toContain(`${(120_000).toLocaleString()} of ${(200_000).toLocaleString()} tokens used (60%)`);
    expect(tip).toContain("The color warms as the window fills.");
    expect(tip).toContain("cumulative session spend since the last /clear or /compact");
  });

  it("omits the cost sentence when the agent reports no cost", () => {
    render(<Harness usage={{ used: 50_000, size: 200_000, cost: null }} />);
    const indicator = screen.getAllByLabelText(/Context window:/)[0]!;
    fireEvent.mouseEnter(indicator.parentElement!);

    const tip = screen.getByRole("tooltip").textContent ?? "";
    expect(tip).toContain(`${(50_000).toLocaleString()} of ${(200_000).toLocaleString()} tokens used (25%)`);
    expect(tip).not.toContain("cumulative session spend");
  });

  it("shows plan quota instead of cost and moves the cost into the tooltip", () => {
    const soon = (mins: number) => new Date(Date.now() + mins * 60_000).toISOString();
    render(
      <Harness
        usage={{ used: 50_000, size: 200_000, cost: { amount: 39.26, currency: "USD" } }}
        quota={{
          windows: [
            { id: "five_hour", duration_mins: 300, used_percent: 91.5, resets_at: soon(37) },
            { id: "seven_day", duration_mins: 10080, used_percent: 7, resets_at: soon(60 * 24 * 5) },
            { id: "seven_day_opus", duration_mins: 10080, scope: "Opus", used_percent: 50, resets_at: soon(60) },
          ],
          limited: false,
          observed_at: new Date().toISOString(),
        }}
      />,
    );
    const usage = screen.getAllByTestId("composer-usage")[0]!;
    const windows = screen.getAllByTestId("composer-quota-window").filter((w) => usage.contains(w));
    expect(windows.map((w) => w.textContent)).toEqual(["· 5h 92%", "· 7d 7%"]);
    expect(windows[0]!.className).toContain("text-rose-400");
    expect(usage.textContent).not.toContain("$");

    fireEvent.mouseEnter(usage.parentElement!);
    const tip = screen.getByRole("tooltip").textContent ?? "";
    // The clock ticks by the minute, so the countdown can read a minute long.
    expect(tip).toMatch(/5h: 92% used, resets .+ \(in 3[78]m\)/);
    expect(tip).toContain("Opus 7d: 50% used");
    expect(tip).toContain("Plan usage as of just now");
    expect(tip).toContain("cumulative session spend");
  });
});
