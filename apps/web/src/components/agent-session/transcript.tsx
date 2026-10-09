import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TranscriptItem } from "../../lib/agent-transcript";
import { Markdown } from "../markdown";
import { catalogKey } from "./i18n-key";
import { ToolCard } from "./tool-card";

type QuestionItem = Extract<TranscriptItem, { kind: "question" }>;

/**
 * La trascrizione di una sessione: disegna gli elementi di `buildTranscript`
 * e basta (le regole stanno lì). `renderQuestion` è il punto in cui il Task 7
 * mette il pannello per rispondere; senza, la domanda si legge e basta.
 */
export function Transcript({
  items,
  renderQuestion,
}: {
  items: TranscriptItem[];
  renderQuestion?: (item: QuestionItem) => ReactNode;
}) {
  return (
    <ol className="flex flex-col gap-3">
      {items.map((item) => (
        <li key={item.id}>
          {item.kind === "question" && renderQuestion ? (
            renderQuestion(item)
          ) : (
            <TranscriptRow item={item} />
          )}
        </li>
      ))}
    </ol>
  );
}

function TranscriptRow({ item }: { item: TranscriptItem }) {
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
      return <ToolCard item={item} />;
    case "input": {
      const status = catalogKey(item.status);
      const reason = item.reason !== null ? catalogKey(item.reason) : null;
      return (
        <div className="flex justify-end">
          <div className="max-w-xl rounded-sm border border-line bg-ink-850 px-3 py-2">
            <p className="flex flex-wrap items-baseline gap-x-2 font-mono text-[11px] text-fg-faint">
              <span>{item.authorName ?? "—"}</span>
              {item.interrupt && <span>{t("inputInterrupt")}</span>}
              <span className={item.status === "undelivered" ? "text-danger" : undefined}>
                {t(`input.${status}`)}
                {reason !== null && item.status === "undelivered"
                  ? ` — ${t(`input.reason.${reason}`)}`
                  : ""}
              </span>
            </p>
            <p className="mt-1 text-sm whitespace-pre-wrap text-fg">{item.text}</p>
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
          <p className="mt-1 text-sm whitespace-pre-wrap text-fg">{item.question.question}</p>
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
