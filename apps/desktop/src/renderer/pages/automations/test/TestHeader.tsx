import { Link } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { primaryButton, quietButton, secondaryButton } from "../../tasks/controls";
import { useTest } from "./context";

// La testata della prova (shape automation-test §3): «← Back to editing»,
// h1 «Test: <nome>» col codice, la riga meta (versione · esempio · «Change
// example»), i comandi della prova e — solo a prova finita bene — «Turn
// on» / «Publish version N». Sotto, a tutta larghezza e fissa, la fascia
// d'inchiostro «TEST · Nothing here is real» ([A 3]): non è un avviso, è lo
// stato della pagina.

export interface TestHeaderProps {
  /** La riga della versione provata («Version 3 (draft)»). */
  versionLine: string;
  /** La riga dell'esempio, o null se non ancora scelto. */
  exampleLine: string | null;
  /** Il passo a cui torna «Back to editing» (id), se c'è. */
  backStep: string | null;
  onChangeExample: (() => void) | null;
  /** I comandi della prova; null finché non è partita. */
  commands: {
    canStep: boolean;
    onNext: () => void;
    onRun: () => void;
    onRestart: () => void;
  } | null;
  /** A prova finita bene: «Turn on» / «Publish version N» (solo una bozza). */
  finish: { label: string; onClick: () => void } | null;
  onTestAgain: (() => void) | null;
}

export function TestHeader(p: TestHeaderProps) {
  const { t } = useTranslation();
  const ctx = useTest();
  const a = ctx.automation;
  return (
    <header className="sticky top-0 z-20 flex flex-col bg-ground">
      <div className="flex flex-col gap-2 pt-6 pr-8 pb-4 pl-8">
        <Link
          to="/automations/$code/edit"
          params={{ code: a.code }}
          search={(p.backStep ? { step: p.backStep } : {}) as never}
          data-back-to-editing
          className="w-fit text-sm text-ink-muted hover:text-ink"
        >
          ← {t("automations.test.back")}
        </Link>
        <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
          <h1 className="min-w-0 flex-1 basis-80 text-2xl font-semibold break-words text-ink">
            {t("automations.test.title", { name: a.name })}{" "}
            <span className="num align-middle text-sm font-semibold text-ink-faint">{a.code}</span>
          </h1>
          <div
            role="group"
            aria-label={t("automations.test.commands.label")}
            className="ml-auto flex flex-wrap items-center gap-2"
          >
            {p.commands && (
              <>
                <button
                  type="button"
                  data-restart
                  className={quietButton}
                  onClick={p.commands.onRestart}
                >
                  {t("automations.test.commands.restart")}
                </button>
                <button
                  type="button"
                  data-next-step
                  className={`${primaryButton} disabled:opacity-40`}
                  disabled={!p.commands.canStep}
                  aria-keyshortcuts="N Enter"
                  title={t("automations.test.commands.keys")}
                  onClick={p.commands.onNext}
                >
                  {t("automations.test.commands.next")}
                </button>
                <button
                  type="button"
                  data-run-to-stop
                  className={`${secondaryButton} disabled:opacity-40`}
                  disabled={!p.commands.canStep}
                  aria-keyshortcuts="Shift+Enter"
                  onClick={p.commands.onRun}
                >
                  {t("automations.test.commands.run")}
                </button>
              </>
            )}
            {p.onTestAgain && (
              <button
                type="button"
                data-test-again
                className={secondaryButton}
                onClick={p.onTestAgain}
              >
                {t("automations.test.commands.again")}
              </button>
            )}
            {p.finish && (
              <button
                type="button"
                data-finish-action
                className={primaryButton}
                onClick={p.finish.onClick}
              >
                {p.finish.label}
              </button>
            )}
          </div>
        </div>
        <p className="flex flex-wrap items-center gap-x-2 text-sm text-ink-muted">
          <span data-version-line>{p.versionLine}</span>
          {p.exampleLine !== null && (
            <>
              <span aria-hidden="true">·</span>
              <span data-example-line>{p.exampleLine}</span>
            </>
          )}
          {p.onChangeExample && (
            <>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                data-change-example
                onClick={p.onChangeExample}
                className="text-ink underline-offset-4 hover:underline"
              >
                {t("automations.test.meta.change")}
              </button>
            </>
          )}
        </p>
      </div>
      <TestBand />
    </header>
  );
}

/** La fascia della prova: glifo, «TEST», la frase, e «What a test can't do». */
function TestBand() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const popId = useId();
  // Un clic fuori chiude il riquadro.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!buttonRef.current?.contains(target) && !popRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);
  return (
    <div
      role="note"
      data-test-band
      aria-label={t("automations.test.band.label")}
      className="relative flex flex-wrap items-center gap-x-3 gap-y-1 border-y border-rule-strong bg-ink/6 py-2 pr-8 pl-8"
    >
      <TubeGlyph />
      <span className="heading-group text-ink">{t("automations.test.band.label")}</span>
      <span className="min-w-0 flex-1 text-sm text-ink">{t("automations.test.band.text")}</span>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={popId}
        onClick={() => setOpen((v) => !v)}
        className="text-sm text-ink underline-offset-4 hover:underline"
      >
        {t("automations.test.band.cant")}
      </button>
      {open && (
        <div
          ref={popRef}
          id={popId}
          role="dialog"
          aria-label={t("automations.test.band.cant")}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
              buttonRef.current?.focus();
            }
          }}
          className="menu-enter absolute top-full right-8 z-30 mt-1 w-[340px] max-w-[calc(100vw-32px)] rounded-lg border border-rule-strong bg-surface p-3 shadow-[0_12px_32px_-8px_oklch(0_0_0/0.4)]"
        >
          <ul className="flex list-disc flex-col gap-1.5 pl-4 text-sm text-ink">
            <li>{t("automations.test.band.cantDrive")}</li>
            <li>{t("automations.test.band.cantClaude")}</li>
            <li>{t("automations.test.band.cantOthers")}</li>
          </ul>
        </div>
      )}
    </div>
  );
}

/** La provetta della fascia: lineare, d'inchiostro. */
function TubeGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0 text-ink"
    >
      <path d="M6 2h4M6.75 2v4.25L3.2 12.4A1.1 1.1 0 0 0 4.15 14h7.7a1.1 1.1 0 0 0 .95-1.6L9.25 6.25V2M5 10h6" />
    </svg>
  );
}
