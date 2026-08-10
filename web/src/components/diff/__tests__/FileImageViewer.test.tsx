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

    render(
      <FileImageViewer sessionId="s 1" filePath="test-results/shot.dat" onBack={onBack} fallback={<p>fallback</p>} />,
    );

    expect(screen.getByRole("button", { name: "Back to transcript" })).toBeTruthy();
    const image = await screen.findByRole("img", { name: "test-results/shot.dat" });
    expect(image.getAttribute("src")).toBe("blob:preview");
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/s%201/file/image?path=test-results%2Fshot.dat");

    const zoomButton = screen.getByRole("button", { name: "View image at actual size" });
    fireEvent.click(zoomButton);
    expect(screen.getByRole("button", { name: "Fit image to viewer" })).toBeTruthy();
    expect(image.className).toContain("max-w-none");
    expect(screen.getByTestId("zoomable-image-viewport").className).toContain("overflow-auto");

    fireEvent.click(screen.getByRole("button", { name: "Back to transcript" }));
    expect(onBack).toHaveBeenCalledOnce();
    await waitFor(() => expect(image).toBeTruthy());
  });

  it("explains when bytes accepted as an image cannot be decoded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve(new Blob(["bad"])) }));
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:broken-preview"),
      revokeObjectURL: vi.fn(),
    });

    render(<FileImageViewer sessionId="s1" filePath="broken.dat" fallback={<p>fallback</p>} />);

    fireEvent.error(await screen.findByRole("img", { name: "broken.dat" }));
    expect(await screen.findByText("Could not decode image")).toBeTruthy();
  });

  it("distinguishes a missing image from a generic load failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    render(
      <FileImageViewer
        sessionId="s1"
        filePath="test-results/old-shot.dat"
        onBack={() => {}}
        fallback={<p>fallback</p>}
      />,
    );

    expect(await screen.findByText("File not found")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to transcript" })).toBeTruthy();
    expect(screen.getByText("test-results/old-shot.dat")).toBeTruthy();
  });

  it("falls back to the normal file viewer when the bytes are not a raster image", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 415 }));

    render(<FileImageViewer sessionId="s1" filePath="src/app.ts" fallback={<p>normal file viewer</p>} />);

    expect(await screen.findByText("normal file viewer")).toBeTruthy();
  });
});
