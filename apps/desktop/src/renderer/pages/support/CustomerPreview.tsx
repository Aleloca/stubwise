import { useEffect, useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useCustomerPreview } from "../../data/queries";
import type { CustomerStatus } from "../../domain/releases/customerStatus";
import { PageSkeleton } from "../../tasks-ui/PageStates";
import { CheckGlyph, CrossGlyph, quietButton, secondaryButton } from "../claude/conversation/parts";
import { whenWithTime } from "../mail/format";

// «Anteprima del cliente» (shape support.md §5, [A 3]): un pannello
// agganciato a destra (o al posto del dettaglio, nella finestra stretta)
// che mostra ESATTAMENTE ciò che vede il cliente adesso: lo stato in parole
// e i messaggi, suoi e «nostri» col nome del widget. Mai una persona del
// team, una bozza, una stima, un commento interno: li toglie già il livello
// dati (`customerPreview`), qui non c'è niente da nascondere.

const STEPS: readonly CustomerStatus[] = [
  "received",
  "evaluating",
  "planned",
  "in_progress",
  "released",
];

function StatusLadder({ status }: { status: CustomerStatus }) {
  const { t } = useTranslation();
  if (status === "not_proceeding") {
    return (
      <p className="text-md font-semibold text-ink">{t("support.customerStatus.not_proceeding")}</p>
    );
  }
  const at = STEPS.indexOf(status);
  return (
    <ol aria-label={t("support.preview.steps")} className="flex flex-col gap-1.5">
      {STEPS.map((step, i) => {
        const past = i < at;
        const current = i === at;
        return (
          <li
            key={step}
            aria-current={current ? "step" : undefined}
            className={`flex items-center gap-2 text-sm ${current ? "font-semibold text-ink" : past ? "text-ink-muted" : "text-ink-faint"}`}
          >
            <span className="grid size-4 place-items-center">
              {past ? (
                <CheckGlyph size={14} />
              ) : (
                <span
                  aria-hidden="true"
                  className={`size-2 rounded-full ${current ? "bg-ink" : "border border-rule-strong"}`}
                />
              )}
            </span>
            {t(`support.customerStatus.${step}`)}
            {current && <span className="sr-only">({t("support.preview.current")})</span>}
          </li>
        );
      })}
    </ol>
  );
}

export function CustomerPreview({
  code,
  name,
  usName,
  onClose,
  docked,
}: {
  code: string;
  /** Il nome breve del cliente («What Lucia sees»). */
  name: string;
  /** Chi siamo per il cliente: il nome del widget (o del progetto), mai una persona. */
  usName: string;
  onClose: () => void;
  docked: boolean;
}) {
  const { t, i18n } = useTranslation();
  const preview = useCustomerPreview(code);
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => closeRef.current?.focus(), []);

  return (
    <aside
      role="complementary"
      aria-labelledby={titleId}
      data-customer-preview
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
      className={`flex min-h-0 flex-col bg-surface ${docked ? "panel-enter w-[360px] shrink-0 border-l border-rule" : "min-w-0 flex-1"}`}
    >
      <header className="flex items-start gap-2 border-b border-rule px-4 pt-4 pb-3">
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-lg font-semibold text-ink">
            {t("support.preview.title", { name })}
          </h2>
          <p className="text-xs text-ink-muted">{t("support.preview.live")}</p>
        </div>
        <button
          ref={closeRef}
          type="button"
          aria-label={t("support.preview.close")}
          title={t("support.preview.close")}
          onClick={onClose}
          className={quietButton}
        >
          {docked ? <CrossGlyph /> : t("support.preview.back")}
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-4">
        {preview.isError ? (
          <div role="alert" className="flex flex-col items-start gap-2">
            <p className="text-md text-ink">{t("support.preview.error")}</p>
            <button
              type="button"
              className={secondaryButton}
              onClick={() => void preview.refetch()}
            >
              {t("taskUi.states.retry")}
            </button>
          </div>
        ) : !preview.data ? (
          <PageSkeleton rows={4} />
        ) : (
          <>
            <StatusLadder status={preview.data.status} />
            <ol aria-label={t("support.preview.messages")} className="flex flex-col gap-3">
              {preview.data.messages.map((m, i) => (
                <li
                  key={i}
                  className={`flex max-w-[88%] flex-col gap-0.5 ${m.from === "customer" ? "self-end items-end" : "items-start"}`}
                >
                  <span className="text-xs text-ink-faint">
                    {m.from === "customer" ? t("support.preview.you") : usName} ·{" "}
                    <span className="num">{whenWithTime(m.at, i18n.language)}</span>
                  </span>
                  <p
                    className={`rounded-lg px-3 py-2 text-sm whitespace-pre-wrap [overflow-wrap:anywhere] ${m.from === "customer" ? "bg-ink/10 text-ink" : "border border-rule text-ink"}`}
                  >
                    {m.body}
                  </p>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
      <p className="border-t border-rule px-4 py-3 text-xs text-ink-faint">
        {t("support.preview.never")}
      </p>
    </aside>
  );
}
