// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useReveal } from "./useReveal";

const reducedMotion = vi.hoisted(() => ({ on: false }));
vi.mock("./useMediaQuery", () => ({ useMediaQuery: () => reducedMotion.on }));

function mount(text: string, active = true) {
  return renderHook(({ text, active }) => useReveal(text, active), { initialProps: { text, active } });
}

const frames = (ms: number) => act(() => vi.advanceTimersByTime(ms));

beforeEach(() => {
  reducedMotion.on = false;
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
});
afterEach(() => vi.useRealTimers());

describe("useReveal", () => {
  it("shows the text present at mount at once, even while streaming", () => {
    expect(mount("Earlier reply that was already here.").result.current).toBe("Earlier reply that was already here.");
  });

  it("reveals only what arrives after mount, then all of it", async () => {
    const hook = mount("Hello");
    hook.rerender({ text: "Hello, world", active: true });
    expect(hook.result.current).toBe("Hello");
    await frames(16);
    const partway = hook.result.current;
    expect(partway.startsWith("Hello")).toBe(true);
    expect(partway.length).toBeGreaterThan(5);
    await frames(500);
    expect(hook.result.current).toBe("Hello, world");
  });

  it.each([
    ["a replacement", { text: "Something else", active: true }],
    ["a turn that stopped", { text: "Hello, world", active: false }],
  ])("shows %s at once", (_, next) => {
    const hook = mount("Hello");
    hook.rerender(next);
    expect(hook.result.current).toBe(next.text);
  });

  it("finishes at once when the turn stops mid-reveal", async () => {
    const hook = mount("Hi");
    hook.rerender({ text: "Hi there, a longer reply", active: true });
    await frames(16);
    hook.rerender({ text: "Hi there, a longer reply", active: false });
    expect(hook.result.current).toBe("Hi there, a longer reply");
  });

  it("does not pace under reduced motion", () => {
    reducedMotion.on = true;
    const hook = mount("Hi");
    hook.rerender({ text: "Hi there", active: true });
    expect(hook.result.current).toBe("Hi there");
  });
});
