import { useMemo, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

export interface ToastAction {
  label: string;
  run(): void;
}

interface ToastItem {
  id: number;
  kind: "info" | "error";
  message: string;
  action?: ToastAction;
}

// Quanto resta un messaggio: un errore più a lungo, perché va letto (e c'è
// sempre «Dismiss» per chiuderlo prima).
const DURATION_MS = { info: 5000, error: 8000 } as const;
/** Oltre questi, il più vecchio lascia il posto. */
const MAX_VISIBLE = 3;

// Archivio di modulo, non un contesto: `useToast()` funziona ovunque sotto
// l'`AppLayout` (anche nei dialog in portal) e la sola `ToastRegion` disegna.
let items: ToastItem[] = [];
let nextId = 1;
const timers = new Map<number, number>();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function dismiss(id: number) {
  window.clearTimeout(timers.get(id));
  timers.delete(id);
  items = items.filter((i) => i.id !== id);
  emit();
}

function push(kind: ToastItem["kind"], message: string, action?: ToastAction): number {
  const id = nextId++;
  items = [...items, { id, kind, message, action }].slice(-MAX_VISIBLE);
  timers.set(
    id,
    window.setTimeout(() => dismiss(id), DURATION_MS[kind]),
  );
  emit();
  return id;
}

/** Svuota i messaggi (test, cambio di persona). */
export function clearToasts() {
  for (const t of timers.values()) window.clearTimeout(t);
  timers.clear();
  items = [];
  emit();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/**
 * Messaggi brevi in fondo all'area di lavoro. Le azioni ottimistiche che
 * tornano indietro usano `error` con una frase che lo dice («Couldn't move
 * MKX-33. It's back where it was.»); `show` per le conferme, con un'azione
 * facoltativa («Undo»).
 */
export function useToast() {
  return useMemo(
    () => ({
      show: (message: string, opts: { action?: ToastAction } = {}) =>
        push("info", message, opts.action),
      error: (message: string, opts: { action?: ToastAction } = {}) =>
        push("error", message, opts.action),
      dismiss,
    }),
    [],
  );
}

function ErrorSign() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
      className="mt-0.5 shrink-0 text-critical"
    >
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.75v3.75M8 11h.01" />
    </svg>
  );
}

function CloseSign() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />
    </svg>
  );
}

/**
 * La regione dei messaggi, montata una volta nell'`AppLayout`: centrata
 * sull'area di lavoro (a destra di binario e colonna, 304 px), sopra tutto.
 * Superficie che galleggia per un momento: filetto forte e ombra morbida.
 * Un errore si annuncia subito (`alert`), una conferma con calma (`status`).
 */
export function ToastRegion() {
  const { t } = useTranslation();
  const list = useSyncExternalStore(subscribe, () => items);
  return (
    <section
      aria-label={t("taskUi.toast.region")}
      className="pointer-events-none fixed bottom-5 left-[calc(304px+(100vw-304px)/2)] z-50 flex w-[min(480px,calc(100vw-336px))] -translate-x-1/2 flex-col items-stretch gap-2"
    >
      {list.map((item) => (
        <div
          key={item.id}
          role={item.kind === "error" ? "alert" : "status"}
          data-toast={item.kind}
          className="toast-enter pointer-events-auto flex items-start gap-3 rounded-lg border border-rule-strong bg-surface py-2.5 pr-2 pl-3.5 text-sm text-ink shadow-[0_12px_32px_-8px_oklch(0_0_0/0.4)]"
        >
          {item.kind === "error" && <ErrorSign />}
          <p className="min-w-0 flex-1 py-0.5">{item.message}</p>
          {item.action && (
            <button
              type="button"
              onClick={() => {
                item.action!.run();
                dismiss(item.id);
              }}
              className="h-7 shrink-0 rounded-md px-2 text-sm font-semibold text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6"
            >
              {item.action.label}
            </button>
          )}
          <button
            type="button"
            aria-label={t("taskUi.toast.dismiss")}
            title={t("taskUi.toast.dismiss")}
            onClick={() => dismiss(item.id)}
            className="grid size-7 shrink-0 place-items-center rounded-md text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
          >
            <CloseSign />
          </button>
        </div>
      ))}
    </section>
  );
}
