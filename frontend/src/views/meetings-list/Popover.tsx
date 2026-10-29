import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";

/**
 * Small anchored menu rendered in a portal with fixed positioning, so it is
 * never clipped by horizontally scrolling chip rows or table wrappers.
 * Closes on outside click, Escape, resize and page scroll.
 */
export function Popover({
  anchor,
  onClose,
  align = "start",
  width = 224,
  label,
  children,
}: {
  anchor: HTMLElement | null;
  onClose: () => void;
  align?: "start" | "end";
  width?: number;
  label: string;
  children: ReactNode;
}): ReactElement | null {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(width, vw - 16);
    let left = align === "start" ? rect.left : rect.right - w;
    left = Math.max(8, Math.min(left, vw - w - 8));
    const height = ref.current?.offsetHeight ?? 0;
    let top = rect.bottom + 4;
    if (height && top + height > vh - 8 && rect.top - height - 4 > 8) {
      top = rect.top - height - 4;
    }
    setPos({ top, left });
  }, [anchor, align, width]);

  useEffect(() => {
    const onDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    const onScroll = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width: `min(${width}px, calc(100vw - 16px))` }}
      className="fixed z-[60] max-h-[min(24rem,70vh)] overflow-y-auto rounded-lg bg-base-100 p-1 text-sm text-base-content shadow-pop"
    >
      {children}
    </div>,
    document.body
  );
}

export function MenuItem({
  onSelect,
  icon,
  checked,
  danger = false,
  disabled = false,
  children,
}: {
  onSelect: () => void;
  icon?: ReactNode;
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  children: ReactNode;
}): ReactElement {
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-checked={checked}
      disabled={disabled}
      onClick={onSelect}
      className={`flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-hover disabled:opacity-50 sm:min-h-8 ${
        danger ? "text-error" : ""
      }`}
    >
      {icon && <span className="flex w-4 shrink-0 justify-center text-base-content/60">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {checked !== undefined && (
        <Check className={`h-4 w-4 shrink-0 text-primary ${checked ? "" : "invisible"}`} aria-hidden="true" />
      )}
    </button>
  );
}

export function MenuDivider(): ReactElement {
  return <div role="separator" className="my-1 h-px bg-base-content/10" />;
}
