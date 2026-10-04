// Composer footer controls: toolbar, usage hint, attachments, send/stop, popover list.

import { ComposerPrimitive, useAui } from "@assistant-ui/react";
import { Clock3, Paperclip, ShieldCheck, Square, X } from "lucide-react";
import { applicationText, type PendingSetting } from "../../lib/agentSettings";

import { useMinuteClock } from "../../hooks/useMinuteClock";
import { useNow } from "../../hooks/useNow";
import type { AcpState, PromptAttachmentInput } from "../../lib/acpTypes";
import {
  compactQuotaWindows,
  describeQuotaAge,
  describeQuotaWindow,
  quotaTone,
  quotaWindowLabel,
} from "../../lib/quota";
import { describeTurnUsage, formatTokens } from "../../lib/turnUsage";
import { badgeLabel, badgeTone, resolveSkillSource, type SkillIndex } from "../../lib/skillProvenance";
import { TOUR_ANCHORS, tourAnchor } from "../../lib/tourSteps";
import { ProvenanceBadge } from "../ProvenanceBadge";
import { Tooltip } from "../Tooltip";
import type { ComposerAvailability } from "./status/conversationDiagnostics";
import { Spinner } from "../Spinner";

/** Flat item list shared by the `@` and `/` popovers; `/` passes a skill index for provenance badges. */
export function PopoverItems({ trigger, skillIndex }: { trigger: string; skillIndex?: SkillIndex }) {
  return (
    <ComposerPrimitive.Unstable_TriggerPopoverItems className="max-h-64 overflow-y-auto">
      {(items) =>
        items.length === 0 ? (
          <div className="px-3 py-2 text-xs italic text-text-dim">No matches</div>
        ) : (
          items.map((item, i) => {
            const source = skillIndex ? resolveSkillSource(skillIndex, item.id) : null;
            return (
              <ComposerPrimitive.Unstable_TriggerPopoverItem
                key={item.id}
                item={item}
                index={i}
                className={[
                  "flex w-full items-start gap-2 px-3 py-2 text-left text-xs",
                  "hover:bg-surface-800/60",
                  "data-[highlighted=true]:bg-surface-800",
                ].join(" ")}
              >
                <span className="font-mono text-text-dim">{trigger}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="block truncate font-medium text-text-primary">{item.label}</span>
                    {source && <ProvenanceBadge label={badgeLabel(source)} tone={badgeTone(source)} />}
                  </span>
                  {item.description && (
                    <span className="block truncate text-[11px] text-text-dim">{item.description}</span>
                  )}
                </span>
              </ComposerPrimitive.Unstable_TriggerPopoverItem>
            );
          })
        )
      }
    </ComposerPrimitive.Unstable_TriggerPopoverItems>
  );
}

export function AttachmentChips({
  attachments,
  onRemove,
}: {
  attachments: PromptAttachmentInput[];
  onRemove: (index: number) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-3 pt-1">
      {attachments.map((att, i) => (
        <div
          key={`${att.name ?? att.kind}-${i}`}
          className="group/att relative flex items-center gap-2 rounded-md border border-surface-700 bg-surface-800 py-1 pl-1 pr-2 text-[11px] text-text-secondary"
        >
          {att.kind === "image" ? (
            <img
              src={`data:${att.mimeType};base64,${att.dataB64}`}
              alt={att.name ?? "attachment"}
              className="h-8 w-8 rounded object-cover"
            />
          ) : (
            <span className="flex h-8 w-8 items-center justify-center rounded bg-surface-700">
              <Paperclip className="h-3.5 w-3.5" />
            </span>
          )}
          <span className="max-w-[120px] truncate">{att.name ?? att.kind}</span>
          <button
            type="button"
            aria-label={`Remove ${att.name ?? "attachment"}`}
            title="Remove attachment"
            onClick={() => onRemove(i)}
            className="rounded p-0.5 text-text-dim hover:bg-surface-700 hover:text-text-secondary"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

export function ToolbarButton({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={[
        "inline-flex items-center rounded-md p-1.5 text-text-dim",
        "hover:bg-surface-800 hover:text-text-secondary",
        "disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-text-dim",
        "transition-colors",
      ].join(" ")}
    >
      {icon}
    </button>
  );
}

function formatCost(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: amount < 1 ? 4 : 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(amount < 1 ? 4 : 2)} ${currency}`;
  }
}

/** The agent's own auth identity. Reporting only: the extension says which
 *  identity is in use, never whether its credentials still work, so a healthy
 *  looking chip is not a claim that the key is valid. */
export function AuthStatusHint({ authStatus }: { authStatus: AcpState["authStatus"] }) {
  // Silence means "not reported", which is not the same as logged out.
  if (!authStatus) return null;
  const loggedOut = authStatus.kind === "none";
  // Account details stay in the tooltip: this chip is on screen during every
  // screen share and recording.
  const details = [
    authStatus.detail,
    authStatus.account?.email,
    authStatus.account?.organization,
    authStatus.account?.plan,
  ].filter((d): d is string => !!d);
  const explanation = loggedOut
    ? `The agent reports it is not logged in. Prompts will fail until you authenticate.${details.length ? ` ${details.join(" · ")}` : ""}`
    : `This session runs under ${authStatus.label}.${details.length ? ` ${details.join(" · ")}` : ""} Reported by the agent; it does not confirm the credentials are still valid.`;
  return (
    <Tooltip text={explanation} multiline>
      <span
        data-testid="composer-auth-status"
        data-auth-kind={authStatus.kind}
        role="img"
        tabIndex={0}
        className={`inline-flex max-w-[12rem] items-center gap-1 truncate text-[11px] ${loggedOut ? "text-status-error-text" : "text-text-dim"}`}
        aria-label={explanation}
      >
        <ShieldCheck className="size-3 shrink-0 opacity-70" aria-hidden />
        <span className="truncate">{authStatus.label}</span>
      </span>
    </Tooltip>
  );
}

export function UsageHint({
  usage,
  quota = null,
  lastModel = null,
  lastTurnUsage = null,
  compact = false,
  reserveSummarySpace = false,
}: {
  usage: AcpState["sessionUsage"];
  quota?: AcpState["quota"];
  lastModel?: AcpState["lastModel"];
  lastTurnUsage?: AcpState["lastTurnUsage"];
  /** Sized for the collapsed composer strip. */
  compact?: boolean;
  reserveSummarySpace?: boolean;
}) {
  const now = useMinuteClock();
  const windows = compactQuotaWindows(quota, now);
  const context = usage && usage.size > 0 ? usage : null;
  if (!context && windows.length === 0) return null;
  const pct = context ? Math.min(100, Math.round((context.used / context.size) * 100)) : null;
  const contextTone = pct === null ? "" : pct >= 90 ? "text-rose-400" : pct >= 75 ? "text-amber-400" : "text-text-dim";
  const cost = usage?.cost ? formatCost(usage.cost.amount, usage.cost.currency) : null;
  const turnLines = describeTurnUsage(lastModel, lastTurnUsage);
  const explanation = [
    context
      ? `Context window: ${context.used.toLocaleString()} of ${context.size.toLocaleString()} tokens used (${pct}%). ` +
        `The color warms as the window fills.`
      : null,
    ...(quota ? [...quota.windows.map((w) => describeQuotaWindow(w, now)), describeQuotaAge(quota, now)] : []),
    ...turnLines,
    cost ? `${cost} is cumulative session spend since the last /clear or /compact.` : null,
  ]
    .filter(Boolean)
    .join(quota || turnLines.length > 0 ? "\n" : " ");
  return (
    // Flex, so the text centres in its row rather than sitting on a baseline.
    <span className="flex min-w-0 items-center">
      <Tooltip text={explanation} multiline tapToToggle>
        <button
          type="button"
          data-testid="composer-usage"
          className={`inline-flex items-center gap-1 ${compact ? "text-[10px]" : "text-[11px]"} tabular-nums text-text-dim`}
          aria-label={explanation}
        >
          {context && (
            <span className={contextTone}>
              <span className="hidden sm:inline">
                {formatTokens(context.used)}/{formatTokens(context.size)}{" "}
              </span>
              <span className="opacity-70">
                <span className="hidden sm:inline">(</span>
                {pct}%<span className="hidden sm:inline">)</span>
              </span>
            </span>
          )}
          {windows.map((w, index) => (
            <span
              key={w.id}
              data-testid="composer-quota-window"
              className={[
                quotaTone(w.used_percent),
                compact && reserveSummarySpace
                  ? index === 0 && context
                    ? "hidden @[360px]:inline"
                    : index > 0
                      ? "hidden @[440px]:inline"
                      : ""
                  : "",
              ].join(" ")}
            >
              {(context || index > 0) && <span className="text-text-dim opacity-70">· </span>}
              {quotaWindowLabel(w)} {Math.round(w.used_percent)}%
            </span>
          ))}
          {/* Quota says more than spend on a subscription; cost stays in the tooltip then. */}
          {cost && windows.length === 0 ? (
            <span className={`opacity-70 ${compact && reserveSummarySpace ? "hidden @[360px]:inline" : ""}`}>
              · {cost}
            </span>
          ) : null}
        </button>
      </Tooltip>
    </span>
  );
}

export function CompactionBudgetHint({
  tokens,
  pending,
  compact = false,
  onOpenSettings,
}: {
  tokens: number | null;
  pending?: PendingSetting;
  compact?: boolean;
  onOpenSettings: () => void;
}) {
  if (tokens === null) return null;
  const explanation = `Auto-compaction budget: ${tokens.toLocaleString()} tokens. ${
    pending ? `Saved; ${applicationText(pending.application).toLowerCase()}. ` : ""
  }Open session settings.`;
  return (
    <Tooltip text={explanation}>
      <button
        type="button"
        data-testid="composer-compaction-budget"
        aria-label={explanation}
        aria-haspopup="dialog"
        onClick={onOpenSettings}
        className={`inline-flex min-h-8 shrink-0 items-center gap-1 ${compact ? "text-[10px]" : "text-[11px]"} tabular-nums text-text-dim hover:text-text-secondary`}
      >
        compact {formatTokens(tokens)}
        {pending && <Clock3 data-testid="composer-compaction-pending" className="h-3 w-3 shrink-0" aria-hidden />}
      </button>
    </Tooltip>
  );
}

function sendButtonClass(disabled: boolean, extra = "") {
  return [
    `group/send ${extra}inline-flex items-center justify-center gap-1`,
    "rounded-lg bg-brand-600 px-2.5 py-1.5 text-white shadow-sm",
    "transition-all duration-100",
    disabled ? "cursor-not-allowed opacity-40" : "hover:bg-brand-500 active:scale-[0.98]",
  ].join(" ");
}

export function SendButton({
  availability,
  disabled = false,
  preparing = false,
  onSend,
}: {
  availability: Exclude<ComposerAvailability, { kind: "read_only" }>;
  disabled?: boolean;
  preparing?: boolean;
  onSend: () => void;
}) {
  const blocked = availability.kind === "blocked";
  const title = preparing
    ? "Preparing attachments…"
    : blocked
      ? "Sending is unavailable; your draft will be preserved"
      : disabled
        ? "Type a message to send"
        : availability.kind === "resume_then_send"
          ? "Send and resume session, Enter"
          : availability.kind === "wake_agent"
            ? "Send and wake agent, Enter"
            : availability.kind === "queue_for_recovery"
              ? "Queue message, will send on resume, Enter"
              : "Send, Enter";
  const label = preparing
    ? "Preparing attachments"
    : blocked
      ? "Sending unavailable"
      : availability.kind === "resume_then_send"
        ? "Send message and resume session"
        : availability.kind === "wake_agent"
          ? "Send message and wake agent"
          : availability.kind === "queue_for_recovery"
            ? "Queue message until session resumes"
            : "Send message";
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      onClick={onSend}
      disabled={disabled}
      className={sendButtonClass(disabled)}
    >
      {preparing ? <Spinner /> : <PaperPlaneIcon />}
    </button>
  );
}

/** Asks the agent to stop; once asked, the next press restarts it instead. */
export function StopButton({
  compact = false,
  force = false,
  escalatesAt = null,
}: {
  compact?: boolean;
  force?: boolean;
  escalatesAt?: string | null;
}) {
  const aui = useAui();
  const deadline = escalatesAt ? Date.parse(escalatesAt) : NaN;
  const now = useNow(1000, force && !Number.isNaN(deadline));
  const remaining = Number.isNaN(deadline) ? 0 : Math.ceil((deadline - now) / 1000);
  const label = force ? "Force stop" : "Stop";
  const title = force
    ? `The agent has not stopped yet. Press again to restart it now; it resumes from the saved transcript, losing partial tool output.${
        remaining > 0 ? ` It restarts by itself in ${remaining}s.` : ""
      }`
    : "Stop the agent";
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      data-force={force ? "" : undefined}
      onClick={() => aui.thread.cancelRun()}
      className={[
        "inline-flex items-center justify-center gap-1.5 rounded-lg border",
        compact ? "p-1.5" : "px-2.5 py-1.5 text-[12px]",
        "font-medium active:scale-[0.98] transition-all duration-100",
        force
          ? "border-rose-700/70 bg-rose-950/40 text-rose-300 hover:bg-rose-950/60"
          : "border-surface-600 bg-surface-800 text-text-secondary hover:border-rose-700/60 hover:bg-rose-950/30 hover:text-rose-300",
      ].join(" ")}
    >
      <Square className="h-3.5 w-3.5 fill-current" strokeWidth={0} />
      {!compact && <span className="hidden @lg:inline">{label}</span>}
    </button>
  );
}

/** Send beside Stop mid-turn. A steerable, connected agent takes the message into
 *  the running turn; otherwise it queues. */
export function QueueSendButton({
  availability,
  disabled = false,
  preparing = false,
  onSend,
}: {
  availability: Exclude<ComposerAvailability, { kind: "read_only" }>;
  disabled?: boolean;
  preparing?: boolean;
  onSend: () => void;
}) {
  const blocked = availability.kind === "blocked";
  const title = preparing
    ? "Preparing attachments…"
    : blocked
      ? "Sending is unavailable; your draft will be preserved"
      : disabled
        ? "Type a message to queue"
        : availability.kind === "queue_for_recovery"
          ? "Queue follow-up, will send on resume, Enter"
          : availability.kind === "steer_now"
            ? "Send into the current turn, Enter"
            : "Queue follow-up (sent when current turn ends), Enter";
  const label = preparing
    ? "Preparing attachments"
    : blocked
      ? "Sending unavailable"
      : availability.kind === "steer_now"
        ? "Send message into the current turn"
        : availability.kind === "queue_for_recovery"
          ? "Queue follow-up until session resumes"
          : "Queue follow-up message";
  return (
    <button
      type="button"
      aria-label={label}
      {...tourAnchor(TOUR_ANCHORS.queueSend)}
      title={title}
      onClick={onSend}
      disabled={disabled}
      className={sendButtonClass(disabled, "relative ")}
    >
      {preparing ? <Spinner /> : <PaperPlaneIcon />}
    </button>
  );
}

function PaperPlaneIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22l-4-9-9-4 20-7Z" />
    </svg>
  );
}
