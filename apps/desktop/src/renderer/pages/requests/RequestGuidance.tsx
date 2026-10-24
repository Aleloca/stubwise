import { useTranslation } from "react-i18next";
import { useProjectStatuses, useTaskWork, useUpdateRequest } from "../../data/queries";
import type { ProjectRequest, RequestPatch, RequestSuggestions, Task } from "../../data/types";
import { phaseOf } from "../../domain/claude/taskWork";
import { requestNextStep } from "../../domain/requestNextStep";
import { useToast } from "../../tasks-ui/Toast";
import { GeneratedTag } from "../overview/BriefCard";
import { Section, ghostButton, smallPrimary, smallSecondary } from "../task/parts";

// Due righe del pannello della richiesta che vengono dal web: il prossimo
// passo (derivato, mai scritto da un modello) e le proposte dell'intake sui
// metadati, da accettare o scartare con `backlog.edit`.

/**
 * La riga del prossimo passo, sotto i metadati: dove sta la richiesta nel
 * percorso idea → task → modifica pronta. Trasformata, legge la task nata da
 * lei e il lavoro di Claude (se chi guarda li vede) e porta alla task.
 */
export function NextStepLine({
  request,
  task,
  onGoTask,
}: {
  request: ProjectRequest;
  /** La task nata dalla richiesta, se chi guarda la vede. */
  task: Task | null;
  onGoTask: (code: string) => void;
}) {
  if (task) return <NextStepOfTask request={request} task={task} onGoTask={onGoTask} />;
  return <NextStepText request={request} task={null} closed={false} phase={null} pr={null} />;
}

function NextStepOfTask({
  request,
  task,
  onGoTask,
}: {
  request: ProjectRequest;
  task: Task;
  onGoTask: (code: string) => void;
}) {
  const work = useTaskWork(task.id).data;
  const statuses = useProjectStatuses(task.projectId).data;
  // Finché lavoro e stati non ci sono la riga aspetta: meglio nessuna frase che una sbagliata.
  if (work === undefined || !statuses) return null;
  const closed = statuses.find((s) => s.id === task.statusId)?.family === "closed";
  const last = work?.runs.at(-1);
  const phase = last && last.state !== "finished" ? phaseOf(last.events) : null;
  const merged = work?.pullRequests.some((p) => p.kind === "pr_merged") ?? false;
  const pr = work?.openPr ? "open" : merged ? "merged" : null;
  return (
    <NextStepText
      request={request}
      task={task}
      closed={closed}
      phase={phase}
      pr={pr}
      onGoTask={onGoTask}
    />
  );
}

function NextStepText({
  request,
  task,
  closed,
  phase,
  pr,
  onGoTask,
}: {
  request: ProjectRequest;
  task: Task | null;
  closed: boolean;
  phase: string | null;
  pr: "open" | "merged" | null;
  onGoTask?: (code: string) => void;
}) {
  const { t } = useTranslation();
  const step = requestNextStep({
    status: request.status,
    task: task ? { closed, claude: task.claude } : null,
    phase,
    pr,
  });
  if (step === null) return null;
  // Una riga dei fatti della richiesta (dentro il suo `dl`): «Next step | …».
  return (
    <div data-next-step={step} className="contents">
      <dt className="flex min-h-8 items-start pt-1.5 text-sm text-ink-muted">
        {t("requests.nextStep.label")}
      </dt>
      <dd className="flex min-h-8 min-w-0 flex-col items-start gap-0.5 py-1.5">
        <span role="status" className="text-sm text-ink [overflow-wrap:anywhere]">
          {t(`requests.nextStep.${step}`)}
        </span>
        {task && onGoTask && (
          <button
            type="button"
            className={`${ghostButton} -ml-2`}
            onClick={() => onGoTask(task.code)}
          >
            {t("requests.nextStep.goToTask", { code: task.code })}
            <span aria-hidden="true">→</span>
          </button>
        )}
      </dd>
    </div>
  );
}

const FIELDS = ["urgency", "size", "risk", "riskNote"] as const;
type Field = (typeof FIELDS)[number];

/**
 * Le proposte dell'intake sui metadati: per ogni campo il valore proposto e
 * quello di adesso («was M», «was empty»), poi il perché, etichettato come
 * testo generato. «Accept all» scrive i campi con `updateRequest` e toglie
 * le proposte; «Dismiss» le toglie e basta. Chi non ha `backlog.edit` le legge.
 */
export function SuggestionsSection({
  request,
  canEdit,
}: {
  request: ProjectRequest;
  canEdit: boolean;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const update = useUpdateRequest();
  const suggestions = request.suggestions;
  if (!suggestions) return null;
  const fields = FIELDS.filter((f) => suggestions[f] !== undefined);
  const value = (field: Field, v: RequestSuggestions[Field] | null | undefined): string | null => {
    if (v === null || v === undefined || v === "") return null;
    if (field === "urgency") return t(`requests.urgency.${v}`);
    if (field === "risk") return t(`requests.risk.${v}`);
    return String(v);
  };
  const write = (patch: RequestPatch, done?: string) =>
    update.mutate(
      { id: request.id, patch },
      {
        onSuccess: () => done && toast.show(done),
        onError: () => toast.error(t("requests.suggestions.failed")),
      },
    );
  const accept = () => {
    const patch: RequestPatch = { suggestions: null };
    for (const f of fields) Object.assign(patch, { [f]: suggestions[f] });
    write(patch, t("requests.suggestions.accepted"));
  };
  return (
    <Section title={t("requests.suggestions.title")} action={<GeneratedTag />}>
      <ul aria-label={t("requests.suggestions.listLabel")} className="flex flex-col">
        {fields.map((f) => {
          const was = value(f, request[f]);
          return (
            <li
              key={f}
              data-suggestion={f}
              className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 py-1 text-sm"
            >
              <span className="text-ink-muted">{t(`requests.suggestions.${f}`)}</span>
              {/* Una nota è una frase: il valore di prima va a capo, in grigio. */}
              <span
                className={`min-w-0 [overflow-wrap:anywhere] ${f === "riskNote" ? "flex flex-col gap-0.5" : ""}`}
              >
                <span className={f === "riskNote" ? "text-ink" : "font-medium text-ink"}>
                  {value(f, suggestions[f])}
                </span>
                <span className="text-ink-muted">
                  {f === "riskNote" ? "" : " · "}
                  {was === null
                    ? t("requests.suggestions.wasEmpty")
                    : t("requests.suggestions.was", { value: was })}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
      <p className="text-sm text-ink-muted [overflow-wrap:anywhere]">
        <span className="sr-only">{t("requests.suggestions.reason")}: </span>
        {suggestions.reason}
      </p>
      {canEdit && (
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            className={smallPrimary}
            disabled={update.isPending}
            onClick={accept}
          >
            {t("requests.suggestions.accept")}
          </button>
          <button
            type="button"
            className={smallSecondary}
            disabled={update.isPending}
            onClick={() => write({ suggestions: null })}
          >
            {t("requests.suggestions.dismiss")}
          </button>
        </div>
      )}
    </Section>
  );
}
