import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CalendarScope } from "../../data/types";
import { Dialog } from "../../tasks-ui/Dialog";
import { primaryButton, secondaryButton } from "../tasks/controls";

// «Solo questo / Tutta la serie» (shape calendar.md §6, 400 px): il titolo
// secondo l'azione, due scelte con una riga su cosa succede, conferma col
// verbo dell'azione e Cancel. Cancel o Esc rimettono le cose come stavano
// (lo decide chi apre il dialogo). Nessuna terza scelta «questo e i
// successivi»: è fuori dallo spec.

export type ScopeAction = "move" | "edit" | "delete" | "answer";

export function SeriesScopeDialog({
  action,
  dateLabel,
  onConfirm,
  onCancel,
}: {
  action: ScopeAction;
  /** La data dell'occorrenza, per «Only Thursday, Oct 29 changes». */
  dateLabel: string;
  onConfirm: (scope: CalendarScope) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [scope, setScope] = useState<CalendarScope>("one");
  const name = useId();
  const options: { value: CalendarScope; label: string; note: string }[] = [
    {
      value: "one",
      label: t("calendar.scope.one"),
      note: t("calendar.scope.oneNote", { date: dateLabel }),
    },
    { value: "series", label: t("calendar.scope.series"), note: t("calendar.scope.seriesNote") },
  ];
  return (
    <Dialog
      title={t(`calendar.scope.title.${action}`)}
      width={400}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onCancel}>
            {t("calendar.cancel")}
          </button>
          <button type="button" className={primaryButton} onClick={() => onConfirm(scope)}>
            {t(`calendar.scope.confirm.${action}`)}
          </button>
        </>
      }
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">{t(`calendar.scope.title.${action}`)}</legend>
        {options.map((o, i) => (
          <label
            key={o.value}
            className="flex cursor-pointer items-start gap-2.5 rounded-md px-1 py-1.5 transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/4"
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={scope === o.value}
              onChange={() => setScope(o.value)}
              data-autofocus={i === 0 ? "" : undefined}
              className="mt-1 size-3.5 accent-[var(--ink)]"
            />
            <span className="flex min-w-0 flex-col">
              <span className="text-sm font-medium text-ink">{o.label}</span>
              <span className="text-xs text-ink-muted">{o.note}</span>
            </span>
          </label>
        ))}
      </fieldset>
    </Dialog>
  );
}
