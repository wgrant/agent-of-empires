// What each repo's diff shows in this browser instead of its default: another
// base against the working tree, or with `head` the commit range base...head.
// Client view state only: never saved server-side, so each device views its
// own and the session's saved base override is untouched.

export interface DiffView {
  /** Workspace member name; undefined for a single-repo session. */
  repo?: string;
  base?: string;
  head?: string;
}

/** A pane block's `diff` target. */
export interface DiffTarget {
  repo?: string;
  base: string;
  head?: string;
}

const MAX_REF_LENGTH = 256;

function isRef(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    value.length <= MAX_REF_LENGTH &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

/** A block's `diff` field as a target, or null when it is not one. */
export function parseDiffTarget(value: unknown): DiffTarget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!isRef(v.base)) return null;
  if (v.head !== undefined && !isRef(v.head)) return null;
  if (v.repo !== undefined && typeof v.repo !== "string") return null;
  return {
    base: v.base.trim(),
    ...(typeof v.head === "string" ? { head: v.head.trim() } : {}),
    ...(typeof v.repo === "string" ? { repo: v.repo } : {}),
  };
}

export function viewFor(views: readonly DiffView[], repo: string | undefined): DiffView | undefined {
  return views.find((v) => v.repo === repo);
}

/** `views` with `view` replacing any for the same repo. */
export function withView(views: readonly DiffView[], view: DiffView): DiffView[] {
  return [...views.filter((v) => v.repo !== view.repo), view];
}

export function withoutView(views: readonly DiffView[], repo: string | undefined): DiffView[] {
  return views.filter((v) => v.repo !== repo);
}

/** Whether `view` shows exactly `target`, repo aside. */
export function viewMatches(view: DiffView | undefined, target: DiffTarget): boolean {
  return view !== undefined && view.base === target.base && (view.head ?? "") === (target.head ?? "");
}

/** The `views` query value for the diff file list, or null for the default view. */
export function viewsParam(views: readonly DiffView[]): string | null {
  return views.length === 0 ? null : JSON.stringify(views);
}

/** How a view reads in the pane header. */
export function viewLabel(view: DiffView, base: string): string {
  const from = view.base ?? base;
  return view.head ? `${from}...${view.head}` : `vs ${from}`;
}
