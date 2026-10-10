import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { agentInputReasonSchema, type TranscriptItem } from "@stubwise/shared";
import { Markdown } from "../markdown";
import { catalogKey } from "./i18n-key";
import { ToolCard } from "./tool-card";

type QuestionItem = Extract<TranscriptItem, { kind: "question" }>;

/** Quanti caratteri del messaggio entrano nel nome accessibile di «Rimanda». */
const RESEND_EXCERPT = 40;

/**
 * L'inizio di un messaggio, per dire a un lettore di schermo QUALE «Rimanda»
 * è (gemello di `resendExcerpt` dell'app): spazi compattati, tagliato a
 * {@link RESEND_EXCERPT} caratteri con «…».
 */
function resendExcerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > RESEND_EXCERPT ? `${flat.slice(0, RESEND_EXCERPT).trimEnd()}…` : flat;
}

/**
 * Il motivo di un «non consegnato» come chiave del catalogo: il web NON parsa
 * le risposte (cast, `lib/api.ts`), quindi un motivo che questo bundle non
 * conosce arriva così com'è — e senza questo controllo finirebbe a schermo come
 * chiave grezza. L'elenco è quello dello schema condiviso, mai una copia.
 */
function reasonKey(reason: string | null): string {
  return reason !== null && (agentInputReasonSchema.options as readonly string[]).includes(reason)
    ? reason
    : "unknown";
}

/**
 * La trascrizione di una sessione: disegna gli elementi di `buildTranscript`
 * e basta (le regole stanno lì). `renderQuestion` è il punto in cui il Task 7
 * mette il pannello per rispondere; senza, la domanda si legge e basta.
 * `onResend` (Task A2, parità con l'app): su un intervento non consegnato,
 * «Rimanda» rimette il testo nel campo — c'è solo se c'è un campo.
 */
export function Transcript({
  items,
  live = false,
  renderQuestion,
  onResend,
  resendDisabled = false,
}: {
  items: TranscriptItem[];
  /** La sessione è viva: un tool senza risultato è «in corso», altrimenti non lo sarà mai. */
  live?: boolean;
  renderQuestion?: (item: QuestionItem) => ReactNode;
  /** Rimette il testo di un intervento non consegnato nel campo, senza inviarlo. */
  onResend?: (text: string) => void;
  /** Un invio è in corso: il campo sta per svuotarsi, «Rimanda» aspetta. */
  resendDisabled?: boolean;
}) {
  return (
    <ol className="flex flex-col gap-3">
      {items.map((item) => (
        <li key={item.id}>
          {item.kind === "question" && renderQuestion ? (
            renderQuestion(item)
          ) : (
            <TranscriptRow item={item} live={live} onResend={onResend} resendDisabled={resendDisabled} />
          )}
        </li>
      ))}
    </ol>
  );
}

function TranscriptRow({
  item,
  live,
  onResend,
  resendDisabled,
}: {
  item: TranscriptItem;
  live: boolean;
  onResend?: (text: string) => void;
  resendDisabled: boolean;
}) {
  const { t } = useTranslation("agents");
  switch (item.kind) {
    case "segment":
      return (
        <div className="mt-2 flex items-center gap-3" role="separator" aria-label={t(`segment.${item.label}`)}>
          <span className="h-px flex-1 bg-line" />
          <span className="font-mono text-[11px] tracking-[0.14em] text-fg-faint uppercase">
            {t(`segment.${item.label}`)}
          </span>
          <span className="h-px flex-1 bg-line" />
        </div>
      );
    case "segment_end":
      // Solo un passo andato male merita una riga: la fine normale la dice il divisore dopo.
      if (item.timedOut) return <SystemLine text={t("segmentEnd.timedOut")} tone="danger" />;
      if (item.exitCode !== null && item.exitCode !== 0) {
        return <SystemLine text={t("segmentEnd.failed")} tone="danger" />;
      }
      return null;
    case "text":
      return (
        <div data-live={item.live ? "true" : undefined} className="max-w-3xl text-sm text-fg">
          <Markdown source={item.text} />
          {item.live && (
            <span aria-hidden className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-fg-muted align-middle" />
          )}
        </div>
      );
    case "tool":
      return <ToolCard item={item} live={live} />;
    case "input": {
      const status = catalogKey(item.status);
      const undelivered = item.status === "undelivered";
      return (
        <div className="flex justify-end">
          <div
            className={`max-w-xl rounded-sm border bg-ink-850 px-3 py-2 ${undelivered ? "border-danger/40" : "border-line"}`}
          >
            <p className="flex flex-wrap items-baseline gap-x-2 font-mono text-[11px] text-fg-faint">
              <span>{item.authorName ?? "—"}</span>
              {item.interrupt && <span>{t("inputInterrupt")}</span>}
              <span className={undelivered ? "text-danger" : undefined}>{t(`input.${status}`)}</span>
            </p>
            <p className="mt-1 text-sm whitespace-pre-wrap text-fg">{item.text}</p>
            {undelivered && (
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <p className="text-[13px] text-danger">{t(`input.reason.${reasonKey(item.reason)}`)}</p>
                {onResend !== undefined && (
                  <button
                    type="button"
                    onClick={() => onResend(item.text)}
                    disabled={resendDisabled}
                    aria-label={t("input.resendLabel", { text: resendExcerpt(item.text) })}
                    className="rounded-sm disabled:cursor-not-allowed disabled:opacity-50 border border-line-strong px-2 py-0.5 font-mono text-[11px] tracking-[0.12em] text-fg uppercase hover:bg-ink-800"
                  >
                    {t("input.resend")}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      );
    }
    case "interrupted":
      return <SystemLine text={t("interrupted")} />;
    case "question":
      return (
        <div className="rounded-sm border border-line bg-ink-900 px-3 py-2">
          <p className="font-mono text-[11px] tracking-[0.14em] text-fg-faint uppercase">
            {t("question.title")}
            {item.question.answered ? ` · ${t("question.answered")}` : ""}
          </p>
          <div className="mt-1 text-fg">
            <Markdown question source={item.question.question} />
          </div>
        </div>
      );
  }
}

function SystemLine({ text, tone }: { text: string; tone?: "danger" }) {
  return (
    <p className={`font-mono text-[12px] ${tone === "danger" ? "text-danger" : "text-fg-faint"}`}>
      {text}
    </p>
  );
}
