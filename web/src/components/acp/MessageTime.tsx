// When a message was sent, shown on hover or after a tap: in the transcript's
// left margin when it has one, else in the gap under the message.

import { useAuiState } from "@assistant-ui/react";

import { messageTimeLabel } from "../../lib/messageTime";
import { formatDateTime } from "../../lib/timeFormat";

const MARGIN =
  "group-data-[message-margin]/transcript:top-1 group-data-[message-margin]/transcript:right-full group-data-[message-margin]/transcript:left-auto group-data-[message-margin]/transcript:mt-0 group-data-[message-margin]/transcript:mr-3 group-data-[message-margin]/transcript:flex-col group-data-[message-margin]/transcript:items-end group-data-[message-margin]/transcript:gap-0";

export function MessageTime({ tapped, align }: { tapped: boolean; align: "start" | "end" }) {
  const createdAt = useAuiState((s) => s.message.createdAt);
  if (!createdAt || !Number.isFinite(createdAt.getTime())) return null;
  const { date, time } = messageTimeLabel(createdAt);
  return (
    <time
      dateTime={createdAt.toISOString()}
      title={formatDateTime(createdAt)}
      data-testid="message-time"
      className={[
        "absolute top-full mt-0.5 flex gap-1 whitespace-nowrap font-mono text-[11px] leading-tight text-text-dim",
        align === "end" ? "right-0" : "left-0",
        MARGIN,
        tapped ? "opacity-100" : "opacity-0 group-hover:opacity-100",
      ].join(" ")}
    >
      {date && <span>{date}</span>}
      <span>{time}</span>
    </time>
  );
}
