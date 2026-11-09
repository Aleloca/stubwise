import { createContext, useContext, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { CapabilityId } from "../../../data/types";
import type { Ev } from "./flow";

// La risposta onesta S0 (area 10b, Task 11; shape `claude-scenarios.md`
// §3.5): cosa sa fare il prototipo, una riga per voce. Nella conversazione
// ogni riga è un bottone che SCRIVE la frase d'esempio nella casella senza
// inviarla (il primo segnaposto selezionato, Tab al successivo); senza una
// casella (chi legge la pubblica di un altro) le righe sono testo. Le voci
// sono dati: etichette e frasi si leggono nella lingua di chi guarda.

/**
 * Scrive un testo nella casella della conversazione, senza inviarlo (il
 * chiamante la mette al posto di ciò che c'era, ⌘Z lo riporta). `null`:
 * qui non c'è una casella in cui scrivere.
 */
export const ComposerWriteContext = createContext<((text: string) => void) | null>(null);

/** Il segnaposto del progetto, nelle due lingue: con un progetto nel contesto è già il suo codice ([SC 6]). */
const PROJECT_SLOT = /\[(project|progetto)\]/g;

export function capabilityPrompt(
  t: (key: string) => string,
  id: CapabilityId,
  projectCode: string | null,
): string {
  const text = t(`claude.answers.capabilities.prompt.${id}`);
  return projectCode ? text.replace(PROJECT_SLOT, projectCode) : text;
}

/** ↵ disegnato: la riga scrive nella casella. */
function ReturnGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <path d="M12.5 3.5v4a2 2 0 0 1-2 2H4M6.5 7 4 9.5 6.5 12" />
    </svg>
  );
}

export function CapabilitiesList({
  event,
  projectCode,
}: {
  event: Ev<"capabilities">;
  projectCode: string | null;
}) {
  const { t } = useTranslation();
  const write = useContext(ComposerWriteContext);
  const label = t("claude.conversation.capabilities.label");

  if (!write) {
    return (
      <ul aria-label={label} data-capabilities className="event-enter flex flex-col">
        {event.items.map((id) => (
          <li key={id} className="flex min-h-8 items-center text-md text-ink">
            {t(`claude.answers.capabilities.label.${id}`)}
          </li>
        ))}
      </ul>
    );
  }

  // ↑/↓ fra le righe; Invio scrive (il bottone).
  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (at === -1) return;
    e.preventDefault();
    const next = (at + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
    rows[next]?.focus();
  };

  return (
    <ul
      aria-label={label}
      data-capabilities
      onKeyDown={onKeyDown}
      className="event-enter -mx-2 flex flex-col"
    >
      {event.items.map((id) => (
        <li key={id}>
          <button
            type="button"
            data-capability={id}
            onClick={() => write(capabilityPrompt(t, id, projectCode))}
            className="group/cap flex min-h-8 w-full min-w-0 items-center gap-3 rounded-[6px] px-2 py-1 text-left text-md text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 focus-visible:bg-ink/6 active:bg-ink/10"
          >
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
              {t(`claude.answers.capabilities.label.${id}`)}
            </span>
            <span
              aria-hidden="true"
              className="flex shrink-0 items-center gap-1 text-xs text-ink-faint opacity-0 transition-opacity duration-[var(--duration-fast)] ease-out group-hover/cap:opacity-100 group-focus-visible/cap:opacity-100 motion-reduce:transition-none"
            >
              <ReturnGlyph />
              {t("claude.conversation.capabilities.write")}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
