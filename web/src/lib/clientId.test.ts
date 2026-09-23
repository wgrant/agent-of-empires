import { afterEach, describe, expect, it, vi } from "vitest";
import { createClientId } from "./clientId";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("createClientId", () => {
  it("uses randomUUID when the browser provides it", () => {
    const randomUUID = vi.fn(
      () => "8ff0651b-1a5d-4fb7-86f2-3b60f718c4fe" as `${string}-${string}-${string}-${string}-${string}`,
    );
    vi.stubGlobal("crypto", { randomUUID, getRandomValues: vi.fn() });

    expect(createClientId()).toBe("8ff0651b-1a5d-4fb7-86f2-3b60f718c4fe");
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("constructs a UUID v4 when randomUUID is unavailable on plain HTTP", () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.fill(0);
      return bytes;
    });
    vi.stubGlobal("crypto", { getRandomValues });

    expect(createClientId()).toBe("00000000-0000-4000-8000-000000000000");
    expect(getRandomValues).toHaveBeenCalledOnce();
  });

  it("retains a UUID-shaped fallback without Web Crypto", () => {
    vi.stubGlobal("crypto", undefined);
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    expect(createClientId()).toBe("80808080-8080-4080-8080-808080808080");
  });
});
