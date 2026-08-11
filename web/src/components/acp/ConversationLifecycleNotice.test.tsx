// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ConversationLifecycleNotice } from "./SessionBanners";

afterEach(cleanup);

describe("ConversationLifecycleNotice", () => {
  it("surfaces a restarting agent as the session-level status", () => {
    const { getByText } = render(
      <ConversationLifecycleNotice
        status={{
          kind: "updating",
          cause: "agent_restarting",
          tone: "progress",
          placement: "session",
          composer: "queue",
        }}
        sessionId="session-1"
        startupError={null}
        workerStopped={false}
        agentUnresponsive={false}
        agentOrphaned={false}
        trashedAt={null}
        archivedAt={null}
        snoozedUntil={null}
      />,
    );
    expect(getByText(/Restarting structured view worker/i)).toBeDefined();
  });
});
