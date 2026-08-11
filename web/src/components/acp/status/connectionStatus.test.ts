import { describe, expect, it } from "vitest";

import { deriveConnectionIncident } from "./connectionStatus";

const base = {
  status: "open" as const,
  lagged: false,
  rateLimit: null,
  hasEverOpened: true,
  reconnecting: false,
  retryCount: 0,
  retryCountdown: 0,
  maxRetries: 7,
  rateLimitText: () => "Rate-limited (provider); resets at 10:42:00.",
};

describe("deriveConnectionIncident", () => {
  it("only creates an incident for a current connection problem", () => {
    expect(deriveConnectionIncident(base)).toBeNull();
    expect(deriveConnectionIncident({ ...base, lagged: true })?.notices).toEqual([
      { kind: "warn", text: "Some events were missed during reconnect." },
    ]);
  });

  it("keeps the existing reconnect and exhausted-retry wording in one model", () => {
    const retrying = deriveConnectionIncident({
      ...base,
      status: "closed",
      reconnecting: true,
      retryCount: 3,
      retryCountdown: 4,
    });
    expect(retrying).toMatchObject({
      device: "working",
      server: "unknown",
      retriesExhausted: false,
      notices: [{ kind: "warn", text: "Structured view disconnected. Reconnecting (3/7) in 4s…" }],
    });

    const exhausted = deriveConnectionIncident({ ...base, status: "closed", retryCount: 7 });
    expect(exhausted).toMatchObject({ device: "failed", retriesExhausted: true, notices: [] });
  });

  it("classifies an explicit rate limit as an agent block without inferring server health", () => {
    const incident = deriveConnectionIncident({
      ...base,
      rateLimit: { kind: "provider", status: "later", resets_at: null },
    });
    expect(incident).toMatchObject({ agent: "blocked", server: "unknown" });
    expect(incident?.notices[0]?.text).toContain("Rate-limited");
  });
});
