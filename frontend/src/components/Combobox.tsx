import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { Check, ChevronsUpDown } from "lucide-react";

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
 * Radix/cmdk so the SPA needs no new UI primitives. Matches the existing
 * dark stone/lime theme and supports rich custom items (Lucide icons).
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
        className={`btn w-full justify-between font-normal ${selected ? "" : "text-base-content/50"} ${triggerClassName}`}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {selected?.icon}
          <span className={`truncate ${selected ? "" : "text-base-content/50"}`}>
            {selected?.label ?? placeholder}
          </span>
        </span>
        <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" aria-hidden="true" />
      </button>

      {open && (
        <div className="absolute z-50 mt-1.5 w-full overflow-hidden rounded-box border border-base-300 bg-base-100 shadow-lg">
          <div className="border-b border-base-300 p-2">
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
              className="input input-sm w-full"
            />
          </div>
          <div id={listId} role="listbox" aria-label={ariaLabel ?? placeholder} className="max-h-64 overflow-y-auto p-1.5">
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
                    className={`flex w-full items-center gap-2 rounded-field px-2.5 py-2 text-left text-sm transition ${
                      highlighted ? "bg-base-200" : "bg-transparent"
                    } ${active ? "text-primary" : ""}`}
                  >
                    <Check
                      className={`h-4 w-4 shrink-0 ${active ? "opacity-100" : "opacity-0"}`}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate font-medium">{option.label}</span>
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
