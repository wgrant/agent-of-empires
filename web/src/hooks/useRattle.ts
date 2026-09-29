import { useEffect, useState } from "react";

import type { Rattle } from "../lib/rattles";
import { useMediaQuery } from "./useMediaQuery";

const frameAt = (rattle: Rattle, epoch: number) =>
  Math.floor((Date.now() - epoch) / rattle.interval) % rattle.frames.length;

/** `rattle`'s frame now, counted from `epoch` so glyphs sharing one keep step.
 *  Under reduced motion it holds the first frame. */
export function useRattle(rattle: Rattle | undefined, epoch = 0): string | undefined {
  const still = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [frame, setFrame] = useState(() => (rattle ? frameAt(rattle, epoch) : 0));

  useEffect(() => {
    if (!rattle || still) return;
    const tick = () => setFrame(frameAt(rattle, epoch));
    const initial = setTimeout(tick, 0);
    const id = setInterval(tick, rattle.interval);
    return () => {
      clearTimeout(initial);
      clearInterval(id);
    };
  }, [rattle, epoch, still]);

  if (!rattle) return undefined;
  return rattle.frames[still ? 0 : frame % rattle.frames.length];
}
