import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactElement, ReactNode, TextareaHTMLAttributes } from "react";
import { CircleAlert, CircleCheck, Info, Moon, Sun, TriangleAlert, X } from "lucide-react";

/* ------------------------------------------------------------------ */
/* Button                                                              */
/* ------------------------------------------------------------------ */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "dangerSoft" | "warning" | "tonal";
type ButtonSize = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  square?: boolean;
  circle?: boolean;
}

/* Notion-like buttons: flat, 1px hairline for the neutral ones, olive fill
   for the primary action. Hover uses the shared --hover tint. */
const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "btn-primary border-0",
  secondary: "border-base-content/15 bg-transparent hover:bg-hover",
  ghost: "btn-ghost border-0 hover:bg-hover",
  danger: "btn-error border-0",
  dangerSoft: "border-0 bg-transparent text-error hover:bg-error/10",
  warning: "btn-warning border-0",
  tonal: "border-0 bg-primary/10 text-primary hover:bg-primary/15",
};

export const BUTTON_BASE = "btn rounded-md font-medium shadow-none max-sm:min-h-11";

export function Button({
  variant = "secondary",
  size = "md",
  square = false,
  circle = false,
  className = "",
  type = "button",
  ...rest
}: ButtonProps): ReactElement {
  return (
    <button
      type={type}
      className={`${BUTTON_BASE} ${BUTTON_VARIANTS[variant]} ${size === "sm" ? "btn-sm text-[13px]" : "h-9 text-sm"} ${square ? "btn-square max-sm:min-w-11" : ""} ${circle ? "btn-circle max-sm:min-w-11" : ""} ${className}`}
      {...rest}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Form controls                                                       */
/* ------------------------------------------------------------------ */

const FIELD_BASE =
  "border-base-content/15 bg-base-100 shadow-none focus:border-primary/60 focus:outline-2 focus:outline-offset-0 focus:outline-primary/20 focus-within:border-primary/60 focus-within:outline-2 focus-within:outline-offset-0 focus-within:outline-primary/20";

export function Input({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>): ReactElement {
  return <input className={`input h-9 w-full rounded-md text-sm ${FIELD_BASE} max-sm:h-11 ${className}`} {...rest} />;
}

export function Textarea({ className = "", ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>): ReactElement {
  return <textarea className={`textarea w-full rounded-md text-sm ${FIELD_BASE} ${className}`} {...rest} />;
}

export function Checkbox({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>): ReactElement {
  return <input type="checkbox" className={`checkbox checkbox-sm rounded checkbox-primary ${className}`} {...rest} />;
}

export function Radio({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>): ReactElement {
  return <input type="radio" className={`radio radio-sm radio-primary ${className}`} {...rest} />;
}

export function Toggle({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>): ReactElement {
  return <input type="checkbox" role="switch" className={`toggle toggle-sm toggle-primary ${className}`} {...rest} />;
}

export function Range({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>): ReactElement {
  return <input type="range" className={`range range-xs range-primary w-full ${className}`} {...rest} />;
}

export function FileInput({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>): ReactElement {
  return <input type="file" className={`file-input file-input-sm w-full rounded-md ${FIELD_BASE} max-sm:h-11 ${className}`} {...rest} />;
}

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
}): ReactElement {
  const errorId = htmlFor ? `${htmlFor}-error` : undefined;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-[13px] font-medium text-base-content/70">
        {label}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-base-content/60">{hint}</p>}
      {error && (
        <p id={errorId} role="alert" className="text-xs text-error">
          {error}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Badge                                                               */
/* ------------------------------------------------------------------ */

type BadgeVariant = "neutral" | "success" | "warning" | "error" | "info" | "primary" | "ghost" | "outline";

/* Badges render as Notion tag pills (see `.tag` in styles.css). */
const BADGE_VARIANTS: Record<BadgeVariant, string> = {
  neutral: "",
  success: "tag-green",
  warning: "tag-yellow",
  error: "tag-red",
  info: "tag-blue",
  primary: "tag-green",
  ghost: "bg-transparent!",
  outline: "bg-transparent! border border-divider",
};

export function Badge({
  variant = "neutral",
  soft = false,
  className = "",
  children,
}: {
  variant?: BadgeVariant;
  soft?: boolean;
  className?: string;
  children: ReactNode;
}): ReactElement {
  return <span className={`tag text-xs ${BADGE_VARIANTS[variant]} ${soft ? "" : "font-medium"} ${className}`}>{children}</span>;
}

/* ------------------------------------------------------------------ */
/* Card                                                                */
/* ------------------------------------------------------------------ */

export function Card({ className = "", children }: { className?: string; children: ReactNode }): ReactElement {
  return <div className={`card card-sm rounded-xl border border-base-content/10 bg-base-100 ${className}`}>{children}</div>;
}

export function CardBody({ className = "", children }: { className?: string; children: ReactNode }): ReactElement {
  return <div className={`card-body ${className}`}>{children}</div>;
}

export function CardTitle({ className = "", children }: { className?: string; children: ReactNode }): ReactElement {
  return <h3 className={`card-title text-base font-semibold ${className}`}>{children}</h3>;
}

export function CardActions({ className = "", children }: { className?: string; children: ReactNode }): ReactElement {
  return <div className={`card-actions ${className}`}>{children}</div>;
}

/* ------------------------------------------------------------------ */
/* Modal (same public API as the legacy inline Modal)                  */
/* ------------------------------------------------------------------ */

/* Footer row for modals: hairline on top, actions right-aligned. Pass it as
   `footer` so it stays pinned while the body scrolls. */
export function ModalFooter({ className = "", children }: { className?: string; children: ReactNode }): ReactElement {
  return (
    <div className={`flex flex-wrap items-center justify-end gap-2 border-t border-divider px-5 py-3.5 ${className}`}>{children}</div>
  );
}

export function Modal({
  onClose,
  title,
  ariaLabel,
  maxWidth = "max-w-lg",
  footer,
  children,
}: {
  onClose: () => void;
  title: ReactNode;
  ariaLabel: string;
  maxWidth?: string;
  /** Optional pinned footer (use <ModalFooter>). */
  footer?: ReactNode;
  children: ReactNode;
}): ReactElement {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Move focus into the dialog and give it back to the opener on close.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
    return () => previous?.focus?.({ preventScroll: true });
  }, []);

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-3 sm:p-6" role="dialog" aria-modal="true" aria-label={ariaLabel}>
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close dialog"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/45 [[data-theme=olive-dark]_&]:bg-black/60"
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`relative flex max-h-[90dvh] w-full ${maxWidth} flex-col overflow-hidden rounded-xl bg-base-100 text-base-content shadow-pop outline-none`}
      >
        <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-1.5">
          <h2 id={titleId} className="min-w-0 flex-1 text-[17px] font-semibold leading-snug">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-base-content/60 hover:bg-hover hover:text-base-content max-sm:h-11 max-sm:w-11"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pt-2.5 pb-5 text-sm">{children}</div>
        {footer}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactElement | null {
  if (!open) return null;
  return (
    <Modal
      onClose={onCancel}
      title={title}
      ariaLabel={title}
      maxWidth="max-w-md"
      footer={
        <ModalFooter>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} disabled={busy} autoFocus>
            {busy && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
            {confirmLabel}
          </Button>
        </ModalFooter>
      }
    >
      <div className="text-sm leading-relaxed text-base-content/80">{message}</div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Toast                                                               */
/* ------------------------------------------------------------------ */

type ToastTone = "info" | "success" | "warning" | "error";

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

const ToastContext = createContext<(tone: ToastTone, message: string) => void>(() => {});

export function useToast(): (tone: ToastTone, message: string) => void {
  return useContext(ToastContext);
}

let toastSeq = 1;

type NotifyFn = (tone: ToastTone, message: string) => void;

let globalNotify: NotifyFn = (tone, message) => {
  pendingToasts.push({ tone, message });
};
const pendingToasts: { tone: ToastTone; message: string }[] = [];

export function notify(tone: ToastTone, message: string): void {
  globalNotify(tone, message);
}

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}

let confirmSeq = 1;
interface ConfirmRequest extends ConfirmOptions {
  id: number;
  resolve: (value: boolean) => void;
}

let requestConfirm: (req: Omit<ConfirmRequest, "id" | "resolve">) => Promise<boolean> = () =>
  Promise.resolve(window.confirm("Confirm?"));

export function confirmAction(opts: ConfirmOptions): Promise<boolean> {
  return requestConfirm(opts);
}

export function ConfirmHost(): ReactElement {
  const [current, setCurrent] = useState<ConfirmRequest | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    requestConfirm = (opts) =>
      new Promise<boolean>((resolve) => {
        setBusy(false);
        setCurrent({ ...opts, id: confirmSeq++, resolve });
      });
    return () => {
      requestConfirm = () => Promise.resolve(window.confirm("Confirm?"));
    };
  }, []);

  if (!current) return <></>;

  const settle = (value: boolean) => {
    setBusy(true);
    const req = current;
    setCurrent(null);
    setBusy(false);
    req.resolve(value);
  };

  return (
    <ConfirmDialog
      open
      title={current.title}
      message={current.message}
      confirmLabel={current.confirmLabel ?? (current.danger ? "Delete" : "Confirm")}
      danger={current.danger}
      busy={busy}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  );
}

const TOAST_ICONS: Record<ToastTone, ReactElement> = {
  info: <Info className="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden="true" />,
  success: <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />,
  warning: <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />,
  error: <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-error" aria-hidden="true" />,
};

export function ToastProvider({ children }: { children: ReactNode }): ReactElement {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const push = useCallback((tone: ToastTone, message: string) => {
    const id = toastSeq++;
    setToasts((prev) => [...prev.slice(-3), { id, tone, message }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 6000);
  }, []);

  useEffect(() => {
    globalNotify = push;
    for (const p of pendingToasts.splice(0)) push(p.tone, p.message);
    return () => {
      globalNotify = (tone, message) => {
        pendingToasts.push({ tone, message });
      };
    };
  }, [push]);

  return (
    <ToastContext.Provider value={push}>
      {children}
      {/* Bottom-right stack; on phones it sits above the bottom nav. */}
      <div
        className="pointer-events-none fixed inset-x-3 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-[100] flex flex-col items-end gap-2 sm:inset-x-auto sm:right-5 lg:bottom-5"
        aria-live="polite"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.tone === "error" ? "alert" : "status"}
            className="pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-lg bg-base-100 py-2 pr-1.5 pl-3 text-sm text-base-content shadow-pop"
          >
            {TOAST_ICONS[t.tone]}
            <span className="min-w-0 flex-1 py-px break-words">{t.message}</span>
            <button
              type="button"
              aria-label="Dismiss notification"
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-base-content/50 hover:bg-hover hover:text-base-content max-sm:-my-2 max-sm:h-11 max-sm:w-11"
              onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/* ConfirmHost joins ToastProvider at the app root so confirmAction() works
   from any handler without prop threading. */
export function ConfirmHostRoot(): ReactElement {
  return <ConfirmHost />;
}

/* ------------------------------------------------------------------ */
/* Theme                                                               */
/* ------------------------------------------------------------------ */

export type OliveTheme = "olive-dark" | "olive-light";
export type ThemePreference = "system" | "light" | "dark";

const THEME_PREF_KEY = "olive-theme-pref";
const LEGACY_THEME_KEY = "olive-theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

export function getThemePreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  try {
    const stored = window.localStorage.getItem(THEME_PREF_KEY);
    if (stored === "system" || stored === "light" || stored === "dark") return stored;
    const legacy = window.localStorage.getItem(LEGACY_THEME_KEY);
    if (legacy === "olive-light") return "light";
    if (legacy === "olive-dark") return "dark";
  } catch {
    // storage blocked: fall back to the OS preference
  }
  return "system";
}

export function resolveTheme(pref: ThemePreference): OliveTheme {
  if (pref === "light") return "olive-light";
  if (pref === "dark") return "olive-dark";
  return window.matchMedia(DARK_QUERY).matches ? "olive-dark" : "olive-light";
}

function applyResolvedTheme(theme: OliveTheme): void {
  document.documentElement.setAttribute("data-theme", theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute("content", theme === "olive-dark" ? "#191919" : "#ffffff");
}

const themeListeners = new Set<(pref: ThemePreference) => void>();

export function setThemePreference(pref: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_PREF_KEY, pref);
    window.localStorage.removeItem(LEGACY_THEME_KEY);
  } catch {
    // ignore
  }
  applyResolvedTheme(resolveTheme(pref));
  for (const listener of themeListeners) listener(pref);
}

/* Current preference plus the theme it resolves to; follows OS changes
   while the preference is "system". */
export function useTheme(): { preference: ThemePreference; theme: OliveTheme; setPreference: (pref: ThemePreference) => void } {
  const [preference, setPref] = useState<ThemePreference>(getThemePreference);
  const [theme, setTheme] = useState<OliveTheme>(() => resolveTheme(getThemePreference()));

  useEffect(() => {
    themeListeners.add(setPref);
    return () => {
      themeListeners.delete(setPref);
    };
  }, []);

  useEffect(() => {
    const resolved = resolveTheme(preference);
    setTheme(resolved);
    applyResolvedTheme(resolved);
    if (preference !== "system") return;
    const media = window.matchMedia(DARK_QUERY);
    const onChange = () => {
      const next = resolveTheme("system");
      setTheme(next);
      applyResolvedTheme(next);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [preference]);

  return { preference, theme, setPreference: setThemePreference };
}

export function ThemeToggle({ className = "" }: { className?: string }): ReactElement {
  const { theme, setPreference } = useTheme();
  const isDark = theme === "olive-dark";
  return (
    <button
      type="button"
      onClick={() => setPreference(isDark ? "light" : "dark")}
      title={isDark ? "Switch to light theme" : "Switch to dark theme"}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      className={`btn btn-ghost btn-sm btn-square hover:bg-hover ${className}`}
    >
      {isDark ? <Sun className="h-4 w-4" aria-hidden="true" /> : <Moon className="h-4 w-4" aria-hidden="true" />}
    </button>
  );
}
