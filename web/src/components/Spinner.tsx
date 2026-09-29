import { LoaderCircle } from "lucide-react";

/** The busy indicator. `className` sets its size and color; under reduced
 *  motion it holds still. */
export function Spinner({ className = "size-3.5" }: { className?: string }) {
  return (
    <LoaderCircle className={`shrink-0 animate-spin motion-reduce:animate-none ${className}`} aria-hidden="true" />
  );
}
