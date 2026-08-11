import { describe, expect, it } from "vitest";

import { deriveConversationNextStep } from "./conversationStatus";

describe("deriveConversationNextStep", () => {
  it("gives transcript catch-up precedence over cached agent activity", () => {
    expect(
      deriveConversationNextStep({ initialCatchup: true, turnActive: true, nextWakeupAt: null, monitorArmed: false }),
    ).toEqual({ kind: "catching_up" });
    expect(
      deriveConversationNextStep({ initialCatchup: false, turnActive: true, nextWakeupAt: null, monitorArmed: false }),
    ).toEqual({ kind: "working" });
    expect(
      deriveConversationNextStep({ initialCatchup: false, turnActive: false, nextWakeupAt: "x", monitorArmed: true }),
    ).toEqual({ kind: "scheduled_wakeup" });
    expect(
      deriveConversationNextStep({ initialCatchup: false, turnActive: false, nextWakeupAt: null, monitorArmed: true }),
    ).toEqual({ kind: "monitoring" });
  });
});
