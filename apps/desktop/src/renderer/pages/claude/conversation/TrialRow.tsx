import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { CodeLink } from "../../../components/CodeLink";
import {
  useAutomation,
  useAutomationSimulation,
  useDepartments,
  usePeople,
} from "../../../data/queries";
import type { SimulationView, TrialOutcome, Utterance } from "../../../data/types";
import { TubeGlyph } from "../../automations/test/TestHeader";
import { MarkGlyph } from "../../automations/test/TestFlow";
import type { Ev } from "./flow";
import { WorkingRing } from "./parts";

// La riga della prova di Claude (area 10b, Task 11; shape
// `claude-automations.md` §3.3). In testa la provetta della fascia TEST e
// «Tested on 2 examples · nothing was created»; poi un esempio per riga:
// segno, l'esempio (il codice apribile, il titolo, i dati del filtro fra
// parentesi), l'esito al CONDIZIONALE e «Open the test». Gli esiti sono
// quelli di `trial.results` (`TrialOutcome`), mai rifatti qui; i dati
// dell'esempio si leggono dalla prova stessa (`getSimulation`), che esiste
// solo per chi l'ha fatta: per gli altri la riga resta senza parentesi.
// Nessun codice di task, notifica o esecuzione: la prova non ha creato niente.

type Result = TrialOutcome & { label: Utterance; written: boolean };

/** Il segno di un esito: glifo + parola, mai il solo colore (⊘ e ◐ sono inchiostro). */
function markOf(r: Result): "done" | "stopped" | "filteredOut" | "failed" {
  if (r.status === "filtered_out") return "filteredOut";
  if (r.status === "failed" || r.status === "cancelled") return "failed";
  if (r.stoppedAtClaude || r.status.startsWith("waiting_")) return "stopped";
  return "done";
}

/** I dati di una richiesta d'esempio (`richiesta.urgenza`, `richiesta.dal_supporto`), se ci sono. */
function requestData(event: Record<string, unknown> | undefined) {
  const r = event?.richiesta;
  if (!r || typeof r !== "object") return null;
  const { urgenza, dal_supporto } = r as Record<string, unknown>;
  const urgency = urgenza === "high" || urgenza === "medium" || urgenza === "low" ? urgenza : null;
  const fromSupport = typeof dal_supporto === "boolean" ? dal_supporto : null;
  return urgency === null && fromSupport === null ? null : { urgency, fromSupport };
}

/** «(urgent, from support)» / «(urgenza bassa, dal supporto)». */
function dataWords(t: TFunction, data: NonNullable<ReturnType<typeof requestData>>): string {
  const K = "claude.conversation.trial.data";
  const parts = [
    ...(data.urgency ? [t(`${K}.${data.urgency}`)] : []),
    ...(data.fromSupport === null
      ? []
      : [t(data.fromSupport ? `${K}.fromSupport` : `${K}.notFromSupport`)]),
  ];
  return `(${parts.join(", ")})`;
}

/** «an urgent request from support»: l'esempio scritto da Claude, in parole. */
function writtenWords(t: TFunction, data: ReturnType<typeof requestData>): string | null {
  if (!data) return null;
  const K = "claude.conversation.trial.request";
  const what = t(`${K}.${data.urgency ?? "any"}`);
  return data.fromSupport ? t(`${K}.fromSupport`, { what }) : what;
}

/** I conteggi maggiori di zero nell'ordine «task · email · avvisi · richieste · traguardi». */
function partsOf(t: TFunction, r: Result, department: string | null, language: string): string {
  const K = "claude.conversation.trial.parts";
  const parts: string[] = [];
  if (r.tasks > 0) {
    parts.push(
      department
        ? t(`${K}.taskFor`, { count: r.tasks, department })
        : t(`${K}.tasks`, { count: r.tasks }),
    );
  }
  if (r.emails > 0) parts.push(t(`${K}.emails`, { count: r.emails }));
  if (r.notifications > 0) parts.push(t(`${K}.notifications`, { count: r.notifications }));
  if (r.requests > 0) parts.push(t(`${K}.requests`, { count: r.requests }));
  if (r.milestones > 0) parts.push(t(`${K}.milestones`, { count: r.milestones }));
  return parts.length === 0
    ? ""
    : new Intl.ListFormat(language, { type: "conjunction" }).format(parts);
}

/** L'esito di un esempio, al condizionale. */
function outcomeWords(
  t: TFunction,
  r: Result,
  department: string | null,
  approver: string | null,
  language: string,
): string {
  const K = "claude.conversation.trial";
  if (r.status === "filtered_out") return t(`${K}.filteredOut`);
  if (r.status === "failed" || r.status === "cancelled") return t(`${K}.failed`);
  if (r.stoppedAtClaude) return t(`${K}.claude`);
  const parts = partsOf(t, r, department, language);
  const done = parts ? t(`${K}.done`, { parts }) : null;
  if (r.status === "waiting_approval") {
    if (!done) return approver ? t(`${K}.stopFor`, { name: approver }) : t(`${K}.stopAny`);
    return approver
      ? t(`${K}.thenFor`, { what: done, name: approver })
      : t(`${K}.thenAny`, { what: done });
  }
  return done ?? t(`${K}.nothing`);
}

/** Il reparto dell'unica task che la prova creerebbe, se la prova lo dice (`preview.tasks`). */
function departmentIdOf(sim: SimulationView | null | undefined, r: Result): string | null {
  if (r.tasks !== 1) return null;
  return sim?.preview.tasks[0]?.departmentId ?? null;
}

function ExampleRow({
  result,
  code,
  openable,
}: {
  result: Result;
  /** Il codice dell'automazione provata. */
  code: string | null;
  /** L'automazione c'è ancora per chi legge: «Open the test» è un link. */
  openable: boolean;
}) {
  const { t, i18n } = useTranslation();
  const sim = useAutomationSimulation(result.simId).data;
  const departments = useDepartments().data;
  const people = usePeople().data;
  const data = requestData(sim?.event);
  const departmentId = departmentIdOf(sim, result);
  const department = departmentId
    ? (departments?.find((d) => d.id === departmentId)?.name ?? null)
    : null;
  // Chi approverebbe: il livello dati lo dà solo se chi ha chiesto lo vede (R-G5).
  const approver = result.approverId
    ? (people?.find((p) => p.id === result.approverId)?.name ?? null)
    : null;
  const mark = markOf(result);
  const outcome = outcomeWords(t, result, department, approver, i18n.language);
  const params = result.label.params ?? {};
  const exampleCode = typeof params.code === "string" && params.code ? params.code : null;
  const title = typeof params.title === "string" ? params.title : "";

  return (
    <li data-trial-example className="flex min-w-0 items-start gap-2 text-md">
      <span className="pt-[3px]" data-trial-mark={mark}>
        {mark === "failed" ? (
          <span className="text-critical">
            <MarkGlyph mark="failed" />
          </span>
        ) : (
          <MarkGlyph mark={mark} />
        )}
      </span>
      <p className="min-w-0 flex-1 text-ink [overflow-wrap:anywhere]">
        {result.written ? (
          <span className="text-ink-muted">
            {(() => {
              const what = writtenWords(t, data);
              return what
                ? t("claude.conversation.trial.written", { what })
                : t("claude.conversation.trial.writtenPlain");
            })()}
          </span>
        ) : (
          <>
            {exampleCode && <CodeLink code={exampleCode} />}
            {title && <span>{` ${t("claude.conversation.trial.title", { title })}`}</span>}
            {data && <span className="text-ink-muted">{` ${dataWords(t, data)}`}</span>}
          </>
        )}
        <span aria-hidden="true" className="text-ink-faint">
          {" — "}
        </span>
        <span className={mark === "failed" ? "text-critical" : undefined}>{outcome}</span>
      </p>
      {code && (
        <span className="shrink-0 pt-px text-sm">
          {openable ? (
            <a
              href={`#/automations/${code}/test?sim=${encodeURIComponent(result.simId)}`}
              className="font-medium text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
            >
              {t("claude.conversation.trial.open")}
            </a>
          ) : (
            <span className="text-ink-muted">{t("claude.conversation.trial.open")}</span>
          )}
        </span>
      )}
    </li>
  );
}

export function TrialRow({ event }: { event: Ev<"trial"> }) {
  const { t } = useTranslation();
  const automation = useAutomation(event.automationId ?? null);
  // Annullata la creazione (o un'automazione che chi legge non vede): niente link.
  const exists = !!automation.data;
  const count = event.wants.length;

  if (event.status === "pending") {
    return (
      <p
        data-trial="pending"
        className="event-enter flex items-center gap-2 text-sm text-ink-muted"
      >
        <WorkingRing />
        {t("claude.conversation.trial.testing", { count })}
      </p>
    );
  }
  if (event.status !== "done") return null;
  const results = event.results ?? [];
  return (
    <section
      data-trial="done"
      aria-label={t("claude.conversation.trial.label")}
      className="event-enter flex min-w-0 flex-col gap-1.5"
    >
      <p className="flex items-center gap-1.5 text-sm text-ink-muted">
        <TubeGlyph />
        {t("claude.conversation.trial.head", { count: results.length })}
      </p>
      <ul className="flex min-w-0 flex-col gap-1.5">
        {results.map((r, i) => (
          <ExampleRow
            key={`${r.simId}:${i}`}
            result={r}
            code={event.code ?? null}
            openable={exists}
          />
        ))}
      </ul>
    </section>
  );
}
