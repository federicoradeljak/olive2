import { useEffect, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { Check } from "lucide-react";
import { isGenericSpeakerLabel } from "../../lib/common";

/* ------------------------------------------------------------------ */
/* Dropdown menu                                                       */
/* ------------------------------------------------------------------ */

export interface MenuItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  title?: string;
}

export type MenuEntry = MenuItem | "divider" | null | false | undefined;

/**
 * Small popover menu (button + list). Closes on outside click, Escape, or
 * after picking an item. Items keep 44px touch targets below lg.
 */
export function Menu({
  trigger,
  ariaLabel,
  items,
  align = "right",
  triggerClassName = "",
  menuClassName = "",
  title,
}: {
  trigger: ReactNode;
  ariaLabel: string;
  items: MenuEntry[];
  align?: "left" | "right";
  triggerClassName?: string;
  menuClassName?: string;
  title?: string;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const entries = items.filter((e): e is MenuItem | "divider" => Boolean(e));

  return (
    <div
      className="relative shrink-0"
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={title}
        onClick={() => setOpen((prev) => !prev)}
        className={triggerClassName}
      >
        {trigger}
      </button>
      {open && (
        <>
          <button type="button" aria-label="Close menu" tabIndex={-1} onClick={() => setOpen(false)} className="fixed inset-0 z-40 cursor-default" />
          <div
            role="menu"
            className={`absolute top-full z-50 mt-1 min-w-[210px] max-w-[calc(100vw-2rem)] rounded-box bg-base-100 p-1 shadow-pop ${
              align === "right" ? "right-0" : "left-0"
            } ${menuClassName}`}
          >
            {entries.map((entry, idx) =>
              entry === "divider" ? (
                <div key={`divider-${idx}`} role="separator" className="my-1 border-t border-divider" />
              ) : (
                <button
                  key={entry.key}
                  type="button"
                  role={entry.checked === undefined ? "menuitem" : "menuitemradio"}
                  aria-checked={entry.checked}
                  disabled={entry.disabled}
                  title={entry.title}
                  onClick={() => {
                    setOpen(false);
                    entry.onSelect();
                  }}
                  className={`flex min-h-11 w-full items-center gap-2.5 rounded-field px-2.5 text-left text-sm transition hover:bg-hover focus-visible:bg-hover disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-9 ${
                    entry.danger ? "text-error" : "text-base-content"
                  }`}
                >
                  {entry.icon !== undefined && (
                    <span className={`inline-flex w-4 shrink-0 justify-center ${entry.danger ? "" : "text-base-content/60"}`}>{entry.icon}</span>
                  )}
                  <span className="min-w-0 flex-1">{entry.label}</span>
                  {entry.checked && <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />}
                </button>
              )
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Segmented control                                                   */
/* ------------------------------------------------------------------ */

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  role = "radiogroup",
  className = "",
  size = "md",
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  ariaLabel: string;
  role?: "radiogroup" | "tablist";
  className?: string;
  size?: "sm" | "md";
}): ReactElement {
  const itemRole = role === "tablist" ? "tab" : "radio";
  return (
    <div
      role={role}
      aria-label={ariaLabel}
      className={`grid rounded-lg bg-hover p-[3px] ${className}`}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((opt) => {
        const on = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role={itemRole}
            aria-checked={itemRole === "radio" ? on : undefined}
            aria-selected={itemRole === "tab" ? on : undefined}
            onClick={() => onChange(opt.value)}
            className={`truncate rounded-md px-2 text-sm transition ${size === "sm" ? "h-7" : "h-9"} ${
              on ? "bg-base-100 font-semibold text-base-content shadow-sm" : "text-base-content/60 hover:text-base-content"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Modal footer (Cancel + primary, right-aligned)                      */
/* ------------------------------------------------------------------ */

export function ModalFooter({ children, className = "" }: { children: ReactNode; className?: string }): ReactElement {
  return <div className={`-mx-6 mt-6 flex items-center justify-end gap-2 border-t border-divider px-6 pt-4 ${className}`}>{children}</div>;
}

/** Field label used across the meeting modals (sentence case, no eyebrow). */
export function FieldLabel({ children, htmlFor }: { children: ReactNode; htmlFor?: string }): ReactElement {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-[13px] font-medium text-base-content/60">
      {children}
    </label>
  );
}

/* ------------------------------------------------------------------ */
/* Speaker colors                                                      */
/* ------------------------------------------------------------------ */

const SPEAKER_TONES = ["green", "purple", "blue", "orange", "pink", "brown", "yellow", "red"] as const;
export type SpeakerTone = (typeof SPEAKER_TONES)[number] | "gray";

/** Deterministic Notion tag color for a speaker label; generic labels stay gray. */
export function speakerTone(name: string): SpeakerTone {
  if (isGenericSpeakerLabel(name)) return "gray";
  let hash = 0;
  const key = name.trim().toLowerCase();
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return SPEAKER_TONES[Math.abs(hash) % SPEAKER_TONES.length];
}

export function speakerInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) {
    const m = parts[0].match(/^([A-Za-z]+)\s*(\d+)$/);
    if (m) return `${m[1][0].toUpperCase()}${m[2]}`.slice(0, 3);
    return parts[0].slice(0, 2).toUpperCase();
  }
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

/* ------------------------------------------------------------------ */
/* Browser helpers                                                     */
/* ------------------------------------------------------------------ */

export function downloadText(filename: string, content: string, mime = "text/plain"): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFilename(title: string): string {
  return title.replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, " ").trim().slice(0, 120) || "meeting";
}

/** In-app navigation without a full reload: App listens to popstate. */
export function navigateTo(path: string): void {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo({ top: 0 });
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false));
  useEffect(() => {
    if (!window.matchMedia) return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

export function Spinner({ className = "h-4 w-4" }: { className?: string }): ReactElement {
  return <span className={`loading loading-spinner ${className}`} aria-hidden="true" />;
}
