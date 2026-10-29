import { useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";

export interface ActionMenuItem {
  label: string;
  icon?: ReactNode;
  description?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

/* Small "⋯" popover menu: secondary and destructive actions live here so each
   screen keeps one visible primary action. Closes on outside click and Esc. */
export function ActionMenu({
  label,
  items,
  align = "right",
  buttonClassName = "",
}: {
  label: string;
  items: Array<ActionMenuItem | "divider">;
  align?: "left" | "right";
  buttonClassName?: string;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex h-11 w-11 items-center justify-center rounded-md text-base-content/60 transition hover:bg-hover hover:text-base-content lg:h-8 lg:w-8 ${buttonClassName}`}
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={label}
          className={`absolute top-full z-40 mt-1 w-64 max-w-[calc(100vw-2rem)] rounded-lg bg-base-100 p-1 shadow-pop ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {items.map((item, idx) =>
            item === "divider" ? (
              <div key={`d${idx}`} role="separator" className="my-1 border-t border-divider" />
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
                className={`flex min-h-11 w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-0 ${
                  item.danger ? "text-error" : "text-base-content"
                }`}
              >
                {item.icon && <span className="mt-0.5 shrink-0 opacity-70">{item.icon}</span>}
                <span className="min-w-0 flex-1">
                  <span className="block">{item.label}</span>
                  {item.description && <span className="block text-xs text-base-content/60">{item.description}</span>}
                </span>
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
