import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useDecisionLog,
  usePeople,
  useRecordDecision,
  useSetDecisionSuperseded,
  useTasks,
} from "../../data/queries";
import type { DecisionLogEntry, Task } from "../../data/types";
import { can, useViewer } from "../../data/viewing";
import { supersedeCandidates } from "../../domain/decisionLog";
import { formatDate } from "../../notifications/time";
import { Dialog, DialogField, inputClass, selectButtonClass } from "../../tasks-ui/Dialog";
import { MenuGroup, RadioItem } from "../../tasks-ui/Menu";
import { useToast } from "../../tasks-ui/Toast";
import { BLOCK_CAP, BlockSection, Capped, queryState, useOpenTask } from "../home/blocks/BlockSection";
import { MoreIcon, ghostButton } from "../task/parts";
import { Chevron, MenuButton, primaryButton, secondaryButton } from "../tasks/controls";

/**
 * «Decision log»: i FATTI del progetto, dal più recente — titolo, la
 * decisione, il contesto, chi e quando, da dove viene (a mano, risposta a
 * una domanda di Claude, revisione di un piano, proposta accettata, posta),
 * e «Superseded by …» quando un'altra l'ha cambiata (resta, attenuata: una
 * scelta revocata è comunque accaduta). Nessun testo qui è scritto
 * dall'AI, e nessuno porta l'etichetta «Generated text». «Record a
 * decision» con `decisions.record`.
 *
 * `fromLink` (area 10a): il link di una riga D di Claude apre il dialogo
 * all'arrivo, con la task del codice se chi guarda la vede in questo
 * progetto (altrimenti senza task) e il testo sempre vuoto; `onLinkDone`
 * quando il dialogo si chiude.
 */
export function DecisionLog({
  projectId,
  fromLink = null,
  onLinkDone,
  focusId = null,
}: {
  projectId: string;
  fromLink?: { taskCode: string | null } | null;
  onLinkDone?: () => void;
  /**
   * La riga da portare in vista e col fuoco (area 11a: «Open in the
   * register» di un blocco decisione). Una riga che non c'è (o che chi
   * guarda non vede) non fa niente.
   */
  focusId?: string | null;
}) {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const log = useDecisionLog(projectId);
  const tasks = useTasks({ projectIds: [projectId] });
  const people = usePeople();
  const [recording, setRecording] = useState(false);
  const canRecord = can(viewer, "decisions.record", projectId);
  const entries = log.data ?? [];
  const linked = fromLink !== null;
  // Senza `decisions.record` il link non apre niente: l'indirizzo torna
  // quello dell'Overview, così `task` non resta lì a spegnere il pannello.
  useEffect(() => {
    if (!linked) return;
    if (canRecord) setRecording(true);
    else onLinkDone?.();
  }, [linked, canRecord, onLinkDone]);
  // Il dialogo aperto dal link non ha un bottone che l'ha aperto: chiuso
  // (Record o Cancel), il fuoco va su «Record a decision», non sul body.
  const recordButton = useRef<HTMLButtonElement>(null);
  const [refocus, setRefocus] = useState(false);
  useEffect(() => {
    if (!refocus || recording) return;
    setRefocus(false);
    recordButton.current?.focus();
  }, [refocus, recording]);
  const linkTaskId =
    (fromLink?.taskCode && tasks.data?.find((x) => x.code === fromLink.taskCode)?.id) || null;
  const byId = new Map(entries.map((d) => [d.id, d]));
  const focusAt = focusId ? entries.findIndex((d) => d.id === focusId) : -1;
  const focused = useRef<string | null>(null);
  useEffect(() => {
    if (focusAt < 0 || focused.current === focusId) return;
    const row = document.querySelector<HTMLElement>(`[data-decision="${CSS.escape(focusId!)}"]`);
    if (!row) return;
    focused.current = focusId;
    row.scrollIntoView?.({ block: "center" });
    row.focus();
  });

  const state = queryState([log, tasks, people], {
    when: entries.length === 0,
    text: t("overview.decisions.empty"),
    body: canRecord ? undefined : t("overview.decisions.whoCan"),
  });

  return (
    <>
      <BlockSection
        title={t("overview.decisions.title")}
        state={state}
        action={
          canRecord ? (
            <button
              ref={recordButton}
              type="button"
              className={secondaryButton}
              onClick={() => setRecording(true)}
            >
              {t("overview.decisions.record")}
            </button>
          ) : undefined
        }
      >
        <Capped
          key={focusAt >= BLOCK_CAP ? "open" : "capped"}
          initiallyOpen={focusAt >= BLOCK_CAP}
          items={entries}
          label={t("overview.decisions.title")}
          render={(d) => (
            <DecisionRow
              key={d.id}
              entry={d}
              supersededBy={d.supersededById ? byId.get(d.supersededById) : undefined}
              task={tasks.data?.find((x) => x.id === d.taskId)}
              who={people.data?.find((p) => p.id === d.decidedById)?.name}
              entries={canRecord ? entries : undefined}
              focusable={d.id === focusId}
            />
          )}
        />
      </BlockSection>
      {recording && (
        <RecordDecisionDialog
          projectId={projectId}
          taskId={linked ? linkTaskId : null}
          entries={entries}
          onClose={() => {
            setRecording(false);
            if (linked) {
              setRefocus(true);
              onLinkDone?.();
            }
          }}
        />
      )}
    </>
  );
}

function DecisionRow({
  entry,
  supersededBy,
  task,
  who,
  entries,
  focusable = false,
}: {
  entry: DecisionLogEntry;
  supersededBy: DecisionLogEntry | undefined;
  task: Task | undefined;
  who: string | undefined;
  /** Il registro del progetto, solo per chi ha `decisions.record`: apre il menu della voce. */
  entries?: DecisionLogEntry[];
  /** La riga citata da un blocco decisione: prende il fuoco all'arrivo (anello di fuoco). */
  focusable?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const openTask = useOpenTask();
  const superseded = !!entry.supersededById;
  return (
    <li
      data-decision={entry.id}
      data-superseded={superseded ? "true" : undefined}
      tabIndex={focusable ? -1 : undefined}
      className="relative flex flex-col gap-1 border-b border-rule py-3 pr-3 pl-4 focus:outline-2 focus:-outline-offset-2 focus:outline-focus focus:outline-solid"
    >
      <div
        className={`flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 ${entries ? "pr-9" : ""}`}
      >
        <h3
          className={`min-w-0 text-md font-semibold ${superseded ? "text-ink-muted" : "text-ink"}`}
        >
          {entry.title}
        </h3>
        {superseded && (
          <span className="text-xs font-medium text-ink-muted">
            {supersededBy
              ? t("overview.decisions.supersededBy", { title: supersededBy.title })
              : t("overview.decisions.superseded")}
          </span>
        )}
      </div>
      {entries && (
        <span className="absolute top-2 right-2">
          <EntryMenu entry={entry} entries={entries} />
        </span>
      )}
      <p className={`max-w-[72ch] text-md ${superseded ? "text-ink-muted" : "text-ink"}`}>
        {entry.decision}
      </p>
      {entry.context && <p className="max-w-[72ch] text-sm text-ink-muted">{entry.context}</p>}
      <p className="flex flex-wrap items-baseline gap-x-1.5 text-xs text-ink-muted">
        <span>{who ?? t("overview.decisions.someone")}</span>
        <span aria-hidden="true">·</span>
        <span className="num">{formatDate(entry.decidedAt, i18n.language)}</span>
        <span aria-hidden="true">·</span>
        <span>{t(`overview.decisions.sources.${entry.source}`)}</span>
        {task && (
          <>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              onClick={() => openTask(task.code)}
              title={task.title}
              className="rounded-sm text-ink-muted underline-offset-4 hover:text-ink hover:underline"
            >
              <span className="num font-semibold">{task.code}</span> {task.title}
            </button>
          </>
        )}
      </p>
    </li>
  );
}

/**
 * Il menu di una voce (`decisions.record`): «Superseded by» si cambia
 * scegliendo un'altra voce dello stesso progetto, o «None» se vale di
 * nuovo. Le voci che chiuderebbero un giro non si offrono.
 */
function EntryMenu({ entry, entries }: { entry: DecisionLogEntry; entries: DecisionLogEntry[] }) {
  const { t } = useTranslation();
  const toast = useToast();
  const set = useSetDecisionSuperseded();
  const candidates = supersedeCandidates(entries, entry.id);
  const pick = (supersededById: string | null) => {
    if (supersededById === entry.supersededById) return;
    set.mutate(
      { id: entry.id, supersededById },
      {
        onSuccess: () => toast.show(t("overview.decisions.supersededSaved")),
        onError: () => toast.error(t("overview.decisions.supersededFailed")),
      },
    );
  };
  const label = t("overview.decisions.actions", { title: entry.title });
  return (
    <MenuButton
      menuLabel={label}
      ariaLabel={label}
      title={label}
      align="right"
      disabled={set.isPending}
      className={`${ghostButton} w-7 justify-center px-0 aria-expanded:bg-ink/8`}
      label={<MoreIcon />}
    >
      {(close) => (
        <MenuGroup label={t("overview.decisions.supersededByGroup")}>
          <RadioItem
            checked={entry.supersededById === null}
            onSelect={() => {
              close();
              pick(null);
            }}
          >
            {t("overview.decisions.supersededNone")}
          </RadioItem>
          {candidates.map((d) => (
            <RadioItem
              key={d.id}
              checked={d.id === entry.supersededById}
              onSelect={() => {
                close();
                pick(d.id);
              }}
            >
              <span className="min-w-0 truncate" title={d.title}>
                {d.title}
              </span>
            </RadioItem>
          ))}
        </MenuGroup>
      )}
    </MenuButton>
  );
}

/**
 * «Record a decision»: titolo e decisione (obbligatori), il contesto e, se
 * cambia una scelta già nel registro, quale supera. La voce è di chi la
 * scrive, col suo testo. Un errore si dice nel dialogo, senza perdere ciò
 * che si è scritto. `taskId` (area 10a, dal link di Claude): la task della
 * voce, mostrata in testa al dialogo, senza un selettore; già risolta con la
 * visibilità di chi guarda.
 */
function RecordDecisionDialog({
  projectId,
  taskId = null,
  entries,
  onClose,
}: {
  projectId: string;
  taskId?: string | null;
  entries: DecisionLogEntry[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const record = useRecordDecision();
  const task = useTasks({ projectIds: [projectId] }).data?.find((x) => x.id === taskId);
  const [title, setTitle] = useState("");
  const [decision, setDecision] = useState("");
  const [context, setContext] = useState("");
  const [supersedesId, setSupersedesId] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const decisionId = useId();
  const contextId = useId();
  const current = entries.filter((d) => !d.supersededById);
  const supersedes = current.find((d) => d.id === supersedesId);

  const submit = () => {
    setTried(true);
    if (!title.trim() || !decision.trim()) return;
    setError(null);
    record.mutate(
      { projectId, draft: { title, decision, context, supersedesId, taskId: task?.id ?? null } },
      {
        onSuccess: () => {
          toast.show(t("overview.decisions.recorded"));
          onClose();
        },
        onError: () => setError(t("overview.decisions.failed")),
      },
    );
  };

  return (
    <Dialog
      title={t("overview.decisions.recordTitle")}
      description={t("overview.decisions.recordDescription")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("overview.cancel")}
          </button>
          <button
            type="submit"
            form="record-decision"
            className={primaryButton}
            disabled={record.isPending}
          >
            {t("overview.decisions.submit")}
          </button>
        </>
      }
    >
      <form
        id="record-decision"
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {error && (
          <p role="alert" className="text-sm text-critical">
            {error}
          </p>
        )}
        {task && (
          <p data-testid="decision-task" className="flex min-w-0 items-baseline gap-1.5 text-sm">
            <span className="shrink-0 text-ink-muted">{t("overview.decisions.forTask")}</span>
            <span className="num shrink-0 font-semibold text-ink">{task.code}</span>
            <span className="min-w-0 truncate text-ink" title={task.title}>
              {task.title}
            </span>
          </p>
        )}
        <DialogField label={t("overview.decisions.fieldTitle")} htmlFor={titleId}>
          <input
            id={titleId}
            data-autofocus
            value={title}
            aria-invalid={tried && !title.trim()}
            placeholder={t("overview.decisions.titlePlaceholder")}
            onChange={(e) => setTitle(e.target.value)}
            className={`${inputClass} ${tried && !title.trim() ? "border-critical" : ""}`}
          />
          {tried && !title.trim() && (
            <span className="text-xs text-critical">{t("overview.decisions.titleMissing")}</span>
          )}
        </DialogField>
        <DialogField label={t("overview.decisions.fieldDecision")} htmlFor={decisionId}>
          <textarea
            id={decisionId}
            rows={3}
            value={decision}
            aria-invalid={tried && !decision.trim()}
            onChange={(e) => setDecision(e.target.value)}
            className={`${inputClass} resize-y ${tried && !decision.trim() ? "border-critical" : ""}`}
          />
          {tried && !decision.trim() && (
            <span className="text-xs text-critical">{t("overview.decisions.decisionMissing")}</span>
          )}
        </DialogField>
        <DialogField
          label={t("overview.decisions.fieldContext")}
          htmlFor={contextId}
          hint={t("overview.decisions.contextHint")}
        >
          <textarea
            id={contextId}
            rows={2}
            value={context}
            onChange={(e) => setContext(e.target.value)}
            className={`${inputClass} resize-y`}
          />
        </DialogField>
        {current.length > 0 && (
          <DialogField label={t("overview.decisions.fieldSupersedes")}>
            <MenuButton
              menuLabel={t("overview.decisions.fieldSupersedes")}
              ariaLabel={t("overview.decisions.supersedesValue", {
                title: supersedes?.title ?? t("overview.decisions.supersedesNone"),
              })}
              wrapperClassName="flex w-full min-w-0"
              className={selectButtonClass}
              label={
                <>
                  <span className={`min-w-0 flex-1 truncate ${supersedes ? "" : "text-ink-muted"}`}>
                    {supersedes?.title ?? t("overview.decisions.supersedesNone")}
                  </span>
                  <Chevron />
                </>
              }
            >
              {(close) => (
                <MenuGroup>
                  <RadioItem
                    checked={supersedesId === null}
                    onSelect={() => {
                      close();
                      setSupersedesId(null);
                    }}
                  >
                    {t("overview.decisions.supersedesNone")}
                  </RadioItem>
                  {current.map((d) => (
                    <RadioItem
                      key={d.id}
                      checked={d.id === supersedesId}
                      onSelect={() => {
                        close();
                        setSupersedesId(d.id);
                      }}
                    >
                      <span className="min-w-0 truncate">{d.title}</span>
                    </RadioItem>
                  ))}
                </MenuGroup>
              )}
            </MenuButton>
          </DialogField>
        )}
      </form>
    </Dialog>
  );
}
