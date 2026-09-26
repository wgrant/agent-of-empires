// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { sessionThinkingDisplayKey } from "../lib/thinkingDisplay";
import { useSessionThinkingDisplay } from "./useSessionThinkingDisplay";
import { useWebSettings } from "./useWebSettings";

afterEach(() => localStorage.clear());

describe("useSessionThinkingDisplay", () => {
  it("follows the dashboard default until the session overrides it, and clears back to it", () => {
    const settings = renderHook(() => useWebSettings());
    const session = renderHook(() => useSessionThinkingDisplay("s1"));
    expect(session.result.current).toMatchObject({ effective: "collapsed", override: null });

    act(() => settings.result.current.update({ thinkingDisplay: "hidden" }));
    expect(session.result.current).toMatchObject({ effective: "hidden", globalDefault: "hidden" });

    act(() => session.result.current.setOverride("expanded"));
    expect(session.result.current).toMatchObject({ effective: "expanded", override: "expanded" });
    expect(localStorage.getItem(sessionThinkingDisplayKey("s1"))).toBe("expanded");

    act(() => session.result.current.setOverride(null));
    expect(session.result.current).toMatchObject({ effective: "hidden", override: null });
    expect(localStorage.getItem(sessionThinkingDisplayKey("s1"))).toBeNull();
  });

  it("scopes the override to its session and ignores unknown stored values", () => {
    localStorage.setItem(sessionThinkingDisplayKey("s1"), "expanded");
    localStorage.setItem(sessionThinkingDisplayKey("s2"), "verbose");
    expect(renderHook(() => useSessionThinkingDisplay("s1")).result.current.effective).toBe("expanded");
    expect(renderHook(() => useSessionThinkingDisplay("s2")).result.current).toMatchObject({
      effective: "collapsed",
      override: null,
    });
  });
});
