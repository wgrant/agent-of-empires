// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileImageViewer } from "../FileImageViewer";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FileImageViewer", () => {
  it("fetches an authenticated image blob and keeps transcript navigation visible", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve(new Blob(["png"])) });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:preview"),
      revokeObjectURL: vi.fn(),
    });
    const onBack = vi.fn();

    render(<FileImageViewer sessionId="s 1" filePath="test-results/shot.png" onBack={onBack} />);

    expect(screen.getByRole("button", { name: "Back to transcript" })).toBeTruthy();
    const image = await screen.findByRole("img", { name: "test-results/shot.png" });
    expect(image.getAttribute("src")).toBe("blob:preview");
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/s%201/file/image?path=test-results%2Fshot.png");

    fireEvent.click(screen.getByRole("button", { name: "Back to transcript" }));
    expect(onBack).toHaveBeenCalledOnce();
    await waitFor(() => expect(image).toBeTruthy());
  });

  it("distinguishes a missing image from a generic load failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    render(<FileImageViewer sessionId="s1" filePath="test-results/old-shot.png" onBack={() => {}} />);

    expect(await screen.findByText("Image not found")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to transcript" })).toBeTruthy();
    expect(screen.getByText("test-results/old-shot.png")).toBeTruthy();
  });
});
