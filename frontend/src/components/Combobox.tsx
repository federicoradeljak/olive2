import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { Check, ChevronDown, Search } from "lucide-react";

export interface ComboboxOption {
  value: string;
  label: string;
  description?: string;
  /** Rendered to the right of (or in place of) the label, e.g. a Lucide status icon. */
  icon?: ReactNode;
  /** Extra searchable text (matched alongside label + description). */
  keywords?: string;
}

interface ComboboxProps {
  value: string;
  onChange: (value: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  ariaLabel?: string;
  triggerClassName?: string;
}

/**
 * shadcn-style combobox (button + popover + inline search) built without
 * Radix/cmdk so the SPA needs no new UI primitives. Notion-like look: hairline
 * trigger, floating popover with a borderless search row, and rich custom
 * items (Lucide icons).
 */
export function Combobox({
  value,
  onChange,
  options,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyText = "No matches found.",
  ariaLabel,
  triggerClassName = "",
}: ComboboxProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const selected = options.find((o) => o.value === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) =>
      `${o.label} ${o.description ?? ""} ${o.keywords ?? ""}`.toLowerCase().includes(q),
    );
  }, [options, query]);

  useEffect(() => {
    setHighlight(0);
  }, [query, open]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open ]);

  const choose = (optionValue: string) => {
    onChange(optionValue);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative w-full">
      <button
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={ariaLabel ?? placeholder}
        onClick={() => setOpen((v) => !v)}
        className={`flex h-9 w-full items-center justify-between gap-2 rounded-md border border-base-content/15 bg-base-100 px-2.5 text-left text-sm font-normal transition-colors hover:bg-hover focus-visible:border-primary/60 focus-visible:outline-2 focus-visible:outline-primary/20 max-sm:h-11 ${open ? "border-primary/60" : ""} ${triggerClassName}`}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {selected?.icon}
          <span className={`truncate ${selected ? "" : "text-base-content/50"}`}>
            {selected?.label ?? placeholder}
          </span>
        </span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 opacity-60 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full min-w-56 overflow-hidden rounded-lg bg-base-100 shadow-pop">
          <label className="flex items-center gap-2 border-b border-divider px-2.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-base-content/50" aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              role="searchbox"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setHighlight((h) => Math.min(h + 1, Math.max(filtered.length - 1, 0)));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setHighlight((h) => Math.max(h - 1, 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  const target = filtered[highlight];
                  if (target) choose(target.value);
                }
              }}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-base-content/40 max-sm:h-11 [&::-webkit-search-cancel-button]:hidden"
            />
          </label>
          <div id={listId} role="listbox" aria-label={ariaLabel ?? placeholder} className="max-h-64 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-base-content/50">{emptyText}</p>
            ) : (
              filtered.map((option, index) => {
                const active = option.value === value;
                const highlighted = index === highlight;
                return (
                  <button
                    key={option.value || `__index-${index}`}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onMouseEnter={() => setHighlight(index)}
                    onClick={() => choose(option.value)}
                    className={`flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm max-sm:min-h-11 ${
                      highlighted ? "bg-hover" : "bg-transparent"
                    } ${active ? "font-medium" : ""}`}
                  >
                    <Check
                      className={`h-3.5 w-3.5 shrink-0 text-primary ${active ? "opacity-100" : "opacity-0"}`}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate">{option.label}</span>
                        {option.icon}
                      </span>
                      {option.description && (
                        <span className="block truncate text-xs text-base-content/50">{option.description}</span>
                      )}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
