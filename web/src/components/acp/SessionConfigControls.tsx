// Model and reasoning-effort pickers from the agent's config options. Pessimistic:
// the current value changes only when the adapter confirms; the pending choice is disabled.

import { ChevronUp } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import type { ConfigOptionChoice, ConfigOptionDescriptor, AcpState } from "../../lib/acpTypes";
import { ActionFeedbackNotice } from "./status/ActionFeedbackNotice";

interface Props {
  configOptions: AcpState["configOptions"];
  pendingConfigOption: AcpState["pendingConfigOption"];
  onSetConfigOption: (configId: string, value: string) => void | Promise<void>;
  /** Pinned LLM backend, or null when the host environment decides. */
  provider?: string | null;
  /** The provider value in flight, if any. */
  providerPending?: string | null;
  /** Absent for a session whose agent does not route through a provider. */
  onSetProvider?: (provider: string) => void | Promise<void>;
  /** Why the provider cannot change right now, if it cannot. */
  providerLockedReason?: string | null;
  selectedLabel?: string;
}

const MODEL_LABEL_MAX = 24;
/** Synthetic id; aoe owns this pick, so it is not an agent config option. */
const PROVIDER_OPTION_ID = "aoe-provider";
const PROVIDERS: ConfigOptionChoice[] = [
  { value: "api", name: "Anthropic API", description: "Direct api.anthropic.com" },
  { value: "bedrock", name: "Bedrock", description: "AWS credentials from the host" },
  { value: "vertex", name: "Vertex AI", description: "GCP credentials from the host" },
];
// The floor only picks the open direction; height always clamps to the available space.
const MENU_MAX_HEIGHT_CAP = 288;
/** A searchable menu holds a long list, so it may use more of the screen. */
const SEARCHABLE_MENU_MAX_HEIGHT_CAP = 420;
const MENU_MAX_HEIGHT_FLOOR = 120;
const MENU_VIEWPORT_MARGIN = 8;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + "…";
}

function findByCategory(
  options: ConfigOptionDescriptor[],
  category: "model" | "thought_level",
): ConfigOptionDescriptor | undefined {
  return options.find((o) => o.category === category);
}

/** Reuses the config-option dropdown so the provider pick gets its placement,
 *  keyboard handling and pending state for free. While unpinned the list leads
 *  with a non-selectable entry naming that state: the dropdown already refuses
 *  to re-pick the current value, and there is no way back to unpinned once a
 *  provider is chosen. */
function providerDescriptor(provider: string | null | undefined): ConfigOptionDescriptor {
  return {
    id: PROVIDER_OPTION_ID,
    name: "Provider",
    category: "provider",
    current_value: provider ?? "",
    options: provider
      ? PROVIDERS
      : [{ value: "", name: "Host default", description: "Set by the host environment" }, ...PROVIDERS],
  };
}

export function SessionConfigControls({
  configOptions,
  pendingConfigOption,
  onSetConfigOption,
  provider,
  providerPending,
  onSetProvider,
  providerLockedReason,
  selectedLabel,
}: Props) {
  const model = findByCategory(configOptions, "model");
  const effort = findByCategory(configOptions, "thought_level");

  if (!model && !effort && !onSetProvider) return null;

  return (
    <div data-testid="session-config-controls" className="flex flex-col gap-2">
      {model && (
        <ConfigRow label={model.name}>
          <ModelDropdown
            option={model}
            pending={pendingConfigOption?.configId === model.id ? pendingConfigOption.value : null}
            onSelect={(value) => onSetConfigOption(model.id, value)}
            selectedLabel={selectedLabel}
          />
        </ConfigRow>
      )}
      {effort && (
        <ConfigRow label={effort.name}>
          <ModelDropdown
            option={effort}
            pending={pendingConfigOption?.configId === effort.id ? pendingConfigOption.value : null}
            onSelect={(value) => onSetConfigOption(effort.id, value)}
            selectedLabel={selectedLabel}
          />
        </ConfigRow>
      )}
      {onSetProvider && (
        <ModelDropdown
          option={providerDescriptor(provider)}
          pending={providerPending ?? null}
          onSelect={(value) => onSetProvider(value)}
          lockedReason={providerLockedReason}
        />
      )}
    </div>
  );
}

export function ConfigRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-text-secondary">{label}</span>
      {children}
    </div>
  );
}

interface SubProps {
  option: ConfigOptionDescriptor;
  /** The value in flight for this option, if any. */
  pending: string | null;
  onSelect: (value: string) => void | Promise<void>;
  /** Disables the trigger and explains why. */
  lockedReason?: string | null;
  selectedLabel?: string;
}

interface MenuLayout {
  direction: "up" | "down";
  maxHeight: number;
  /** Anchor to the trigger's right edge: its left edge leaves no room for the menu. */
  alignRight: boolean;
}

/** The menu's `w-64`. */
const MENU_WIDTH = 256;

const DEFAULT_MENU_LAYOUT: MenuLayout = { direction: "up", maxHeight: MENU_MAX_HEIGHT_CAP, alignRight: false };

/** Open upward when a floor's worth of room exists, else toward the roomier side.
 *  Uses the visual viewport: iOS `innerHeight` ignores the keyboard, and a zoom offset
 *  shifts both visible edges. */
function computeMenuLayout(
  rect: DOMRect,
  viewportHeight: number,
  viewportTop = 0,
  viewportWidth = Infinity,
  cap = MENU_MAX_HEIGHT_CAP,
  preferRoomierSide = false,
): MenuLayout {
  const spaceAbove = rect.top - viewportTop - MENU_VIEWPORT_MARGIN;
  const spaceBelow = viewportTop + viewportHeight - rect.bottom - MENU_VIEWPORT_MARGIN;
  let direction: "up" | "down";
  let available: number;
  if (preferRoomierSide) {
    direction = spaceBelow > spaceAbove ? "down" : "up";
    available = Math.max(spaceAbove, spaceBelow);
  } else if (spaceAbove >= MENU_MAX_HEIGHT_FLOOR) {
    direction = "up";
    available = spaceAbove;
  } else if (spaceBelow >= MENU_MAX_HEIGHT_FLOOR || spaceBelow > spaceAbove) {
    direction = "down";
    available = spaceBelow;
  } else {
    direction = "up";
    available = spaceAbove;
  }
  return {
    direction,
    maxHeight: Math.max(0, Math.min(cap, available)),
    alignRight: rect.left + MENU_WIDTH > viewportWidth - MENU_VIEWPORT_MARGIN && rect.right >= MENU_WIDTH,
  };
}

/** A config option's values as a dropdown. */
function ModelDropdown({ option, pending, onSelect, selectedLabel, lockedReason }: SubProps) {
  return (
    <ChoiceDropdown
      label={option.name}
      choices={option.options}
      current={option.current_value}
      pending={pending}
      onSelect={onSelect}
      testId={`config-option-${option.id}`}
      lockedReason={lockedReason}
      selectedLabel={selectedLabel}
    />
  );
}

/** Past this many, a menu gets a filter. */
const SEARCH_THRESHOLD = 12;

/** Every name reads `Provider/Model`: group under the provider and show the rest. */
function providerGroups(choices: readonly Choice[]): Map<string, Choice[]> | null {
  if (!choices.every((c) => c.name.indexOf("/") > 0)) return null;
  const groups = new Map<string, Choice[]>();
  for (const choice of choices) {
    const provider = choice.name.slice(0, choice.name.indexOf("/"));
    groups.set(provider, [...(groups.get(provider) ?? []), choice]);
  }
  return groups.size > 1 ? groups : null;
}

/** Lower case, with separators such as `-` and `/` read as spaces. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s\-_/.:]+/g, " ");
}

/** The choices with every query term in their name or value, whole-phrase
 *  matches first: "gpt 5" puts GPT-5 ahead of GPT-3.5. */
function search(choices: readonly Choice[], query: string): Choice[] {
  const phrase = normalize(query).trim();
  const terms = phrase.split(" ");
  const found = choices.filter((c) => {
    const haystack = normalize(`${c.name} ${c.value}`);
    return terms.every((term) => haystack.includes(term));
  });
  const phraseFirst = (c: Choice) => (normalize(c.name).includes(phrase) ? 0 : 1);
  return found.sort((a, b) => phraseFirst(a) - phraseFirst(b));
}

export interface Choice {
  value: string;
  name: string;
  description?: string | null;
}

/** One value from a list, the dialog's single kind of picker: a button naming
 *  the current value that opens a menu of the rest, with any descriptions. */
export function ChoiceDropdown({
  label,
  choices,
  current,
  pending = null,
  onSelect,
  testId,
  note,
  lockedReason,
  selectedLabel = "Active",
}: {
  label: string;
  choices: readonly Choice[];
  current: string;
  /** The value in flight, disabled until confirmed. */
  pending?: string | null;
  onSelect: (value: string) => void | Promise<void>;
  /** Names the trigger; each item is `${testId}-value-${value}`. */
  testId: string;
  /** A line under the menu's heading. */
  note?: string;
  lockedReason?: string | null;
  selectedLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [menuLayout, setMenuLayout] = useState<MenuLayout>(DEFAULT_MENU_LAYOUT);
  const ref = useRef<HTMLDivElement | null>(null);
  const menuId = `${testId}-menu`;
  const searchable = choices.length > SEARCH_THRESHOLD;
  const shownChoices = query.trim() ? search(choices, query) : choices;
  const groups = providerGroups(shownChoices);
  const selected = choices.find((c) => c.value === current) ?? choices[0];
  const shown = selected?.name ?? current;
  const choose = (choice: Choice) => {
    setOpen(false);
    setQuery("");
    if (choice.value === pending || choice.value === current) return;
    void onSelect(choice.value);
  };

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // visualViewport events catch the soft keyboard, which fires no window resize.
  useLayoutEffect(() => {
    if (!open) return;
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    const recompute = () => {
      const rect = ref.current?.getBoundingClientRect();
      if (!rect) return;
      // Dialog bodies clip menus independently of the screen's viewport.
      const body = ref.current?.closest("[data-dialog-body]")?.getBoundingClientRect();
      const viewportTop = Math.max(vv?.offsetTop ?? 0, body?.top ?? -Infinity);
      const viewportBottom = Math.min(
        (vv?.offsetTop ?? 0) + (vv?.height ?? window.innerHeight),
        body?.bottom ?? Infinity,
      );
      setMenuLayout(
        computeMenuLayout(
          rect,
          Math.max(0, viewportBottom - viewportTop),
          viewportTop,
          vv?.width ?? window.innerWidth,
          body ? viewportBottom - viewportTop : searchable ? SEARCHABLE_MENU_MAX_HEIGHT_CAP : MENU_MAX_HEIGHT_CAP,
          !!body,
        ),
      );
    };
    recompute();
    window.addEventListener("resize", recompute);
    window.addEventListener("scroll", recompute, true);
    vv?.addEventListener("resize", recompute);
    vv?.addEventListener("scroll", recompute);
    return () => {
      window.removeEventListener("resize", recompute);
      window.removeEventListener("scroll", recompute, true);
      vv?.removeEventListener("resize", recompute);
      vv?.removeEventListener("scroll", recompute);
    };
  }, [open, searchable]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={!!lockedReason}
        onClick={() => {
          setOpen((v) => !v);
          setQuery("");
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={lockedReason ?? `${label}: ${shown}`}
        aria-label={`${label}: ${shown}`}
        data-testid={testId}
        className={[
          "inline-flex items-center gap-1 rounded-md border border-surface-700 bg-surface-800/60 px-2 py-1 text-[11px] font-medium",
          "text-text-secondary",
          "transition-colors hover:border-brand-600/60 hover:text-text-primary",
          "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-surface-700 disabled:hover:text-text-secondary",
        ].join(" ")}
      >
        <span>{truncate(shown, MODEL_LABEL_MAX)}</span>
        <ChevronUp className="h-3 w-3 opacity-70" />
      </button>
      {open && (
        <div
          id={menuId}
          className={[
            "absolute z-30 flex w-64 flex-col overflow-hidden rounded-md border border-surface-700 bg-surface-850 shadow-xl",
            menuLayout.alignRight ? "right-0" : "left-0",
            menuLayout.direction === "up" ? "bottom-full mb-1" : "top-full mt-1",
          ].join(" ")}
          style={{ maxHeight: menuLayout.maxHeight }}
          role="menu"
        >
          <div className="shrink-0 border-b border-surface-800 px-3 py-1.5">
            <div className="text-[10px] uppercase tracking-wider text-text-dim">{label}</div>
            {note && <div className="mt-0.5 text-[11px] text-text-dim">{note}</div>}
            {searchable && (
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && shownChoices[0]) choose(shownChoices[0]);
                }}
                // A phone's keyboard would cover the menu it opens with.
                autoFocus={window.matchMedia?.("(hover: hover)").matches ?? false}
                placeholder={`Search ${choices.length}…`}
                aria-label={`Search ${label}`}
                data-testid={`${testId}-search`}
                className="mt-1.5 w-full rounded border border-surface-700 bg-surface-900 px-2 py-1 text-[12px] text-text-primary placeholder:text-text-dim focus:border-brand-600 focus:outline-none"
              />
            )}
          </div>
          <div className="min-h-0 overflow-y-auto">
            {shownChoices.length === 0 && <div className="px-3 py-2 text-[12px] text-text-dim">No matches</div>}
            {groups
              ? [...groups].map(([provider, members]) => (
                  <div key={provider}>
                    <div className="sticky top-0 bg-surface-850 px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-text-dim">
                      {provider}
                    </div>
                    {members.map((choice) => (
                      <ChoiceItem
                        key={choice.value}
                        choice={choice}
                        name={choice.name.slice(provider.length + 1)}
                        current={current}
                        pending={pending}
                        onChoose={choose}
                        testId={testId}
                        selectedLabel={selectedLabel}
                      />
                    ))}
                  </div>
                ))
              : shownChoices.map((choice) => (
                  <ChoiceItem
                    key={choice.value}
                    choice={choice}
                    name={choice.name}
                    current={current}
                    pending={pending}
                    onChoose={choose}
                    testId={testId}
                    selectedLabel={selectedLabel}
                  />
                ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ChoiceItem({
  choice,
  name,
  current,
  pending,
  onChoose,
  testId,
  selectedLabel,
}: {
  choice: Choice;
  name: string;
  current: string;
  pending: string | null;
  onChoose: (choice: Choice) => void;
  testId: string;
  selectedLabel: string;
}) {
  const isCurrent = choice.value === current;
  const isPending = pending === choice.value;
  return (
    <button
      type="button"
      role="menuitem"
      disabled={isPending}
      onClick={() => onChoose(choice)}
      data-testid={`${testId}-value-${choice.value}`}
      className={[
        "flex w-full items-start gap-2 px-3 py-1.5 text-left text-[12px]",
        isCurrent
          ? "bg-surface-800 text-text-primary"
          : "text-text-secondary hover:bg-surface-800 hover:text-text-primary",
        isPending ? "cursor-not-allowed opacity-50" : "",
      ].join(" ")}
    >
      <span className="flex-1">
        <span className="block font-medium">{name}</span>
        {choice.description && <span className="block text-[11px] text-text-dim">{choice.description}</span>}
      </span>
      {isCurrent && !isPending && <span className="text-[10px] uppercase text-brand-500">{selectedLabel}</span>}
      {isPending && <span className="text-[10px] uppercase text-text-dim">…</span>}
    </button>
  );
}

interface NoticeProps {
  failure: AcpState["configOptionSwitchFailed"];
  configOptions: AcpState["configOptions"];
  onDismiss: () => void;
}

/** The adapter rejected a config change; the reducer clears this once a snapshot confirms the value. */
export function ConfigOptionSwitchFailedNotice({ failure, configOptions, onDismiss }: NoticeProps) {
  if (!failure) return null;
  const config = configOptions.find((c) => c.id === failure.configId);
  const optionLabel = config?.options.find((o) => o.value === failure.value)?.name ?? failure.value;
  const configLabel = config?.name ?? failure.configId;
  return (
    <ActionFeedbackNotice
      testId="config-option-switch-failed-notice"
      title={`${configLabel} could not switch to ${optionLabel}`}
      detail={failure.reason}
      onDismiss={onDismiss}
      dismissLabel="Dismiss notice"
    />
  );
}
