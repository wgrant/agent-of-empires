import { useEffect, useState, type RefObject } from "react";

/** Room for a message time beside the content column: the label plus its gap. */
const MARGIN_LABEL_PX = 96;

/** Whether the transcript is wide enough that the content column leaves a left margin for message times. */
export function useHasMessageMargin(contentRef: RefObject<HTMLElement | null>): boolean {
  const [hasMargin, setHasMargin] = useState(false);
  useEffect(() => {
    const content = contentRef.current;
    const container = content?.parentElement;
    if (!content || !container) return;
    const measure = () => {
      const padding = parseFloat(getComputedStyle(content).paddingLeft) || 0;
      setHasMargin(content.offsetLeft + padding >= MARGIN_LABEL_PX);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(content);
    return () => observer.disconnect();
  }, [contentRef]);
  return hasMargin;
}
