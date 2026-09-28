// Code-review findings reported through Claude Code's ReportFindings tool.

export interface ReviewFinding {
  file: string;
  line?: number;
  summary: string;
  failureScenario?: string;
  shortSummary?: string;
  category?: string;
  /** `CONFIRMED` or `PLAUSIBLE` when a verify pass ran. */
  verdict?: string;
  /** Set when re-reported after fixes: `fixed`, `skipped`, or `no_change_needed`. */
  outcome?: string;
}

export interface ReviewFindings {
  level?: string;
  findings: ReviewFinding[];
}

const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v : undefined);

/** The findings a tool call's args report, or null when they are not a findings report. */
export function parseReviewFindings(args: Record<string, unknown> | null): ReviewFindings | null {
  const raw = args?.findings;
  if (!Array.isArray(raw)) return null;
  const findings: ReviewFinding[] = [];
  for (const item of raw) {
    const f = item as Record<string, unknown> | null;
    const file = str(f?.file);
    const summary = str(f?.summary);
    if (!file || !summary) return null;
    findings.push({
      file,
      summary,
      ...(typeof f!.line === "number" ? { line: f!.line } : {}),
      ...(str(f!.failure_scenario) ? { failureScenario: str(f!.failure_scenario) } : {}),
      ...(str(f!.short_summary) ? { shortSummary: str(f!.short_summary) } : {}),
      ...(str(f!.category) ? { category: str(f!.category) } : {}),
      ...(str(f!.verdict) ? { verdict: str(f!.verdict) } : {}),
      ...(str(f!.outcome) ? { outcome: str(f!.outcome) } : {}),
    });
  }
  return { ...(str(args!.level) ? { level: str(args!.level) } : {}), findings };
}

/** Findings printed as JSON text: a bare list, or a report object. */
export function parseReviewFindingsText(text: string): ReviewFindings | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const report = parseReviewFindings(
    Array.isArray(value) ? { findings: value } : (value as Record<string, unknown> | null),
  );
  // An empty list is only a report when it says so.
  return report && (report.findings.length > 0 || !Array.isArray(value)) ? report : null;
}
