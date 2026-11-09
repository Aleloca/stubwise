import { Trans, useTranslation } from "react-i18next";
import type { TimelineEvent } from "../../data/types";

// Una task eliminata nella cronologia del progetto e nell'Activity del
// portafoglio (area 10a; shape claude-trace.md, task-delete.md): «Giulia
// Ferri deleted MKX-31 “Prova”», col codice e il titolo di allora. Il codice
// non è un link: la task non c'è più. Fatta con Claude, il nome diventa
// «Claude on behalf of Giulia Ferri». Chi non vede chi l'ha eliminata legge
// «someone» (R-G5).

export function DeletedTaskSubject({
  event,
}: {
  event: Extract<TimelineEvent, { kind: "task_deleted" }>;
}) {
  const { t } = useTranslation();
  const person = event.byName ?? t("taskUi.stall.someone");
  const name = event.viaClaude ? t("activity.onBehalf", { name: person }) : person;
  const text = `${name} ${event.code} ${event.title}`;
  return (
    <span className="min-w-0 truncate text-ink" title={text}>
      <Trans
        i18nKey="activity.deletedTask"
        values={{ name, code: event.code, title: event.title }}
        components={{
          code: <span className="num text-xs font-semibold tracking-[0.02em] text-ink-muted" />,
        }}
      />
    </span>
  );
}
