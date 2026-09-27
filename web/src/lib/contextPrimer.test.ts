import { describe, expect, it } from "vitest";

import { parseContextPrimer } from "./contextPrimer";

// Mirrors the layout of src/acp/context_primer.rs.
const HEADER =
  "# Prior structured view context\n\nThe previous ACP session could not be loaded, so you have no memory of the conversation below. Use the transcript excerpt as background context for the current request. Do not repeat it back unless asked.\n\n";
const NOTICE = "_Older transcript entries were omitted to fit the primer budget._\n\n";
const primer = (turns: string[], { truncated = false, request = "Continue from where we left off." } = {}) =>
  HEADER +
  (truncated ? NOTICE : "") +
  "## Transcript\n\n" +
  turns.map((body, i) => `### Turn ${i + 1}\n\n${body}\n`).join("") +
  `\n---\n\n## Current request\n\n${request}\n`;

describe("parseContextPrimer", () => {
  it.each([
    {
      name: "a plain recap",
      text: primer(["User:\nfix the bug\n\nAssistant:\ndone\n", "User:\nnow test it\n"]),
      expected: {
        turnCount: 2,
        truncated: false,
        currentRequest: "Continue from where we left off.",
        recap: "### Turn 1\n\nUser:\nfix the bug\n\nAssistant:\ndone\n\n### Turn 2\n\nUser:\nnow test it",
      },
    },
    {
      name: "a truncated recap with an edited request",
      text: primer(["User:\nhi\n"], { truncated: true, request: "Also add docs." }),
      expected: { turnCount: 1, truncated: true, currentRequest: "Also add docs.", recap: "### Turn 1\n\nUser:\nhi" },
    },
    {
      name: "an earlier primer quoted as a turn",
      text: primer([`User:\n${primer(["User:\na\n", "User:\nb\n"], { truncated: true }).trim()}\n\nAssistant:\nok\n`]),
      expected: { turnCount: 1, truncated: false, currentRequest: "Continue from where we left off." },
    },
  ])("parses $name", ({ text, expected }) => {
    expect(parseContextPrimer(text)).toMatchObject(expected);
  });

  it("ignores prompts that only mention the header", () => {
    expect(parseContextPrimer("see # Prior structured view context")).toBeNull();
    expect(parseContextPrimer("# Prior structured view context notes")).toBeNull();
  });
});
