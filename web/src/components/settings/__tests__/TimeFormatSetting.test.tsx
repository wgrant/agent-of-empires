// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { TimeFormatSetting } from "../TimeFormatSetting";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("TimeFormatSetting", () => {
  it("defaults to automatic and stores a chosen format", () => {
    render(<TimeFormatSetting />);
    const select = screen.getByDisplayValue("Automatic") as HTMLSelectElement;
    expect(select.value).toBe("auto");
    fireEvent.change(select, { target: { value: "24h" } });
    expect(JSON.parse(localStorage.getItem("aoe-web-settings")!).timeFormat).toBe("24h");
  });
});
