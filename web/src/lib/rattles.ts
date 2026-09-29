/** Braille spinner frames from rattles (https://github.com/vyfor/rattles). */
export interface Rattle {
  frames: readonly string[];
  /** Milliseconds per frame. */
  interval: number;
}

const DOTS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const BREATHE = ["⠀", "⠂", "⠌", "⡑", "⢕", "⢝", "⣫", "⣟", "⣿", "⣟", "⣫", "⢝", "⢕", "⡑", "⠌", "⠂", "⠀"];

export const RATTLES = {
  dots: { frames: DOTS, interval: 220 },
  orbit: { frames: ["⠃", "⠉", "⠘", "⠰", "⢠", "⣀", "⡄", "⠆"], interval: 400 },
  breathe: { frames: BREATHE, interval: 180 },
  /** `breathe`, slowed for a freshly stopped session. */
  exhale: { frames: BREATHE, interval: 280 },
  /** `dots` slowed, for a session waiting on its own background work. */
  drift: { frames: DOTS, interval: 660 },
  /** `dots` at the pace of a structured turn's working line. */
  working: { frames: DOTS, interval: 80 },
} satisfies Record<string, Rattle>;
