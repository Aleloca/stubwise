import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  useConversation,
  useConversationStream,
  usePeople,
  usePreApprovePlan,
  useProjects,
  useRelaunchWithInstructions,
  useRequestChanges,
  useResumeCorrection,
  useRevokePlanApproval,
  useStartRun,
  useTaskWork,
} from "../../data/queries";
import type { ConversationDetail, ConversationEvent, Task, TaskRun, TaskWork } from "../../data/types";
import {
  lastMessage,
  lastReview,
  latestCorrection,
  openCard,
  pullRequestsOf,
  statusOf,
  workStory,
  type WorkStatus,
} from "../../domain/claude/taskWork";
import { relativeTime } from "../../notifications/time";
import { inputClass } from "../../tasks-ui/Dialog";
import { itemClass, MenuGroup } from "../../tasks-ui/Menu";
import { Avatar } from "../../tasks-ui/PersonChip";
import { useToast } from "../../tasks-ui/Toast";
import { PlanCard } from "../claude/conversation/PlanCard";
import { QuestionCard } from "../claude/conversation/QuestionCard";
import { MenuButton } from "../tasks/controls";
import { useInlineUpdate, useProjectMembers } from "../tasks/pickers";
import { MoreIcon, Section, ghostButton, smallPrimary, smallSecondary } from "./parts";
import { FailureBlock, PrRows, ProviderLine, UsageDisclosure } from "./ClaudeRunParts";
import { WorkStory, phaseName } from "./WorkStory";

const K = "taskDetail.claude";

/**
 * Porta un elemento in cima al pannello della task. Solo il pannello
 * scorre: `scrollIntoView` porterebbe con sé anche la pagina.
 */
export function scrollPanelTo(el: HTMLElement): void {
  const scroller = el.closest<HTMLElement>("[data-detail-panel] > .overflow-auto");
  if (!scroller) return;
  scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
}

/**
 * Sotto la barra del pannello, quando Claude aspetta chi guarda: «Claude is
 * waiting on you ↓», che porta alla sezione (e alla sua scheda).
 */
export function ClaudeWaitingNotice({ task }: { task: Task }) {
  const { t } = useTranslation();
  const work = useTaskWork(task.id).data;
  if (!work?.waitsOnViewer) return null;
  const jump = (e: { currentTarget: HTMLElement }) => {
    const status = e.currentTarget
      .closest("[data-detail-panel]")
      ?.querySelector<HTMLElement>("[data-claude-status]");
    const section = status?.closest("section");
    if (!status || !section) return;
    scrollPanelTo(section);
    status.focus({ preventScroll: true });
  };
  return (
    <div className="px-4 pb-1">
      <button
        type="button"
        onClick={jump}
        className="-ml-1.5 inline-flex h-7 items-center gap-2 rounded-md px-1.5 text-sm font-medium text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6"
      >
        <span aria-hidden="true" className="size-2 rounded-full bg-ink" />
        {t(`${K}.waitingHint`)}
        <span aria-hidden="true">↓</span>
      </button>
    </div>
  );
}

/**
 * Claude sulla task: il riassunto operativo del suo lavoro, in un ordine
 * fisso — stato, la scheda che aspetta (domanda o piano, le stesse della
 * conversazione, risolvibili qui), l'ultimo messaggio con «Open session» e
 * «Follow here», PR e correzioni, una sola azione in evidenza, la storia del
 * lavoro chiusa. I permessi sono quelli di oggi: `tickets.edit` per
 * assegnare, `runs.start` per avviare e rilanciare, `corrections.request`
 * per riprendere una correzione e chiedere modifiche; chi risponde e chi
 * decide il piano lo dice il livello dati (`canAnswer`, `canDecidePlan`).
 * «Assign to Claude» non avvia: avviare resta «Start».
 */
export function ClaudeSection({
  task,
  canEdit,
  onFollow,
}: {
  task: Task;
  canEdit: boolean;
  /** «Follow here»: il pannello diventa la conversazione della sessione. */
  onFollow: (conversationId: string) => void;
}) {
  const { t } = useTranslation();
  const work = useTaskWork(task.id);
  const title = t(`${K}.title`);

  if (work.isError) {
    return (
      <Section title={title}>
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-ink">{t(`${K}.loadFailed`)}</span>
          <button type="button" className={ghostButton} onClick={() => void work.refetch()}>
            {t(`${K}.retry`)}
          </button>
        </div>
      </Section>
    );
  }
  if (work.isPending || !work.data) {
    return (
      <Section title={title}>
        <div aria-busy="true" className="skeleton-breathe flex flex-col gap-2 py-0.5">
          <span role="status" className="sr-only">
            {t(`${K}.loading`)}
          </span>
          <span className="h-2.5 w-3/5 rounded-sm bg-ink/8" />
          <span className="h-2.5 w-4/5 rounded-sm bg-ink/8" />
        </div>
      </Section>
    );
  }
  const latest = work.data.runs.at(-1);
  if (!latest) return <NoRun task={task} work={work.data} canEdit={canEdit} />;
  return <WithRun key={latest.id} task={task} work={work.data} run={latest} onFollow={onFollow} />;
}

// --- pezzi comuni ------------------------------------------------------------

function useProjectCode(projectId: string): string {
  return useProjects().data?.find((p) => p.id === projectId)?.code ?? "";
}

function useClaudePerson() {
  return usePeople().data?.find((p) => p.isClaude);
}

/**
 * La riga di stato: l'avatar di Claude con l'anello (pulsa mentre lavora),
 * la frase e da quando. Annunciata con garbo quando cambia. Il punto «ti
 * aspetta» quando la scheda chiede a chi guarda.
 */
function StatusRow({
  state,
  text,
  at,
  working,
  waiting,
}: {
  state: string;
  text: string;
  at: string | null;
  working: boolean;
  waiting: boolean;
}) {
  const { t, i18n } = useTranslation();
  const claude = useClaudePerson();
  return (
    <div
      data-claude-status={state}
      tabIndex={-1}
      className="flex min-h-7 items-center gap-3 rounded-md pl-0.5"
    >
      <span className="relative grid size-[22px] shrink-0 place-items-center">
        <Avatar person={claude} />
        {working && (
          <span
            aria-hidden="true"
            className="rail-pulse absolute -inset-[4px] rounded-full border-2 border-dashed border-claude"
          />
        )}
      </span>
      <p aria-live="polite" className="flex min-w-0 flex-1 items-center gap-2 text-md text-ink">
        {waiting && <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-ink" />}
        <span className="min-w-0 [overflow-wrap:anywhere]">{text}</span>
      </p>
      {at && (
        <time dateTime={at} className="num shrink-0 text-xs text-ink-faint">
          {relativeTime(at, t, i18n.language)}
        </time>
      )}
    </div>
  );
}

/** Una frase in grigio: chi può fare ciò che chi guarda non può. */
function Who({ children }: { children: ReactNode }) {
  return <p className="text-sm text-ink-muted">{children}</p>;
}

/** Il campo che si apre nella sezione (rilancio, modifiche): ⌘Enter manda, «Cancel» chiude. */
function InlineForm({
  label,
  placeholder,
  submit,
  pending,
  onSubmit,
  onCancel,
}: {
  label: string;
  placeholder: string;
  submit: string;
  pending: boolean;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const id = useId();
  const hint = useId();
  const send = () => {
    if (text.trim() && !pending) onSubmit(text.trim());
  };
  return (
    <form
      className="event-enter flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      <textarea
        id={id}
        autoFocus
        rows={3}
        value={text}
        placeholder={placeholder}
        aria-describedby={hint}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            send();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        className={`${inputClass} resize-none`}
      />
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span id={hint} className="mr-auto text-xs text-ink-faint">
          {t(`${K}.sendHint`)}
        </span>
        <button type="button" className={smallSecondary} onClick={onCancel}>
          {t(`${K}.cancel`)}
        </button>
        <button type="submit" className={smallPrimary} disabled={pending || !text.trim()}>
          {submit}
        </button>
      </div>
    </form>
  );
}

/** Il messaggio d'errore di una scrittura: un lavoro già vivo lo dice, il resto «riprova». */
function useFailure() {
  const { t } = useTranslation();
  const toast = useToast();
  return (error: Error) =>
    toast.error(error.message === "conflict" ? t(`${K}.conflict`) : t(`${K}.failed`));
}

// --- nessuna sessione ---------------------------------------------------------

/**
 * Claude non ha ancora lavorato sulla task: «Assign to Claude» (se è nel
 * progetto) e, assegnata, «Ready to start» con «Start».
 */
function NoRun({ task, work, canEdit }: { task: Task; work: TaskWork; canEdit: boolean }) {
  const { t } = useTranslation();
  const change = useInlineUpdate();
  const start = useStartRun();
  const failed = useFailure();
  const code = useProjectCode(task.projectId);
  const members = useProjectMembers(task.projectId);
  const claude = members?.find((p) => p.isClaude);
  const assigned = !!claude && task.assigneeId === claude.id;

  // Una task che dice uno stato di Claude senza una sessione visibile (chi
  // guarda non le vede, o non ce ne sono): lo stato della task, in neutro,
  // senza anello, sessioni né azioni.
  if (task.claude !== "none" || work.hiddenRuns) {
    return (
      <Section title={t(`${K}.title`)}>
        <StatusRow
          state="neutral"
          text={t(`${K}.states.${task.claude}`)}
          at={null}
          working={false}
          waiting={false}
        />
        {work.hiddenRuns && <Who>{t(`${K}.hiddenRuns`, { code })}</Who>}
        {/* I consumi li vede chi vede la task, anche senza vederne le sessioni (come il web). */}
        <UsageDisclosure usage={work.usage} />
      </Section>
    );
  }
  if (assigned) {
    // Chiusa (o con un lavoro vivo che non vede): assegnata, ma non si avvia.
    const ready = work.actions.start !== "unavailable";
    return (
      <Section title={t(`${K}.title`)}>
        <StatusRow
          state={ready ? "ready" : "none"}
          text={ready ? t(`${K}.status.ready`) : t(`${K}.states.none`)}
          at={null}
          working={false}
          waiting={false}
        />
        {!ready ? null : work.actions.start === "allowed" ? (
          <button
            type="button"
            className={`${smallPrimary} self-start`}
            disabled={start.isPending}
            onClick={() => start.mutate(task.id, { onError: failed })}
          >
            {t(`${K}.start`)}
          </button>
        ) : (
          <Who>{t(`${K}.whoCanStart`, { code })}</Who>
        )}
      </Section>
    );
  }
  return (
    <Section title={t(`${K}.title`)}>
      <StatusRow
        state="none"
        text={members && !claude ? t(`${K}.notMember`) : t(`${K}.notOnTask`)}
        at={null}
        working={false}
        waiting={false}
      />
      {claude && canEdit && (
        <button
          type="button"
          className={`${smallSecondary} self-start`}
          onClick={() => change(task, { assigneeId: claude.id })}
        >
          {t(`${K}.assign`)}
        </button>
      )}
    </Section>
  );
}

// --- con una sessione -----------------------------------------------------------

/** La frase di stato, dal punto di vista di chi guarda. */
function statusText(
  t: ReturnType<typeof useTranslation>["t"],
  status: WorkStatus,
  detail: ConversationDetail | null,
  name: (id: string | null) => string,
  pr: "open" | "merged" | null,
): string {
  switch (status.kind) {
    case "none":
      return t(`${K}.notOnTask`);
    case "working":
      return status.action
        ? t(`${K}.status.workingOn`, { action: status.action })
        : t(`${K}.status.working`);
    case "idle":
      return t(`${K}.status.idle`);
    case "awaiting_answer":
      return t(`${K}.status.${detail?.canAnswer ? "yourAnswer" : "answer"}`);
    case "awaiting_approval":
      return t(`${K}.status.${detail?.canDecidePlan ? "yourApproval" : "approval"}`);
    case "paused":
      return status.byId
        ? t(`${K}.status.pausedBy`, { name: name(status.byId) })
        : t(`${K}.status.paused`, { phase: phaseName(t, status.phase) });
    case "done":
      return t(`${K}.status.${pr === "open" ? "donePr" : pr === "merged" ? "doneMerged" : "done"}`);
    case "ended":
      if (status.outcome === "stopped" && status.byId) {
        return t(`${K}.status.stoppedBy`, { name: name(status.byId) });
      }
      return t(`${K}.status.${status.outcome}`, { phase: phaseName(t, status.phase) });
  }
}

type Form = "relaunch" | "request" | null;

function WithRun({
  task,
  work,
  run,
  onFollow,
}: {
  task: Task;
  work: TaskWork;
  run: TaskRun;
  onFollow: (conversationId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const detail = useConversation(run.id).data ?? null;
  const stream = useConversationStream(run.id, { passive: true });
  const people = usePeople().data;
  const code = useProjectCode(task.projectId);
  const failed = useFailure();
  const relaunch = useRelaunchWithInstructions();
  const request = useRequestChanges();
  const resume = useResumeCorrection();
  const preApprove = usePreApprovePlan();
  const revoke = useRevokePlanApproval();
  const [form, setForm] = useState<Form>(null);
  const sectionRef = useRef<HTMLElement>(null);

  // Dal vivo quando lo stream ha dato qualcosa; stato ed esito dal dettaglio.
  const events: ConversationEvent[] = stream.events.length > 0 ? stream.events : run.events;
  const current: TaskRun = detail ? { ...run, state: detail.state, outcome: detail.outcome } : run;
  const status = statusOf(current, events);
  const name = (id: string | null) => people?.find((p) => p.id === id)?.name ?? "";

  // La scheda che aspetta, e quella appena risolta qui (si riduce alla riga d'esito).
  const pending = openCard(events);
  const [cardId, setCardId] = useState<string | null>(pending?.id ?? null);
  if (pending && pending.id !== cardId) setCardId(pending.id);
  const card = events.find((e) => e.id === cardId) ?? null;

  // Il pannello si apre già sulla scheda che aspetta chi guarda (una volta).
  const scrolled = useRef(false);
  useEffect(() => {
    if (scrolled.current || !work.waitsOnViewer) return;
    scrolled.current = true;
    if (sectionRef.current) scrollPanelTo(sectionRef.current);
  }, [work.waitsOnViewer]);

  const prs = work.software ? pullRequestsOf(work, events) : [];
  const review = work.software ? lastReview(work, events) : null;
  const correction = work.software ? latestCorrection(work, events) : null;
  const story = workStory(work, events);
  const message = lastMessage(events);

  // Le azioni le decide il livello dati (stato della task, lavoro vivo, PR,
  // permessi); qui si sceglie solo quale va in evidenza.
  const { actions } = work;
  const stopped = status.kind === "paused" || status.kind === "ended";

  const toSession = () => void navigate({ to: "/claude/$id", params: { id: run.id } });

  // L'azione in evidenza: una sola, secondo lo stato.
  let primary: ReactNode = null;
  if (actions.resume !== "unavailable") {
    primary = actions.resume === "allowed" ? (
      <button
        type="button"
        className={`${smallPrimary} self-start`}
        disabled={resume.isPending}
        onClick={() => resume.mutate(task.id, { onError: failed })}
      >
        {t(`${K}.resume`)}
      </button>
    ) : (
      <Who>{t(`${K}.whoCanResume`, { code })}</Who>
    );
  } else if (stopped && actions.relaunch !== "unavailable") {
    primary = actions.relaunch === "allowed" ? (
      form === "relaunch" ? null : (
        <button type="button" className={`${smallPrimary} self-start`} onClick={() => setForm("relaunch")}>
          {t(`${K}.relaunch`)}
        </button>
      )
    ) : (
      <Who>{t(`${K}.whoCanRelaunch`, { code })}</Who>
    );
  } else if (actions.requestChanges !== "unavailable") {
    primary = actions.requestChanges === "allowed" ? (
      form === "request" ? null : (
        <button type="button" className={`${smallPrimary} self-start`} onClick={() => setForm("request")}>
          {t(`${K}.requestChanges`)}
        </button>
      )
    ) : (
      <Who>{t(`${K}.whoCanRequest`, { code })}</Who>
    );
  }

  // «⋯»: approvazione in anticipo e revoca (`plans.approve`, dal livello
  // dati), il rilancio quando non è già l'azione in evidenza, la sessione.
  const relaunchInMenu = actions.relaunch === "allowed" && !stopped;
  const menu = (
    <MenuButton
      menuLabel={t(`${K}.more`)}
      ariaLabel={t(`${K}.more`)}
      title={t(`${K}.more`)}
      align="right"
      className={`${ghostButton} w-7 justify-center px-0 aria-expanded:bg-ink/8`}
      label={<MoreIcon />}
    >
      {(close) => (
        <MenuGroup>
          {detail?.canPreApprovePlan && (
            <MenuItem
              onSelect={() => {
                close();
                preApprove.mutate(run.id, { onError: failed });
              }}
            >
              {t(`${K}.preApprove`)}
            </MenuItem>
          )}
          {detail?.canRevokePlanApproval && (
            <MenuItem
              onSelect={() => {
                close();
                revoke.mutate(run.id, { onError: failed });
              }}
            >
              {t(`${K}.revokePreApproval`)}
            </MenuItem>
          )}
          {relaunchInMenu && (
            <MenuItem
              onSelect={() => {
                close();
                setForm("relaunch");
              }}
            >
              {t(`${K}.relaunch`)}
            </MenuItem>
          )}
          <MenuItem
            onSelect={() => {
              close();
              toSession();
            }}
          >
            {t(`${K}.openSession`)}
          </MenuItem>
        </MenuGroup>
      )}
    </MenuButton>
  );

  const working = status.kind === "working";
  return (
    <Section title={t(`${K}.title`)} action={menu} sectionRef={sectionRef}>
      <StatusRow
        state={status.kind}
        text={statusText(
          t,
          status,
          detail,
          name,
          prs.some((p) => p.state === "open")
            ? "open"
            : prs.length > 0 && prs.every((p) => p.state === "merged")
              ? "merged"
              : null,
        )}
        at={"at" in status ? status.at : null}
        working={working}
        waiting={work.waitsOnViewer}
      />
      {run.provider && <ProviderLine provider={run.provider} />}
      {status.kind === "ended" && status.outcome !== "stopped" && run.failureSummary && (
        <FailureBlock summary={run.failureSummary} phase={status.phase} events={events} />
      )}
      {detail?.planPreApproved && detail.canRevokePlanApproval && (
        <p className="text-sm text-ink-muted">{t(`${K}.preApproved`)}</p>
      )}

      {card?.type === "question" && (
        <QuestionCard
          conversationId={run.id}
          event={card}
          canAnswer={detail?.canAnswer ?? false}
          ownerId={run.ownerId}
          projectCode={code || null}
        />
      )}
      {card?.type === "plan" && (
        <PlanCard
          conversationId={run.id}
          event={card}
          canDecidePlan={detail?.canDecidePlan ?? false}
          projectCode={code || null}
          onReadFull={toSession}
        />
      )}

      {message && (
        <p className="line-clamp-2 text-sm text-ink-muted [overflow-wrap:anywhere]">
          <span className="sr-only">{t(`${K}.lastMessage`)}: </span>
          {plain(message.text)}
        </p>
      )}
      <p className="flex flex-wrap items-center gap-x-1 text-sm">
        <Link
          to="/claude/$id"
          params={{ id: run.id }}
          className="-ml-1.5 inline-flex h-7 items-center gap-1 rounded-md px-1.5 font-medium text-ink underline decoration-ink/30 underline-offset-4 hover:decoration-ink"
        >
          {t(`${K}.openSession`)}
          <span aria-hidden="true">→</span>
        </Link>
        <button
          type="button"
          data-follow-here
          className={`${ghostButton} ml-auto`}
          onClick={() => onFollow(run.id)}
        >
          {t(`${K}.followHere`)}
        </button>
      </p>

      {(prs.length > 0 || review || correction) && (
        <ul className="flex flex-col border-t border-rule pt-1">
          <PrRows prs={prs} cycles={work.cycles} />
          {review && (
            <li className="flex min-h-8 items-center text-sm text-ink-muted">
              <span className="min-w-0 truncate" title={review}>
                {review}
              </span>
            </li>
          )}
          {/* Il ciclo del «server», quando c'è, dice già a che giro è la correzione. */}
          {correction && work.cycles.length === 0 && (
            <li className="flex min-h-8 items-center text-sm text-ink-muted">
              {t(`${K}.correction.${correction.ordinal === null ? "cancelled" : correction.state}`, {
                n: correction.ordinal,
                time: relativeTime(correction.at, t, i18n.language),
              })}
            </li>
          )}
        </ul>
      )}

      {primary}
      {form === "relaunch" && (
        <InlineForm
          label={t(`${K}.relaunchLabel`)}
          placeholder={t(`${K}.relaunchPlaceholder`)}
          submit={t(`${K}.relaunchSend`)}
          pending={relaunch.isPending}
          onCancel={() => setForm(null)}
          onSubmit={(instructions) =>
            relaunch.mutate(
              { taskId: task.id, instructions },
              { onSuccess: () => setForm(null), onError: failed },
            )
          }
        />
      )}
      {form === "request" && (
        <InlineForm
          label={t(`${K}.requestLabel`)}
          placeholder={t(`${K}.requestPlaceholder`)}
          submit={t(`${K}.requestSend`)}
          pending={request.isPending}
          onCancel={() => setForm(null)}
          onSubmit={(text) =>
            request.mutate({ taskId: task.id, text }, { onSuccess: () => setForm(null), onError: failed })
          }
        />
      )}

      <WorkStory entries={story} />
      <UsageDisclosure usage={work.usage} />
    </Section>
  );
}

function MenuItem({ onSelect, children }: { onSelect: () => void; children: ReactNode }) {
  return (
    <button type="button" role="menuitem" tabIndex={-1} className={itemClass} onClick={onSelect}>
      {children}
    </button>
  );
}

/** Il testo dell'ultimo messaggio per due righe: senza segni di Markdown né a capo. */
function plain(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*(?:#+|>|[-+*]|\d+\.)\s+/gm, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
