// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConversationLifecycleNotice } from "./SessionBanners";
import { rateLimitDetail } from "./SystemNotices";
import { composerAvailabilityNoticeLabel } from "./StructuredView";
import type { SessionIncident } from "./status/conversationDiagnostics";

afterEach(cleanup);

describe("ConversationLifecycleNotice", () => {
  it("selects one composer status notice with reconnect precedence", () => {
    const reconnect = {
      kind: "updating",
      cause: "reconnect",
      tone: "progress",
      placement: "composer",
      composer: "queue",
    } as const;
    const idle = { kind: "idle", tone: "neutral", placement: null, composer: "available" } as const;
    const cases = [
      [{ kind: "queue_for_recovery" }, reconnect, "Updating conversation…"],
      [{ kind: "queue_for_recovery" }, idle, "Messages will be queued until the session resumes."],
      [{ kind: "blocked", reason: "failed", action: "retry_start" }, idle, null],
      [{ kind: "send_now" }, idle, null],
      [{ kind: "resume_then_send", reason: "archived" }, idle, null],
      [{ kind: "wake_agent" }, idle, null],
    ] as const;
    for (const [availability, status, expected] of cases) {
      expect(composerAvailabilityNoticeLabel(availability, status)).toBe(expected);
    }
  });

  it("normalizes provider rate-limit detail", () => {
    const reportedReset = "2099-01-01T09:30:00Z";
    const cases = [
      {
        limit: { status: "limited", resets_at: reportedReset, kind: "rate_limit" },
        expected: `Rate-limited (rate_limit); resets at ${new Date(reportedReset).toLocaleTimeString()}.`,
      },
      {
        limit: {
          status: "Internal error: You've hit your weekly limit · resets 4am (Europe/Paris)",
          resets_at: null,
          kind: "rate_limit",
        },
        expected: "Rate-limited (rate_limit); You've hit your weekly limit · resets 4am (Europe/Paris)",
      },
      {
        limit: {
          status: "Internal error: You've hit your weekly limit · resets 4am (Europe/Paris)",
          resets_at: "not-a-timestamp",
          kind: "rate_limit",
        },
        expected: "Rate-limited (rate_limit); You've hit your weekly limit · resets 4am (Europe/Paris)",
      },
      {
        limit: {
          status:
            'ACP connection failed: Internal error: You\'ve hit your limit · resets 12:10pm (Europe/Paris): {\n  "errorKind":"rate_limit"\n}',
          resets_at: null,
          kind: "rate_limit",
        },
        expected: "Rate-limited (rate_limit); You've hit your limit · resets 12:10pm (Europe/Paris)",
      },
      {
        limit: { status: '{"errorKind":"rate_limit"}', resets_at: null, kind: "rate_limit" },
        expected: "Rate-limited (rate_limit); the agent did not report a reset time.",
      },
    ] as const;

    for (const { limit, expected } of cases) expect(rateLimitDetail(limit)).toBe(expected);
  });

  it("renders lifecycle payloads without consulting diagnostic evidence", () => {
    const cases: Array<{ incident: SessionIncident; expected: RegExp }> = [
      {
        incident: {
          kind: "restarting",
          action: "wait",
          title: "Restarting agent",
          detail: "Agent stopped responding to cancel. Restarting worker; your transcript will be preserved.",
          reason: "cancel_unresponsive",
        },
        expected: /Agent stopped responding to cancel/i,
      },
      {
        incident: {
          kind: "snoozed",
          action: "unsnooze",
          title: "Session snoozed",
          detail: "This session will resume when its snooze expires, or you can wake it sooner.",
          snoozedUntil: "2099-01-01T09:30:00Z",
        },
        expected: /Session snoozed/i,
      },
      {
        incident: {
          kind: "failed",
          action: "retry_start",
          title: "Agent could not start",
          detail: "binary missing",
          category: "startup",
        },
        expected: /binary missing/i,
      },
    ];

    for (const { incident, expected } of cases) {
      const result = render(<ConversationLifecycleNotice sessionId="session-1" incident={incident} />);
      expect(result.getByText(expected)).toBeDefined();
      result.unmount();
    }
  });

  it("owns rate-limit detail and recovery actions", () => {
    const onResumeRateLimit = vi.fn();
    const onSwitchAgent = vi.fn();
    const incident: SessionIncident = {
      kind: "blocked",
      action: "switch_agent",
      title: "Agent is rate limited",
      detail: "The provider is not accepting work for this session.",
      reason: "rate_limited",
    };
    const result = render(
      <ConversationLifecycleNotice
        sessionId="session-1"
        incident={incident}
        rateLimit={{
          status: "Internal error: You've hit your weekly limit · resets 4am (Europe/Paris)",
          resets_at: null,
          kind: "rate_limit",
        }}
        onResumeRateLimit={onResumeRateLimit}
        onSwitchAgent={onSwitchAgent}
        rateLimitResumeState="failed"
        rateLimitResumeError="Server returned 500. spawn failed"
      />,
    );

    expect(
      result.getByText("Rate-limited (rate_limit); You've hit your weekly limit · resets 4am (Europe/Paris)"),
    ).toBeDefined();
    expect(result.getByText(/Resume failed: Server returned 500\. spawn failed/i)).toBeDefined();
    fireEvent.click(result.getByRole("button", { name: /resume now/i }));
    fireEvent.click(result.getByRole("button", { name: /continue in another agent/i }));
    expect(onResumeRateLimit).toHaveBeenCalledTimes(1);
    expect(onSwitchAgent).toHaveBeenCalledTimes(1);
  });

  it("shows pending rate-limit resume states without enabling duplicate requests", () => {
    const incident: SessionIncident = {
      kind: "blocked",
      action: "switch_agent",
      title: "Agent is rate limited",
      detail: "The provider is not accepting work for this session.",
      reason: "rate_limited",
    };
    const result = render(
      <ConversationLifecycleNotice
        sessionId="session-1"
        incident={incident}
        onResumeRateLimit={vi.fn()}
        rateLimitResumeState="retrying"
      />,
    );
    expect((result.getByRole("button", { name: /resuming/i }) as HTMLButtonElement).disabled).toBe(true);

    result.rerender(
      <ConversationLifecycleNotice
        sessionId="session-1"
        incident={incident}
        onResumeRateLimit={vi.fn()}
        rateLimitResumeState="ok"
      />,
    );
    expect((result.getByRole("button", { name: /resume requested/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(result.getByText(/Resume requested\. New events should start streaming shortly/i)).toBeDefined();
  });
});
