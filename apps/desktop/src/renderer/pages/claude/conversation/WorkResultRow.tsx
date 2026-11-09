import { createContext, useContext, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { Ev } from "./flow";
import { serverCheckText } from "./serverCheck";
import { Glyph } from "./parts";

const MARKS: Record<Ev<"work_result">["kind"], ReactElement> = {
  pr_opened: (
    <Glyph>
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="12.5" r="1.5" />
      <path d="M4.5 5v6M11.5 11V6.5a2 2 0 0 0-2-2H7.5m0 0 1.5-1.5M7.5 4.5 9 6" />
    </Glyph>
  ),
  review: (
    <Glyph>
      <path d="M1.8 8s2.3-4.2 6.2-4.2S14.2 8 14.2 8 11.9 12.2 8 12.2 1.8 8 1.8 8z" />
      <circle cx="8" cy="8" r="1.8" />
    </Glyph>
  ),
  correction: (
    <Glyph>
      <path d="M3 8a5 5 0 0 1 8.6-3.5L13 6M13 2.5V6H9.5M13 8a5 5 0 0 1-8.6 3.5L3 10m0 3.5V10h3.5" />
    </Glyph>
  ),
  design_updated: (
    <Glyph>
      <path d="M4 1.8h5l3 3v9.4H4z" />
      <path d="M6.5 9.5h3M6.5 12h3M6.5 7h1.5" />
    </Glyph>
  ),
  plan_updated: (
    <Glyph>
      <path d="M5.5 4h7M5.5 8h7M5.5 12h7M3 4h.01M3 8h.01M3 12h.01" />
    </Glyph>
  ),
  estimate_updated: (
    <Glyph>
      <path d="M2 13.5h12M4 13.5V9M8 13.5V5.5M12 13.5V2.5" />
    </Glyph>
  ),
  // Area 8b: la diagnosi di un server (la lente) e il controllo finale della correzione.
  server_diagnosis: (
    <Glyph>
      <circle cx="7" cy="7" r="4.25" />
      <path d="m10.25 10.25 3.5 3.5" />
    </Glyph>
  ),
  server_check: (
    <Glyph>
      <path d="M3 3h10v10H3z" />
      <path d="m5.5 8.25 1.75 1.75L10.75 6.5" />
    </Glyph>
  ),
};

/**
 * «See» su una riga del refine: chi monta la conversazione accanto alla
 * richiesta (la vista di refine) porta il lato sulla sezione che la riga ha
 * scritto. Senza, le righe restano solo testo (o il loro link).
 */
export const WorkResultSeeContext = createContext<((event: Ev<"work_result">) => void) | null>(
  null,
);

/** Un link di un risultato si apre solo se è interno (`#/…`) o `https:`. */
export function safeLink(link: string | undefined): string | null {
  if (!link) return null;
  return link.startsWith("#/") || /^https:\/\//i.test(link) ? link : null;
}

/**
 * Un prodotto del lavoro di Claude, già avvenuto (non una proposta): «PR
 * #142 opened», «Review: changes requested», «Correction 2 sent», «Updated
 * the design of STW-R4 · See». 14 px d'inchiostro con il suo segno.
 */
export function WorkResultRow({ event }: { event: Ev<"work_result"> }) {
  const { t } = useTranslation();
  const see = useContext(WorkResultSeeContext);
  const seeHere = see !== null && event.requestPatch !== undefined && !safeLink(event.link);
  return (
    <p
      data-work-result={event.kind}
      className="event-enter flex min-w-0 items-center gap-2 py-0.5 text-md text-ink"
    >
      <span className="text-ink-muted">{MARKS[event.kind]}</span>
      <span className="min-w-0 [overflow-wrap:anywhere]">{serverCheckText(event, t)}</span>
      {safeLink(event.link) && (
        <>
          <span aria-hidden="true" className="text-ink-faint">
            ·
          </span>
          <a
            href={safeLink(event.link)!}
            className="shrink-0 text-sm font-medium text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
          >
            {event.kind === "pr_opened"
              ? t("claude.conversation.result.open")
              : t("claude.conversation.result.see")}
          </a>
        </>
      )}
      {seeHere && (
        <>
          <span aria-hidden="true" className="text-ink-faint">
            ·
          </span>
          <button
            type="button"
            onClick={() => see(event)}
            className="shrink-0 rounded-sm text-sm font-medium text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
          >
            {t("claude.conversation.result.see")}
          </button>
        </>
      )}
    </p>
  );
}
