import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  suggestionKeyOf,
  useClaudeSuggestion,
  useSessionPersonId,
  type SuggestionPlace,
} from "../data/queries";
import { onStoreReset } from "../data/store";
import { openClaudePanel } from "../layout/claudePanel/panelEvents";

// La riga «Claude can help you…» (area 10b, Task 12; shape
// `claude-suggestions.md`): una nota a margine sotto la testata di cinque
// pagine di partenza, la cosa più quieta della pagina [SG 1]. Testo 13px
// senza fondo né bordo, l'anello fermo in `ink-faint`. Il clic apre il
// riquadro con una conversazione NUOVA e la richiesta nella casella, non
// inviata: Invio resta della persona. Se c'è e quale la decide il livello
// dati (`useClaudeSuggestion`); qui solo «Not now», che si ricorda per
// persona e per oggetto in `localStorage` ([SG 7]) e, senza archivio, vale
// fino al prossimo ingresso nella pagina.

const PREFIX = "stubwise.claudeSuggestion.";
/** La durata del richiudersi: `--duration-fast` (0 con movimento ridotto). */
const COLLAPSE_MS = 150;

const storageKey = (me: string, place: SuggestionPlace) =>
  `${PREFIX}${me}.${suggestionKeyOf(place)}`;

function storedHidden(key: string): boolean {
  try {
    return window.localStorage.getItem(key) !== null;
  } catch {
    // Senza archivio la riga c'è.
    return false;
  }
}

function storeHidden(key: string): void {
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // Senza archivio la riga si nasconde lo stesso, fino al cambio di pagina.
  }
}

// Nessun «mostra di nuovo» nelle Preferenze ([SG 8]): il reset del prototipo svuota.
onStoreReset(() => {
  try {
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const key = window.localStorage.key(i);
      if (key?.startsWith(PREFIX)) window.localStorage.removeItem(key);
    }
  } catch {
    // Idem.
  }
});

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Dopo «Not now» il fuoco va all'elemento successivo della pagina, o al
 * titolo se non c'è: mai sul body. Si cerca nella pagina che contiene la riga
 * (il pannello della PR, l'articolo), poi nel documento.
 */
function focusAfter(row: HTMLElement): void {
  const after = (el: Element) =>
    !row.contains(el) &&
    (row.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 &&
    !el.closest("[inert], [hidden], [aria-hidden='true']");
  const scope = row.closest("[data-detail-panel], article, section, main") ?? document.body;
  const next =
    [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].find(after) ??
    [...document.querySelectorAll<HTMLElement>(FOCUSABLE)].find(after);
  if (next) {
    next.focus();
    return;
  }
  const heading = scope.querySelector<HTMLElement>("h1, h2") ?? document.querySelector("h1");
  if (heading) {
    if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
    heading.focus();
  }
}

/** L'anello di Claude fermo, 12px, in `ink-faint`: un segno, non un colore. */
function QuietRing() {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-3 shrink-0 rounded-full border-[1.5px] border-dashed border-ink-faint"
    />
  );
}

export function ClaudeSuggestionRow({
  place,
  className = "",
}: {
  /** L'oggetto della pagina; `null` finché non è letto (nessuna riga). */
  place: SuggestionPlace | null;
  className?: string;
}) {
  const { t } = useTranslation();
  const me = useSessionPersonId();
  const suggestion = useClaudeSuggestion(place).data ?? null;
  const key = place ? storageKey(me, place) : null;
  // «Not now» di questo ingresso nella pagina: vale anche senza archivio.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const row = useRef<HTMLDivElement>(null);
  const hintId = useId();

  const closing = key !== null && dismissed === key;
  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(() => setGone(key), COLLAPSE_MS);
    return () => clearTimeout(timer);
  }, [closing, key]);

  if (!suggestion || !key) return null;
  const shown = gone !== key && (closing || !storedHidden(key));

  const params = suggestion.params ?? {};
  const task = t(suggestion.lineKey, params);
  const lead = t("claude.suggestions.lead");
  // Ogni clic apre una conversazione nuova con la richiesta, mai inviata: un
  // doppio clic riscrive la stessa casella, non fa due conversazioni.
  const open = () =>
    openClaudePanel({ draft: t(suggestion.promptKey, params), fresh: true, mode: "open" });
  const notNow = () => {
    storeHidden(key);
    if (row.current) focusAfter(row.current);
    setDismissed(key);
  };

  return (
    <>
      {shown && (
        <div
          ref={row}
          data-claude-suggestion={suggestion.id}
          inert={closing || undefined}
          aria-hidden={closing || undefined}
          className={`grid transition-[grid-template-rows,opacity] duration-[var(--duration-fast)] ease-out ${closing ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr]"} ${className}`}
        >
          <div className="flex min-h-7 min-w-0 items-start gap-3 overflow-hidden text-sm">
            <button
              type="button"
              onClick={open}
              aria-describedby={hintId}
              title={t("claude.suggestions.hint")}
              className="flex min-w-0 flex-1 items-start gap-2 rounded-sm py-[5px] text-left text-ink-muted decoration-ink/40 underline-offset-2 transition-colors duration-[var(--duration-fast)] ease-out hover:text-ink hover:underline focus-visible:text-ink focus-visible:underline"
            >
              <span className="flex h-[18px] shrink-0 items-center">
                <QuietRing />
              </span>
              <span className="min-w-0 text-pretty">
                {lead}
                <span className="text-ink">{task}</span>
              </span>
            </button>
            <button
              type="button"
              onClick={notNow}
              className="shrink-0 rounded-sm py-[5px] text-xs leading-[18px] text-ink-faint transition-colors duration-[var(--duration-fast)] ease-out hover:text-ink-muted hover:underline focus-visible:text-ink-muted focus-visible:underline underline-offset-2"
            >
              {t("claude.suggestions.notNow")}
            </button>
            <span id={hintId} className="sr-only">
              {t("claude.suggestions.hint")}
            </span>
          </div>
        </div>
      )}
      {/* L'annuncio ha la sua regione, montata vuota con la riga: niente
          all'arrivo, «Suggestion hidden.» dopo «Not now» (shape §6). */}
      <p role="status" aria-live="polite" className="sr-only">
        {closing ? t("claude.suggestions.hidden") : ""}
      </p>
    </>
  );
}
