import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { ContextDescription } from "../../data/api";
import { useDescribeContext } from "../../data/queries";
import type { ContextRef } from "../../data/types";

// Il chip del contesto (area 10a, shape claude-panel.md «Il chip del
// contesto»): il riferimento che parte col messaggio, non un link. Le parole
// le traduce chi guarda; codice e progetto li dice `describeContext`, già
// riletti con la sua visibilità.

/** La parola del chip: «task», «pull request #42», «Settings → AI», «Tasks», «Home». */
function kindText(d: ContextDescription, t: TFunction): string {
  const section = d.params?.sectionKey ? t(d.params.sectionKey) : "";
  return t(d.labelKey, { number: d.params?.number, section });
}

/** Il testo intero del chip: «ACQ-14 · task», «ACQ · Settings → AI», «Home». */
export function contextText(d: ContextDescription, t: TFunction): string {
  const kind = kindText(d, t);
  return d.code ? `${d.code} · ${kind}` : kind;
}

/** Il nome breve sotto un messaggio: il codice di un oggetto («ACQ-14»), altrimenti il chip intero. */
export function contextShort(d: ContextDescription, t: TFunction): string {
  const ownCode =
    d.labelKey.startsWith("claude.panel.chip.kind.") && d.params?.number === undefined;
  return ownCode && d.code && d.labelKey !== "claude.panel.chip.kind.prNoNumber"
    ? d.code
    : contextText(d, t);
}

/**
 * Il chip: il codice in cifre tabellari (mai troncato), poi il tipo (che si
 * accorcia per primo), e la × che toglie il contesto per i messaggi
 * successivi.
 */
export function ContextChip({
  description,
  onRemove,
}: {
  description: ContextDescription;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const kind = kindText(description, t);
  return (
    <span
      data-context-chip
      title={t("claude.panel.chipTitle", { label: contextShort(description, t) })}
      className="inline-flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-md border border-rule pr-0.5 pl-2 text-sm text-ink"
    >
      {description.code && (
        <span className="num shrink-0 font-semibold whitespace-nowrap">{description.code}</span>
      )}
      {description.code && (
        <span aria-hidden="true" className="shrink-0 text-ink-faint">
          ·
        </span>
      )}
      <span className="min-w-0 truncate text-ink-muted">{kind}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={t("claude.panel.removeContext")}
        title={t("claude.panel.removeContext")}
        className="grid size-5 shrink-0 place-items-center rounded-sm text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/8 hover:text-ink"
      >
        <svg viewBox="0 0 12 12" width={10} height={10} aria-hidden="true" focusable="false">
          <path
            d="M2.5 2.5l7 7M9.5 2.5l-7 7"
            stroke="currentColor"
            strokeWidth={1.4}
            strokeLinecap="round"
          />
        </svg>
      </button>
    </span>
  );
}

/**
 * «· on ACQ-14» nella riga del nome di un messaggio inviato con un contesto
 * ([CP 4]): il riferimento riletto per chi guarda adesso. Un oggetto che
 * non vede (più) non lascia niente (R-G5).
 */
export function ContextNote({ context }: { context: ContextRef }) {
  const { t } = useTranslation();
  const d = useDescribeContext(context).data;
  if (!d) return null;
  return (
    <span data-message-context className="min-w-0 truncate text-ink-faint">
      <span aria-hidden="true">· </span>
      {t("claude.panel.on", { label: contextShort(d, t) })}
    </span>
  );
}
