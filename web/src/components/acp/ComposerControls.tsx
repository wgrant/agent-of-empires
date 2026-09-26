// Composer footer controls: toolbar, usage hint, attachments, send/stop, popover list.

import { ComposerPrimitive, useAui } from "@assistant-ui/react";
import { LoaderCircle, Paperclip, Square, X } from "lucide-react";

import type { AcpState, PromptAttachmentInput } from "../../lib/acpTypes";
import { badgeLabel, badgeTone, resolveSkillSource, type SkillIndex } from "../../lib/skillProvenance";
import { TOUR_ANCHORS, tourAnchor } from "../../lib/tourSteps";
import { ProvenanceBadge } from "../ProvenanceBadge";
import { Tooltip } from "../Tooltip";
import type { ComposerAvailability } from "./status/conversationDiagnostics";

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
  hint,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
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
        "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-text-dim",
        "hover:bg-surface-800 hover:text-text-secondary",
        "disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-text-dim",
        "transition-colors",
      ].join(" ")}
    >
      {icon}
      {hint && <span className="font-mono">{hint}</span>}
    </button>
  );
}

function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
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

export function UsageHint({ usage }: { usage: AcpState["sessionUsage"] }) {
  if (!usage || usage.size <= 0) return null;
  const pct = Math.min(100, Math.round((usage.used / usage.size) * 100));
  const tone = pct >= 90 ? "text-rose-400" : pct >= 75 ? "text-amber-400" : "text-text-dim";
  const cost = usage.cost ? formatCost(usage.cost.amount, usage.cost.currency) : null;
  const explanation =
    `Context window: ${usage.used.toLocaleString()} of ${usage.size.toLocaleString()} tokens used (${pct}%). ` +
    `The color warms as the window fills.` +
    (cost ? ` ${cost} is cumulative session spend since the last /clear or /compact.` : "");
  // Last in the wrapping cluster: on a narrow footer it takes its own row
  // instead of pushing Stop and Send off screen.
  return (
    <span className="ml-auto pl-2">
      <Tooltip text={explanation} multiline>
        <span
          data-testid="composer-usage"
          className={`inline-flex items-center gap-1 text-[11px] tabular-nums ${tone}`}
          aria-label={explanation}
        >
          <span className="hidden sm:inline">
            {formatTokens(usage.used)}/{formatTokens(usage.size)}
          </span>
          <span className="opacity-70">
            <span className="hidden sm:inline">(</span>
            {pct}%<span className="hidden sm:inline">)</span>
          </span>
          {cost ? <span className="opacity-70">· {cost}</span> : null}
        </span>
      </Tooltip>
    </span>
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
      {preparing ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <PaperPlaneIcon />}
    </button>
  );
}

export function StopButton({ compact = false }: { compact?: boolean }) {
  const aui = useAui();
  return (
    <button
      type="button"
      aria-label="Stop"
      title="Stop the agent"
      onClick={() => aui.thread.cancelRun()}
      className={[
        "inline-flex items-center justify-center gap-1.5",
        "rounded-lg border border-surface-600 bg-surface-800",
        compact ? "px-2 py-1 text-[11px]" : "px-2.5 py-1.5 text-[12px]",
        "font-medium text-text-secondary",
        "hover:border-rose-700/60 hover:bg-rose-950/30 hover:text-rose-300",
        "active:scale-[0.98] transition-all duration-100",
      ].join(" ")}
    >
      <Square className="h-3.5 w-3.5 fill-current" strokeWidth={0} />
      <span>Stop</span>
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
      {preparing ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <PaperPlaneIcon />}
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
