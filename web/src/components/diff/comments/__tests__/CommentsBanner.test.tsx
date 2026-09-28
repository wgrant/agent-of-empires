// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { CommentsBanner } from "../CommentsBanner";

afterEach(cleanup);

describe("CommentsBanner", () => {
  it.each([
    [0, null],
    [2, "2 in another view"],
  ])("with %i comments in other views, says %s", (hidden, text) => {
    render(
      <CommentsBanner
        count={3}
        hidden={hidden}
        sendEnabled
        sendDisabledReason=""
        onSend={vi.fn()}
        onDiscardAll={vi.fn()}
      />,
    );
    expect(screen.getByText("3 comments")).toBeTruthy();
    expect(screen.queryByTestId("comments-other-views")?.textContent ?? null).toBe(text);
  });
});
