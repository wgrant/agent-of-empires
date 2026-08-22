// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ConversationLifecycleNotice } from "./SessionBanners";
import type { SessionIncident } from "./status/conversationDiagnostics";

afterEach(cleanup);

describe("ConversationLifecycleNotice", () => {
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
});
