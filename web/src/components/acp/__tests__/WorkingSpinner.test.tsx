// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import { WorkingSpinner } from "../WorkingSpinner";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

interface SpinnerOpts {
  stalledSecs: number;
  tool: string | null;
  thinking?: boolean;
  cancelling?: boolean;
  cancelEscalatesAt?: string | null;
  compacting?: boolean;
  compactionStartedSecsAgo?: number;
}

function renderSpinner(opts: SpinnerOpts) {
  const ref = { current: Date.now() - opts.stalledSecs * 1000 } as React.RefObject<number>;
  render(
    <WorkingSpinner
      thinking={opts.thinking ?? false}
      tool={opts.tool}
      cancelling={opts.cancelling ?? false}
      cancelEscalatesAt={opts.cancelEscalatesAt ?? null}
      compacting={opts.compacting ?? false}
      compactionStartedAt={
        opts.compactionStartedSecsAgo == null
          ? null
          : new Date(Date.now() - opts.compactionStartedSecsAgo * 1000).toISOString()
      }
      lastActivityRef={ref}
    />,
  );
  // One watchdog tick so the label settles.
  act(() => {
    vi.advanceTimersByTime(1100);
  });
}

describe("WorkingSpinner", () => {
  // The label only: stopping lives on the composer's Stop button.
  it.each<[string, SpinnerOpts, RegExp | null]>([
    ["tool past threshold", { stalledSecs: 60, tool: "Write" }, /waiting on tool…/i],
    ["long Task subagent", { stalledSecs: 180, tool: "Task" }, /waiting on tool… 3m \d{2}s/i],
    ["silent model past threshold", { stalledSecs: 60, tool: null }, /waiting on model…/i],
    ["below threshold", { stalledSecs: 5, tool: null }, null],
    // A /compact is silent for minutes; name it from the first tick.
    [
      "compaction past threshold",
      { stalledSecs: 85, tool: null, compacting: true },
      /compaction in progress… 1m \d{2}s/i,
    ],
    ["compaction early", { stalledSecs: 3, tool: null, compacting: true }, /compaction in progress… \ds/i],
    // Timed from when it began, not from the latest activity or this mount.
    [
      "compaction with a recorded start",
      { stalledSecs: 3, tool: null, compacting: true, compactionStartedSecsAgo: 125 },
      /compaction in progress… 2m 0[56]s/i,
    ],
    ["cancel during compaction", { stalledSecs: 85, tool: null, compacting: true, cancelling: true }, /stopping…/i],
    [
      "cancel with an escalation deadline",
      {
        stalledSecs: 1,
        tool: "Terminal",
        cancelling: true,
        cancelEscalatesAt: new Date(Date.now() + 8000).toISOString(),
      },
      /stopping… \(force in \d+s\)/i,
    ],
  ])("%s", (_label, opts, label) => {
    renderSpinner(opts);
    if (label) expect(screen.getByText(label)).toBeTruthy();
    else expect(screen.queryByText(/waiting on (model|tool)…/i)).toBeNull();
    if (!opts.compacting || opts.cancelling) expect(screen.queryByText(/compaction in progress…/i)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
