// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ConversationLifecycleNotice } from "./SessionBanners";
import { deriveSessionDiagnostics } from "./status/sessionDiagnostics";
import { emptyAcpState } from "../../lib/acpTypes";

afterEach(cleanup);

describe("ConversationLifecycleNotice", () => {
  it("surfaces a restarting agent as the session-level status", () => {
    const diagnostics = deriveSessionDiagnostics({
      state: { ...emptyAcpState(), workerRestarting: true },
      workerState: "resuming",
      archivedAt: null,
      snoozedUntil: null,
      trashedAt: null,
    });
    const { getByText } = render(
      <ConversationLifecycleNotice
        sessionId="session-1"
        diagnostics={diagnostics}
        incident={{
          kind: "restarting",
          action: "wait",
          title: "Restarting agent",
          detail: "AoE is restoring the agent session.",
        }}
      />,
    );
    expect(getByText(/Restarting structured view worker/i)).toBeDefined();
  });
});
