// Recognises the recap prompt built by src/acp/context_primer.rs. It reaches the
// transcript as ordinary user text (the user sends it from the composer and may
// edit it), so its fixed markdown headings are the only signal.

const HEADER = "# Prior structured view context";
const TRANSCRIPT_HEADING = "## Transcript";
const CURRENT_REQUEST_HEADING = "## Current request";
const TRUNCATION_NOTICE = "_Older transcript entries were omitted to fit the primer budget._";
const TURN_HEADING = /^### Turn \d+$/;

export interface ContextPrimer {
  /** The transcript excerpt, without the model-facing preamble. */
  recap: string;
  turnCount: number;
  truncated: boolean;
  /** What follows "## Current request"; empty when absent. */
  currentRequest: string;
}

export function parseContextPrimer(text: string): ContextPrimer | null {
  const lines = text.trimStart().split("\n");
  if (lines[0]?.trimEnd() !== HEADER) return null;
  // A recap of a session resumed before quotes the earlier primer as a user
  // turn, so only headings at the outermost nesting level count.
  let depth = 0;
  let turnCount = 0;
  let truncated = false;
  let recapStart = -1;
  let requestLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trimEnd();
    if (line === HEADER) depth++;
    else if (line === CURRENT_REQUEST_HEADING && --depth === 0) {
      requestLine = i;
      break;
    } else if (depth === 1) {
      if (TURN_HEADING.test(line)) turnCount++;
      else if (line === TRUNCATION_NOTICE && recapStart < 0) truncated = true;
      else if (line === TRANSCRIPT_HEADING && recapStart < 0) recapStart = i + 1;
    }
  }
  const recapEnd = requestLine < 0 ? lines.length : requestLine;
  const recap =
    recapStart < 0
      ? ""
      : lines
          .slice(recapStart, recapEnd)
          .join("\n")
          .trim()
          .replace(/\n---$/, "")
          .trim();
  const currentRequest =
    requestLine < 0
      ? ""
      : lines
          .slice(requestLine + 1)
          .join("\n")
          .trim();
  return { recap, turnCount, truncated, currentRequest };
}
