// A code review's findings, most severe first, as the review reported them.

import { ListChecks } from "lucide-react";

import type { ReviewFinding, ReviewFindings } from "../../lib/reviewFindings";
import { CardChrome, ClickableFilePath, statusFor, useToolCardExpansion, type ToolCardProps } from "./ToolCardChrome";
import { ToolErrorBody } from "./ToolErrorBody";

const OUTCOMES: Record<string, string> = { fixed: "fixed", skipped: "skipped", no_change_needed: "no change needed" };

function Chip({ children, tone = "dim" }: { children: React.ReactNode; tone?: "dim" | "ok" | "warn" }) {
  const tones = {
    dim: "border-surface-700 text-text-dim",
    ok: "border-status-running/40 text-status-running",
    warn: "border-status-warning/40 text-status-warning",
  };
  return (
    <span className={`rounded border px-1.5 py-px text-[10px] uppercase tracking-wider ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function ReviewFindingsCard({ tool, result, report }: ToolCardProps & { report: ReviewFindings }) {
  const status = statusFor(result);
  const [open, setOpen] = useToolCardExpansion(status, true);
  const { findings, level } = report;
  const count = findings.length === 0 ? "No findings" : `${findings.length} finding${findings.length === 1 ? "" : "s"}`;
  return (
    <CardChrome
      status={status}
      startedAt={tool.started_at}
      endedAt={result?.at}
      icon={<ListChecks className="h-3.5 w-3.5" />}
      label="review"
      primary={
        <>
          <span>{count}</span>
          {level && <span className="ml-2 text-text-dim">· {level}</span>}
        </>
      }
      expanded={open && (findings.length > 0 || status === "err")}
      onToggle={findings.length > 0 || status === "err" ? () => setOpen((v) => !v) : undefined}
      body={
        <ToolErrorBody status={status} errorText={result?.text}>
          <FindingsList findings={findings} />
        </ToolErrorBody>
      }
    />
  );
}

/** Text with its `code` spans set as code; findings name identifiers that way. */
function WithCode({ text }: { text: string }) {
  return (
    <>
      {text.split(/`([^`]+)`/).map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className="rounded bg-surface-800 px-1 font-mono text-[0.9em]">
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** Each finding: where it is, what is wrong, and how it fails. */
export function FindingsList({ findings }: { findings: ReviewFinding[] }) {
  return (
    <ol className="divide-y divide-surface-800 border-t border-surface-800 bg-surface-900/30">
      {findings.map((f, i) => (
        <li key={i} data-testid="review-finding" className="px-3 py-2 text-sm">
          <div className="flex flex-wrap items-center gap-2 font-mono text-xs text-text-secondary">
            <ClickableFilePath rawPath={f.file} display={f.line ? `${f.file}:${f.line}` : f.file} />
            {f.category && <Chip>{f.category}</Chip>}
            {f.verdict && <Chip tone={f.verdict === "CONFIRMED" ? "warn" : "dim"}>{f.verdict.toLowerCase()}</Chip>}
            {f.outcome && <Chip tone={f.outcome === "fixed" ? "ok" : "dim"}>{OUTCOMES[f.outcome] ?? f.outcome}</Chip>}
          </div>
          <p className="mt-1 text-text-primary">
            <WithCode text={f.summary} />
          </p>
          {f.failureScenario && (
            <p className="mt-0.5 text-xs text-text-dim">
              <WithCode text={f.failureScenario} />
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}
