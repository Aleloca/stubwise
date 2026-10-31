import { useBlocker, useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { PageSkeleton } from "../../tasks-ui/PageStates";
import { useToast } from "../../tasks-ui/Toast";
import { ErrorLine } from "../entry/parts";
import { refusalOf } from "../preferences/parts";
import { InlineConfirm, smallSecondary } from "../task/parts";
import type { BlockState } from "../home/blocks/BlockSection";

// Il guscio di una sezione di Progetto → Settings (area 9a, [RM 4]): ogni
// sezione è una pagina, con il suo h1 da 28 px, una riga in prosa e, a
// destra, l'azione della pagina (Members: «Add member»). Fino a 880 px
// (Usage fino a 1040). Aprendo una sezione (dalla colonna o da un link) il
// fuoco va all'h1 (shape project-settings.md §6), a meno che la sezione
// non l'abbia già portato su qualcosa di suo (un pannello aperto
// dall'indirizzo, o un dialogo come la creazione guidata dei repository).
// `back` sta sopra l'h1: il ritorno da una pagina dentro la sezione
// («← Repositories»).

export function SettingsFrame({
  title,
  intro,
  action,
  back,
  width = 880,
  children,
}: {
  title: string;
  intro?: ReactNode;
  action?: ReactNode;
  back?: ReactNode;
  width?: 880 | 1040;
  children: ReactNode;
}) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    const active = document.activeElement;
    if (active && active !== document.body && section.current?.contains(active)) return;
    if (active?.closest('[role="dialog"]')) return;
    heading.current?.focus({ preventScroll: true });
  }, []);
  return (
    <section ref={section} aria-labelledby={id} className="flex min-h-full flex-col pb-16 pl-8">
      <div
        className={`flex w-full flex-1 flex-col pr-8 ${width === 1040 ? "max-w-[1040px]" : "max-w-[880px]"}`}
      >
        <header className="page-header flex shrink-0 flex-col gap-1.5 pb-5 [--page-header-pt:32px]">
          {back}
          <div className="flex min-h-8 items-center gap-3">
            <h1
              id={id}
              ref={heading}
              tabIndex={-1}
              className="min-w-0 flex-1 text-2xl font-semibold tracking-[-0.01em] text-ink outline-none"
            >
              {title}
            </h1>
            {action}
          </div>
          {intro && <p className="max-w-[72ch] text-md text-pretty text-ink-muted">{intro}</p>}
        </header>
        {children}
      </div>
    </section>
  );
}

/** Caricamento ed errore di una sezione, sotto la testata; pronta, il contenuto. */
export function SettingsState({
  state,
  error,
  rows = 6,
  children,
}: {
  state: BlockState;
  /** La frase dell'errore («Couldn't load the statuses.»). */
  error: string;
  /** Le righe dello scheletro: quante ne ha la sezione vera. */
  rows?: number;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  if (state.status === "loading")
    return (
      <div className="border-t border-rule">
        <PageSkeleton rows={rows} />
      </div>
    );
  if (state.status === "error")
    return (
      <div role="alert" className="flex items-center gap-3 border-t border-rule py-3">
        <p className="text-md text-ink">{error}</p>
        <button type="button" className={smallSecondary} onClick={state.retry}>
          {t("taskUi.states.retry")}
        </button>
      </div>
    );
  return <>{children}</>;
}

/**
 * Lasciare una sezione con una bozza chiede prima (shape §3): `blocked` dice
 * se la conferma è aperta, `proceed`/`reset` la chiudono. `clear()` dopo un
 * salvataggio riuscito, prima che la lettura nuova arrivi.
 */
export function useLeaveGuard(dirty: boolean) {
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const blocker = useBlocker({
    shouldBlockFn: () => dirtyRef.current,
    enableBeforeUnload: false,
    withResolver: true,
  });
  return {
    blocked: blocker.status === "blocked",
    proceed: () => blocker.proceed?.(),
    reset: () => blocker.reset?.(),
    clear: () => {
      dirtyRef.current = false;
    },
  };
}

/** La conferma «Discard your changes?» sul posto, quando si lascia la sezione con una bozza. */
export function LeaveConfirm({
  guard,
  message,
}: {
  guard: ReturnType<typeof useLeaveGuard>;
  message?: string;
}) {
  const { t } = useTranslation();
  if (!guard.blocked) return null;
  return (
    <InlineConfirm
      message={message ?? t("settings.common.leave")}
      confirm={t("settings.common.discard")}
      cancelLabel={t("settings.common.keepEditing")}
      onConfirm={guard.proceed}
      onCancel={guard.reset}
    />
  );
}

/**
 * Una barra che se ne va da sola (2 s dopo «Saved»): se il fuoco era dentro
 * (su Save), passa all'h1 della pagina invece di cadere sul body.
 */
export function FocusRescue({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    return () => {
      if (el && el.contains(document.activeElement))
        el.closest("section")?.querySelector<HTMLElement>("h1")?.focus();
    };
  }, []);
  return (
    <div ref={ref} className="contents">
      {children}
    </div>
  );
}

/**
 * L'esito di una scrittura di General, AI o Automations (shape §5,
 * «Rifiuti»), detto dove è partita:
 * - `forbidden`: la frase resta, la sezione ricarica in sola lettura e la
 *   bozza si perde (la frase lo dice);
 * - `not_found`: la frase come avviso, e ritorno ad All projects [PS 11];
 * - `invalid`: la ragione al chiamante, che la dice sotto il suo campo (con
 *   la riga, se il rifiuto la porta: i rami protetti di un repository);
 * - `conflict`, se chi chiama passa `onConflict` (Plugins): a lui, senza
 *   frase né Retry; altrimenti è un errore come gli altri;
 * - `reauth_cancelled` (la riconferma chiusa, area 9c): nessuna frase in
 *   più («Nothing was changed.» lo dice il dialogo della riconferma), e chi
 *   chiama resta com'è (il dialogo aperto);
 * - un errore del livello dati: «Couldn't save. Try again.» con Retry, bozza
 *   conservata.
 * Restituisce `true` se la scrittura è riuscita. Il seguito di una scrittura
 * riuscita (mostrare un segreto, chiudere un dialogo, il toast) va in
 * `onDone`, che riceve il risultato: così vale anche dopo un Retry, che
 * altrimenti riuscirebbe senza che nessuno lo sappia.
 */
export function useSettingsWrite(
  code: string,
  onReload: () => void,
  options: {
    /** La frase di `forbidden`, quando la sezione ne ha una sua (Delete: «Only a full admin…»). */
    forbidden?: string;
    /** Chi gestisce da sé `not_found` (Archived, Amministrazione): niente frase né ritorno ad All projects. */
    onNotFound?: () => void;
  } = {},
) {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const [failure, setFailure] = useState<
    { kind: "forbidden" } | { kind: "failed"; retry: () => void } | null
  >(null);
  // Una scrittura alla volta: un doppio clic su Retry non ne lancia due.
  const inflight = useRef(false);

  async function run<R>(
    write: () => Promise<R>,
    onInvalid: (reason: string, line?: number) => void,
    onDone?: (result: R) => void,
    onConflict?: () => void,
  ): Promise<boolean> {
    return attempt(write, onInvalid, onDone, onConflict, false);
  }

  async function attempt<R>(
    write: () => Promise<R>,
    onInvalid: (reason: string, line?: number) => void,
    onDone: ((result: R) => void) | undefined,
    onConflict: (() => void) | undefined,
    retrying: boolean,
  ): Promise<boolean> {
    // Il Retry rifà la stessa scrittura con lo stesso seguito: il risultato
    // di un Retry riuscito arriva a `onDone` come quello del primo tentativo.
    // Durante il Retry la riga resta (e il fuoco sul suo bottone, che la
    // riconferma riprende alla chiusura): se ne va con l'esito.
    if (inflight.current) return false;
    if (!retrying) setFailure(null);
    const retry = () => void attempt(write, onInvalid, onDone, onConflict, true);
    inflight.current = true;
    const result = await write()
      .catch(() => undefined)
      .finally(() => {
        inflight.current = false;
      });
    if (result === undefined) {
      setFailure({ kind: "failed", retry });
      return false;
    }
    if (retrying) setFailure(null);
    const refusal = refusalOf(result);
    if (!refusal) {
      onDone?.(result);
      return true;
    }
    if (refusal.error === "invalid")
      onInvalid(refusal.reason ?? "", (refusal as { line?: number }).line);
    else if (refusal.error === "forbidden") {
      setFailure({ kind: "forbidden" });
      onReload();
    } else if (refusal.error === "reauth_cancelled") {
      // La riconferma chiusa: «Nothing was changed.» lo dice già il suo
      // dialogo; qui niente, e la bozza resta dov'è.
    } else if (refusal.error === "conflict" && onConflict) {
      // Qualcuno ha salvato dopo la lettura (Plugins, RF 5): non è un errore
      // da riprovare, è una scelta di chi ha scritto la bozza ([PG 5]).
      onConflict();
    } else if (refusal.error === "not_found") {
      if (options.onNotFound) options.onNotFound();
      else {
        toast.error(t("settings.common.notFound", { code }));
        void navigate({ to: "/projects" as never });
      }
    } else setFailure({ kind: "failed", retry });
    return false;
  }

  const message =
    failure?.kind === "forbidden" ? (
      <ErrorLine>{options.forbidden ?? t("settings.common.forbidden")}</ErrorLine>
    ) : failure?.kind === "failed" ? (
      <ErrorLine
        action={
          <button type="button" className={smallSecondary} onClick={failure.retry}>
            {t("settings.common.retry")}
          </button>
        }
      >
        {t("settings.common.saveFailed")}
      </ErrorLine>
    ) : null;

  return { run, message, lost: failure?.kind === "forbidden" };
}

/** «Saved» accanto al bottone per 2 s, annunciato con garbo. */
export function SavedNote({ on }: { on: boolean }) {
  const { t } = useTranslation();
  return (
    <span aria-live="polite" className="text-xs text-ink-muted">
      {on ? t("settings.common.saved") : ""}
    </span>
  );
}
