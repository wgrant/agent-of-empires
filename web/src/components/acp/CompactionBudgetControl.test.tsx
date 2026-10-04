// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CompactionBudgetControl } from "./CompactionBudgetControl";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mockSettings(overrides: Record<string, unknown> = {}) {
  const settings = {
    tokens: null,
    bounds: [100000, 1000000],
    applied_known: true,
    applied_tokens: null,
    running: true,
    ...overrides,
  };
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      settings.tokens = JSON.parse(String(init.body)).auto_compaction.tokens;
      return new Response("{}", { status: 200 });
    }
    return new Response(JSON.stringify({ auto_compaction: settings }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<CompactionBudgetControl sessionId="session / one" />);
  return fetchMock;
}

it("saves a custom budget without restarting and distinguishes the pending launch", async () => {
  const fetchMock = mockSettings();
  fireEvent.change(await screen.findByLabelText("Auto-compaction"), { target: { value: "custom" } });
  fireEvent.change(screen.getByLabelText("Working context budget (tokens)"), { target: { value: "200000" } });
  fireEvent.click(screen.getByRole("button", { name: "Save for next start" }));
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session%20%2F%20one/acp/launch-options", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auto_compaction: { tokens: 200000 }, restart: false }),
    }),
  );
  expect(await screen.findByText(/Saved. Restart the agent/)).toBeTruthy();
});

it("requires explicit restart confirmation and can restore the native default", async () => {
  const fetchMock = mockSettings({ tokens: 200000, applied_tokens: 200000 });
  fireEvent.change(await screen.findByLabelText("Auto-compaction"), { target: { value: "default" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply and restart…" }));
  expect(screen.getByText(/Restarting interrupts/)).toBeTruthy();
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Cancel restart" }));
  fireEvent.click(screen.getByRole("button", { name: "Apply and restart…" }));
  fireEvent.click(screen.getByRole("button", { name: "Restart agent" }));
  await waitFor(() =>
    expect(fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")?.[1]?.body).toBe(
      JSON.stringify({ auto_compaction: { tokens: null }, restart: true }),
    ),
  );
});

it("validates bounds and never offers to wake a dormant session", async () => {
  mockSettings({ running: false, applied_known: false });
  fireEvent.change(await screen.findByLabelText("Auto-compaction"), { target: { value: "custom" } });
  fireEvent.change(screen.getByLabelText("Working context budget (tokens)"), { target: { value: "50000" } });
  expect(screen.getByRole("alert").textContent).toContain("100,000");
  expect((screen.getByRole("button", { name: "Save for next start" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole("button", { name: /restart/i })).toBeNull();
  fireEvent.change(screen.getByLabelText("Working context budget (tokens)"), { target: { value: "" } });
  expect((screen.getByRole("button", { name: "Save for next start" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("status").textContent).toContain("next agent start");
});

it("does not claim application for reattached workers or unsupported backends", async () => {
  mockSettings({ applied_known: false });
  expect(await screen.findByText(/Running agent’s budget is unknown/)).toBeTruthy();
  cleanup();
  mockSettings({ starting: true, running: false, applied_known: false });
  expect(await screen.findByText(/Starting agent with the saved policy/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /restart/i })).toBeNull();
  cleanup();
  mockSettings({ bounds: null });
  expect(await screen.findByText(/does not expose/)).toBeTruthy();
  expect(screen.queryByLabelText("Auto-compaction")).toBeNull();
});

it("reports load and save failures without discarding the draft", async () => {
  const fetchMock = mockSettings();
  fireEvent.change(await screen.findByLabelText("Auto-compaction"), { target: { value: "custom" } });
  fetchMock.mockImplementationOnce(
    async () => new Response(JSON.stringify({ message: "Agent options cannot be changed" }), { status: 403 }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save for next start" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Agent options cannot be changed");
  expect((screen.getByLabelText("Working context budget (tokens)") as HTMLInputElement).value).toBe("100000");
  cleanup();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("", { status: 404 })),
  );
  render(<CompactionBudgetControl sessionId="missing" />);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Could not load context settings (HTTP 404)");
});
