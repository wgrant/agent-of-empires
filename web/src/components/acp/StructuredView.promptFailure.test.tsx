// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PromptSendFailureNotice } from "./ThreadMessages";

afterEach(cleanup);

describe("PromptSendFailureNotice", () => {
  it("marks a rejected optimistic prompt as not sent and shows the reason", () => {
    render(<PromptSendFailureNotice reason="unsupported attachment type: text/html" />);

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Not sent.");
    expect(alert.textContent).toContain("unsupported attachment type: text/html");
    expect(alert.className).toContain("status-error");
  });
});
