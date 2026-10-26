import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  useChooseMailProject,
  useCodeCitations,
  useConfirmMailProposal,
  useHandMailProposal,
  useIgnoreMailProposal,
  usePeople,
  useProjects,
  useReassignMailProposal,
  useSessionPersonId,
  useTasks,
} from "../../data/queries";
import type { MailProposalView, Person, Project, ProposedAction, Task } from "../../data/types";
import { can, useViewer } from "../../data/viewer";
import { spoken } from "../../domain/claude/answers";
import { hasModKey } from "../../platform/platform";
import { inputClass } from "../../tasks-ui/Dialog";
import { CheckBox, MenuGroup, itemClass } from "../../tasks-ui/Menu";
import { routeOfCode } from "../claude/conversation/ProposalCard";
import {
  WorkingRing,
  cardClass,
  primaryButton,
  quietButton,
  secondaryButton,
  useFocusWhenResolved,
} from "../claude/conversation/parts";
import { MenuButton } from "../tasks/controls";
import { dayLabel, whenWithTime } from "./format";
import { AlertGlyph, MoreGlyph, PersonPlusGlyph } from "./glyphs";
import { OutsiderPrompt } from "./OutsiderPrompt";

// Una proposta nata da un'email (shape mail.md §4): la stessa scheda nella
// Posta (sotto il messaggio d'origine) e in «Da decidere». Parla la lingua
// della `ProposalCardView` di Claude — contorno `rule-strong`, righe
// catalogo, l'esito al posto dei bottoni — con le differenze della posta: è
// CONDIVISA (chi decide per primo chiude per tutti, gli altri vedono chi),
// si MODIFICA sul posto (A13), ha «Passa al progetto» per chi non può
// confermare (A14) e il passo per l'incaricato fuori dal progetto (A15).
// I permessi li dice il livello dati (`canConfirm`, `canHand`,
// `outsiders`, `decidedBy`): la scheda non li deduce.

type Args = Record<string, unknown>;
type Edits = Record<number, Args>;

/** Le funzioni che si spostano su un altro progetto (non toccano oggetti del progetto). */
const PORTABLE: ReadonlySet<ProposedAction["fn"]> = new Set([
  "createTask",
  "createRequest",
  "recordDecision",
  "createMilestone",
]);

/** Le funzioni che si modificano sul posto. Una decisione no: il testo lo scrive il template. */
const EDITABLE: ReadonlySet<ProposedAction["fn"]> = new Set([
  "createTask",
  "createRequest",
  "updateTask",
  "addComment",
  "createMilestone",
]);

/** Che cosa non si può fare senza il permesso dell'azione, in parole («create tasks»). */
const ABILITY: Partial<Record<ProposedAction["fn"], string>> = {
  createTask: "createTasks",
  updateTask: "editTasks",
  createMilestone: "editTasks",
  addComment: "comment",
  createRequest: "createRequests",
  recordDecision: "recordDecisions",
};

/** Gli argomenti di un'azione con le modifiche di chi conferma (la patch si fonde). */
function effectiveArgs(action: ProposedAction, edit: Args | undefined): Args {
  if (!edit) return action.args;
  const merged: Args = { ...action.args, ...edit };
  if (edit.patch && typeof action.args.patch === "object") {
    merged.patch = { ...(action.args.patch as Args), ...(edit.patch as Args) };
  }
  return merged;
}

function assigneeOf(fn: ProposedAction["fn"], args: Args): string | null | undefined {
  if (fn === "createTask") return args.assigneeId as string | null | undefined;
  if (fn === "updateTask") return (args.patch as Args | undefined)?.assigneeId as string | null | undefined;
  return undefined;
}

const reasonKey = (error: string | null) =>
  ["forbidden", "not_found", "conflict", "invalid"].includes(error ?? "") ? error! : "other";

interface Ctx {
  t: TFunction;
  language: string;
  code: string;
  people: ReadonlyMap<string, Person>;
  tasks: ReadonlyMap<string, Task>;
}

/** La frase catalogo di un'azione (senza l'incaricato, che la riga aggiunge col suo segno). */
function phraseOf(action: ProposedAction, args: Args, ctx: Ctx): string {
  const { t, code } = ctx;
  const task = (id: unknown) => {
    const found = ctx.tasks.get(id as string);
    return found ? `${found.code} ${found.title}` : String(id ?? "");
  };
  const date = (d: unknown) => dayLabel(String(d), ctx.language);
  switch (action.fn) {
    // La scadenza della task la aggiunge la riga, dopo l'incaricato.
    case "createTask":
      return t("mail.proposal.phrase.createTask", { code, title: args.title });
    case "createRequest":
      return t("mail.proposal.phrase.createRequest", { code, title: args.title });
    case "updateTask": {
      const patch = (args.patch ?? {}) as Args;
      if (patch.dueDate) return t("mail.proposal.phrase.updateDue", { task: task(args.id), date: date(patch.dueDate) });
      return t("mail.proposal.phrase.updateTask", { task: task(args.id) });
    }
    case "addComment":
      return t("mail.proposal.phrase.addComment", { task: task(args.taskId), body: args.body });
    case "recordDecision":
      return t("mail.proposal.phrase.recordDecision", { code, title: args.title });
    case "createMilestone": {
      const base = t("mail.proposal.phrase.createMilestone", { code, name: args.name });
      return args.dueDate ? `${base} · ${date(args.dueDate)}` : base;
    }
    default:
      return spoken(t, action.summaryText, action.summary);
  }
}

export function MailProposalCard({
  view,
  alsoFor = [],
  excerptOpen = false,
  fromEmailTo,
}: {
  view: MailProposalView;
  /** Gli altri destinatari membri del progetto che la condividono (A11). */
  alsoFor?: readonly string[];
  /** L'estratto aperto di default: in «Da decidere» e per chi non ha l'email. */
  excerptOpen?: boolean;
  /** Proposta passata vista da chi non ha l'email: a chi era l'email (chi l'ha passata). */
  fromEmailTo?: string | null;
}) {
  const { t, i18n } = useTranslation();
  const me = useSessionPersonId();
  const { viewer } = useViewer();
  const p = view.proposal;
  const projects = useProjects().data;
  const peopleList = usePeople().data;
  const needsTasks = p.actions.some((a) => a.fn === "updateTask" || a.fn === "addComment");
  const taskList = useTasks(undefined, { enabled: needsTasks }).data;
  const confirm = useConfirmMailProposal();
  const ignore = useIgnoreMailProposal();
  const hand = useHandMailProposal();
  const choose = useChooseMailProject();
  const reassign = useReassignMailProposal();

  const project = projects?.find((x) => x.id === p.projectId);
  const code = project?.code ?? "";
  const people = useMemo(() => new Map((peopleList ?? []).map((x) => [x.id, x])), [peopleList]);
  const tasks = useMemo(() => new Map((taskList ?? []).map((x) => [x.id, x])), [taskList]);
  const ctx: Ctx = { t, language: i18n.language, code, people, tasks };

  const [selected, setSelected] = useState<boolean[]>(() => p.actions.map(() => true));
  const [edits, setEdits] = useState<Edits>({});
  const [editing, setEditing] = useState<{ index: number; focus?: "assignee" } | null>(null);
  const [showRead, setShowRead] = useState(excerptOpen);
  const [asking, setAsking] = useState<{ personId: string; name: string }[] | null>(null);
  const [raced, setRaced] = useState<{ hadEdits: boolean } | null>(null);
  const [added, setAdded] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const headingId = useId();

  const status = p.status;
  const choosing = p.actions.some((a) => a.fn === "chooseProject");
  const decidable = (status === "open" || status === "handed") && view.canConfirm;
  const handable = status === "open" && !view.canConfirm && view.canHand;
  const live = decidable || handable || (status === "open" && choosing);
  const resolvedRef = useFocusWhenResolved<HTMLElement>(!live);
  const busy = confirm.isPending || ignore.isPending || hand.isPending || choose.isPending || reassign.isPending;
  const many = p.actions.length > 1;
  const indexes = selected.flatMap((on, i) => (on ? [i] : []));
  const waitsOnMe = live;
  const ability = t(`mail.proposal.ability.${ABILITY[p.actions[0]?.fn ?? "createTask"] ?? "createTasks"}`);
  const members = useMemo(() => new Set(project?.memberIds ?? []), [project]);
  const outsiderIds = new Set(view.outsiders.map((o) => o.personId));
  const isOutside = (personId: string) => (project ? !members.has(personId) : outsiderIds.has(personId));

  // Chi la sta decidendo altrove non deve trovarla aperta qui: un esito nuovo
  // chiude modifica e passo «fuori dal progetto».
  useEffect(() => {
    if (!live) {
      setEditing(null);
      setAsking(null);
    }
  }, [live]);

  const fail = (e: unknown) => {
    const err = e as Error & { byId?: string | null };
    if (err.message === "already_handled") {
      setRaced({ hadEdits: Object.keys(edits).length > 0 });
      setEdits({});
      setAsking(null);
      setEditing(null);
      return;
    }
    setError(t(err.message === "forbidden" ? "mail.proposal.errorForbidden" : "mail.proposal.error"));
  };

  /** Gli incaricati fuori dal progetto fra le azioni scelte, con le modifiche. */
  const outsidersNow = () => {
    const ids = new Set<string>();
    for (const i of indexes) {
      const a = p.actions[i]!;
      const who = assigneeOf(a.fn, effectiveArgs(a, edits[i]));
      if (typeof who === "string" && isOutside(who)) ids.add(who);
    }
    return [...ids].map((personId) => ({ personId, name: people.get(personId)?.name ?? personId }));
  };

  const editsFor = (extra: Edits = {}) => {
    const out: Edits = {};
    for (const i of indexes) {
      const merged = { ...(edits[i] ?? {}), ...(extra[i] ?? {}) };
      if (Object.keys(merged).length > 0) out[i] = merged;
    }
    return out;
  };

  const run = (opts: { extra?: Edits; add?: string[] } = {}) => {
    setError(null);
    const all = indexes.length === p.actions.length;
    const payload = editsFor(opts.extra);
    confirm
      .mutateAsync({
        id: p.id,
        ...(all ? {} : { actionIndexes: indexes }),
        ...(Object.keys(payload).length ? { edits: payload } : {}),
        ...(opts.add?.length ? { addOutsiders: opts.add } : {}),
      })
      .then(() => {
        setAsking(null);
        if (opts.add?.length) setAdded(opts.add.map((id) => people.get(id)?.name ?? id));
      }, fail);
  };

  const doConfirm = () => {
    if (busy || indexes.length === 0) return;
    const out = outsidersNow();
    if (out.length > 0) {
      setEditing(null);
      setAsking(out);
      return;
    }
    run();
  };
  const leaveUnassigned = () => {
    const extra: Edits = {};
    const ids = new Set(asking?.map((o) => o.personId));
    for (const i of indexes) {
      const a = p.actions[i]!;
      const who = assigneeOf(a.fn, effectiveArgs(a, edits[i]));
      if (typeof who !== "string" || !ids.has(who)) continue;
      extra[i] =
        a.fn === "updateTask"
          ? { patch: { ...((edits[i]?.patch as Args) ?? {}), assigneeId: null } }
          : { assigneeId: null };
    }
    run({ extra });
  };
  const chooseSomeoneElse = () => {
    const ids = new Set(asking?.map((o) => o.personId));
    const index = indexes.find((i) => {
      const a = p.actions[i]!;
      const who = assigneeOf(a.fn, effectiveArgs(a, edits[i]));
      return typeof who === "string" && ids.has(who);
    });
    setAsking(null);
    if (index !== undefined) setEditing({ index, focus: "assignee" });
  };
  const doIgnore = () => {
    setError(null);
    ignore.mutateAsync(p.id).catch(fail);
  };
  const doHand = () => {
    setError(null);
    hand.mutateAsync(p.id).catch(fail);
  };

  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (e.key === "Enter" && hasModKey(e)) {
      e.preventDefault();
      if (decidable) doConfirm();
      else if (handable) doHand();
      return;
    }
    // E apre «Edit» sulla riga col fuoco (mai in un campo).
    if (e.key.toLowerCase() === "e" && !e.metaKey && !e.ctrlKey && !e.altKey && decidable) {
      const target = e.target as HTMLElement;
      if (target.closest("input:not([type=checkbox]), textarea, select")) return;
      const row = target.closest<HTMLElement>("[data-action-row]");
      if (!row) return;
      const index = Number(row.dataset.actionRow);
      if (EDITABLE.has(p.actions[index]!.fn)) {
        e.preventDefault();
        setEditing({ index });
      }
    }
  }

  const reassignTargets = (projects ?? []).filter(
    (x) => x.id !== p.projectId && x.memberIds.includes(me),
  );
  const canMove =
    status === "open" &&
    !choosing &&
    p.source !== "calendar" &&
    (view.canConfirm || view.canHand) &&
    p.actions.every((a) => PORTABLE.has(a.fn)) &&
    reassignTargets.length > 0;

  // --- l'esito ----------------------------------------------------------------
  if (!live) {
    return (
      <section
        ref={resolvedRef}
        tabIndex={-1}
        aria-labelledby={headingId}
        data-mail-proposal={p.id}
        data-status={status}
        className="event-enter flex min-w-0 flex-col gap-1.5 rounded-lg border border-rule px-4 py-3 outline-none"
      >
        <h3 id={headingId} className="sr-only">
          {t("mail.proposal.outcomeTitle", { code })}
        </h3>
        {raced && (
          <p className="text-sm text-ink">
            {t(`mail.outcome.raced_${status === "ignored" ? "ignored" : status === "handed" ? "handed" : "confirmed"}`, {
              name: view.decidedBy?.name ?? "",
            })}
            {raced.hadEdits && <span className="text-ink-muted"> {t("mail.outcome.editsDropped")}</span>}
          </p>
        )}
        <Outcome view={view} code={code} ability={ability} me={me} added={added} />
      </section>
    );
  }

  // --- la scheda da decidere ----------------------------------------------------
  const handedHeader = status === "handed" && p.handedById;
  return (
    <section
      ref={resolvedRef}
      aria-labelledby={headingId}
      data-mail-proposal={p.id}
      data-status={status}
      onKeyDown={onKeyDown}
      className={`${cardClass} gap-3 p-4`}
    >
      <header className="flex min-w-0 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          {waitsOnMe && <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-ink" />}
          <h3 id={headingId} className="min-w-0 flex-1 text-sm font-semibold text-ink">
            {handedHeader && fromEmailTo
              ? t("mail.proposal.handedHeader", { code, name: people.get(p.handedById!)?.name ?? "" })
              : choosing
                ? t("mail.proposal.choose")
                : t("mail.proposal.proposes", { count: p.actions.length })}
            {!choosing && project && (
              <span className="font-normal text-ink-muted">
                {" "}
                {t("mail.proposal.for")}{" "}
                <span className="num font-semibold tracking-[0.02em] text-ink">{project.code}</span> {project.name}
              </span>
            )}
            <span className="sr-only"> · {t("mail.proposal.waitingOnYou")}</span>
          </h3>
          {!choosing && (
            <MenuButton
              menuLabel={t("mail.proposal.menu")}
              ariaLabel={t("mail.proposal.menu")}
              align="right"
              className="grid size-7 shrink-0 place-items-center rounded-md text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink aria-expanded:bg-ink/10"
              label={<MoreGlyph />}
            >
              {(close) => (
                <>
                  <MenuGroup>
                    <button
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      className={itemClass}
                      onClick={() => {
                        setShowRead((v) => !v);
                        close();
                      }}
                    >
                      {showRead ? t("mail.proposal.hideRead") : t("mail.proposal.showRead")}
                    </button>
                  </MenuGroup>
                  {canMove && (
                    <MenuGroup label={t("mail.proposal.move")}>
                      {reassignTargets.map((x: Project) => (
                        <button
                          key={x.id}
                          type="button"
                          role="menuitem"
                          tabIndex={-1}
                          className={itemClass}
                          onClick={() => {
                            close();
                            setError(null);
                            reassign.mutateAsync({ id: p.id, projectId: x.id }).catch(fail);
                          }}
                        >
                          <span className="num w-9 shrink-0 text-xs font-semibold">{x.code}</span>
                          <span className="min-w-0 truncate">{x.name}</span>
                        </button>
                      ))}
                    </MenuGroup>
                  )}
                </>
              )}
            </MenuButton>
          )}
        </div>
        {handedHeader && fromEmailTo && (
          <p className="text-xs text-ink-muted">{t("mail.proposal.fromEmailTo", { name: fromEmailTo })}</p>
        )}
        {handedHeader && !fromEmailTo && (
          <p className="text-xs text-ink-muted">
            {t("mail.outcome.handedBy", { name: people.get(p.handedById!)?.name ?? "" })}
          </p>
        )}
        {alsoFor.length > 0 && (
          <p className="text-xs text-ink-muted">{t("mail.proposal.alsoFor", { names: alsoFor.join(", ") })}</p>
        )}
      </header>

      {choosing ? (
        <ChooseProject
          view={view}
          chosen={chosen}
          busy={busy}
          onChoose={(projectId) => {
            setChosen(projectId);
            setError(null);
            choose.mutateAsync({ id: p.id, projectId }).catch((e) => {
              setChosen(null);
              fail(e);
            });
          }}
          onNone={doIgnore}
        />
      ) : (
        <ul className="flex min-w-0 flex-col">
          {p.actions.map((action, i) => {
            const args = effectiveArgs(action, edits[i]);
            const who = assigneeOf(action.fn, args);
            const rowEditing = editing?.index === i;
            return (
              <li key={i} data-action-row={i} className="flex min-h-10 min-w-0 flex-col justify-center gap-2 py-1">
                <div className="flex min-w-0 items-start gap-2.5 text-md text-ink">
                  {decidable && many ? (
                    <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5">
                      <input
                        type="checkbox"
                        className="peer sr-only"
                        checked={selected[i]}
                        onChange={() => setSelected((s) => s.map((on, j) => (j === i ? !on : on)))}
                      />
                      <span className="mt-[3px] rounded-[3px] outline-offset-2 peer-focus-visible:outline-2 peer-focus-visible:outline-focus">
                        <CheckBox checked={!!selected[i]} />
                      </span>
                      <Phrase action={action} args={args} who={who} ctx={ctx} isOutside={isOutside} edited={!!edits[i]} />
                    </label>
                  ) : (
                    <span tabIndex={decidable ? 0 : undefined} className="min-w-0 flex-1 rounded-sm outline-offset-2">
                      <Phrase action={action} args={args} who={who} ctx={ctx} isOutside={isOutside} edited={!!edits[i]} />
                    </span>
                  )}
                  {decidable && EDITABLE.has(action.fn) && !rowEditing && (
                    <button
                      type="button"
                      className={`${quietButton} h-7`}
                      disabled={busy}
                      aria-label={t("mail.proposal.editRow", { n: i + 1 })}
                      title={t("mail.proposal.editShortcut")}
                      onClick={() => {
                        setAsking(null);
                        setEditing({ index: i });
                      }}
                    >
                      {t("mail.proposal.edit")}
                    </button>
                  )}
                </div>
                {rowEditing && (
                  <EditRow
                    action={action}
                    args={args}
                    code={code}
                    members={members}
                    people={peopleList ?? []}
                    tasks={taskList ?? []}
                    projectId={p.projectId}
                    focus={editing.focus}
                    onDone={(edit) => {
                      setEdits((all) => ({ ...all, [i]: edit }));
                      setEditing(null);
                    }}
                    onReset={() => {
                      setEdits((all) => {
                        const next = { ...all };
                        delete next[i];
                        return next;
                      });
                      setEditing(null);
                    }}
                    onCancel={() => setEditing(null)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}

      {!choosing && (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            aria-expanded={showRead}
            onClick={() => setShowRead((v) => !v)}
            className="self-start rounded-sm text-xs font-medium text-ink-muted underline decoration-ink/30 underline-offset-2 hover:text-ink"
          >
            {showRead ? t("mail.proposal.hideRead") : t("mail.proposal.showRead")}
          </button>
          {showRead && (
            <blockquote className="max-h-[200px] overflow-y-auto border-l border-rule-strong pl-3 text-sm whitespace-pre-line text-ink-muted">
              {p.excerpt}
            </blockquote>
          )}
        </div>
      )}

      {handable && <p className="text-sm text-ink-muted">{t("mail.proposal.cantConfirm", { ability, code })}</p>}

      {asking && (
        <OutsiderPrompt
          outsiders={asking}
          code={code}
          canAdd={can(viewer, "project.members.manage", p.projectId)}
          busy={busy}
          onAdd={() => run({ add: asking.map((o) => o.personId) })}
          onChoose={chooseSomeoneElse}
          onLeave={leaveUnassigned}
        />
      )}

      {!choosing && !asking && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button type="button" className={secondaryButton} disabled={busy} onClick={doIgnore}>
            {t("mail.proposal.ignore")}
          </button>
          {decidable ? (
            <button
              type="button"
              className={primaryButton}
              disabled={busy || indexes.length === 0}
              onClick={doConfirm}
              aria-keyshortcuts="Meta+Enter"
            >
              {indexes.length === p.actions.length || !many
                ? t("mail.proposal.confirm")
                : t("mail.proposal.confirmSome", { n: indexes.length, count: p.actions.length })}
            </button>
          ) : (
            <button type="button" className={primaryButton} disabled={busy} onClick={doHand} aria-keyshortcuts="Meta+Enter">
              {t("mail.proposal.hand")}
            </button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-critical">
          {error}
        </p>
      )}
    </section>
  );
}

/** La frase di una riga, con l'incaricato e il segno «not in MKX» (A12) e «Edited». */
function Phrase({
  action,
  args,
  who,
  ctx,
  isOutside,
  edited,
}: {
  action: ProposedAction;
  args: Args;
  who: string | null | undefined;
  ctx: Ctx;
  isOutside: (personId: string) => boolean;
  edited: boolean;
}) {
  const { t } = ctx;
  const showWho = action.fn === "createTask" || (action.fn === "updateTask" && who !== undefined);
  return (
    <span className="min-w-0 [overflow-wrap:anywhere]">
      {phraseOf(action, args, ctx)}
      {showWho && (
        <>
          {" · "}
          {who ? (
            <>
              {ctx.people.get(who)?.name ?? who}
              {isOutside(who) && (
                <span className="ml-1.5 inline-flex items-center gap-1 align-baseline text-xs text-ink-muted">
                  <PersonPlusGlyph />
                  {t("mail.proposal.notIn", { code: ctx.code })}
                </span>
              )}
            </>
          ) : (
            <span className="text-ink-muted">{t("mail.proposal.unassigned")}</span>
          )}
        </>
      )}
      {action.fn === "createTask" && typeof args.dueDate === "string" && args.dueDate && (
        <>
          {" · "}
          {t("mail.due.futureLong", { date: dayLabel(args.dueDate, ctx.language) })}
        </>
      )}
      {edited && <span className="ml-1.5 text-xs text-ink-muted">{t("mail.proposal.edited")}</span>}
    </span>
  );
}

/** La riga aperta in un piccolo modulo dentro la scheda (A13). */
function EditRow({
  action,
  args,
  code,
  members,
  people,
  tasks,
  projectId,
  focus,
  onDone,
  onReset,
  onCancel,
}: {
  action: ProposedAction;
  args: Args;
  code: string;
  members: ReadonlySet<string>;
  people: readonly Person[];
  tasks: readonly Task[];
  projectId: string;
  focus?: "assignee" | undefined;
  onDone: (edit: Args) => void;
  onReset: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState<Args>(() =>
    action.fn === "updateTask" ? { ...((args.patch as Args) ?? {}) } : { ...args },
  );
  const first = useRef<HTMLElement | null>(null);
  const assignee = useRef<HTMLSelectElement | null>(null);
  useEffect(() => {
    (focus === "assignee" ? assignee.current : first.current)?.focus();
  }, [focus]);
  const set = (key: string) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));
  const id = useId();
  const field = (key: string, label: string, control: ReactNode) => (
    <label key={key} htmlFor={`${id}-${key}`} className="flex flex-col gap-1 text-xs font-medium text-ink-muted">
      {label}
      {control}
    </label>
  );
  const text = (key: string, label: string, multiline = false) =>
    field(
      key,
      label,
      multiline ? (
        <textarea
          id={`${id}-${key}`}
          ref={(el) => {
            if (!first.current) first.current = el;
          }}
          rows={3}
          value={(values[key] as string | undefined) ?? ""}
          onChange={set(key)}
          className={`${inputClass} h-auto py-1.5`}
        />
      ) : (
        <input
          id={`${id}-${key}`}
          ref={(el) => {
            if (!first.current) first.current = el;
          }}
          value={(values[key] as string | undefined) ?? ""}
          onChange={set(key)}
          className={inputClass}
        />
      ),
    );
  const date = (key: string, label: string) =>
    field(
      key,
      label,
      <input
        id={`${id}-${key}`}
        type="date"
        value={((values[key] as string | null | undefined) ?? "").slice(0, 10)}
        onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value || null }))}
        className={inputClass}
      />,
    );
  const inProject = people.filter((x) => members.has(x.id) && !x.isClaude);
  const outside = people.filter((x) => !members.has(x.id) && !x.isClaude);
  const assigneeField = () =>
    field(
      "assigneeId",
      t("mail.proposal.fields.assignee"),
      <select
        id={`${id}-assigneeId`}
        ref={assignee}
        value={(values.assigneeId as string | null | undefined) ?? ""}
        onChange={(e) => setValues((v) => ({ ...v, assigneeId: e.target.value || null }))}
        className={inputClass}
      >
        <option value="">{t("mail.proposal.unassigned")}</option>
        <optgroup label={t("mail.proposal.fields.inProject", { code })}>
          {inProject.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </optgroup>
        <optgroup label={t("mail.proposal.fields.outsideProject", { code })}>
          {outside.map((x) => (
            <option key={x.id} value={x.id}>
              {`${x.name} · ${t("mail.proposal.notIn", { code })}`}
            </option>
          ))}
        </optgroup>
      </select>,
    );

  let fields: ReactNode[] = [];
  switch (action.fn) {
    case "createTask":
      fields = [
        text("title", t("mail.proposal.fields.title")),
        text("description", t("mail.proposal.fields.description"), true),
        assigneeField(),
        date("dueDate", t("mail.proposal.fields.dueDate")),
      ];
      break;
    case "createRequest":
      fields = [text("title", t("mail.proposal.fields.title")), text("description", t("mail.proposal.fields.description"), true)];
      break;
    case "updateTask":
      fields = [
        field(
          "task",
          t("mail.proposal.fields.task"),
          <select id={`${id}-task`} disabled value={args.id as string} className={inputClass}>
            {tasks
              .filter((x) => x.projectId === projectId)
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {`${x.code} ${x.title}`}
                </option>
              ))}
          </select>,
        ),
        ...("dueDate" in values ? [date("dueDate", t("mail.proposal.fields.dueDate"))] : []),
        ...("assigneeId" in values ? [assigneeField()] : []),
      ];
      break;
    case "addComment":
      fields = [text("body", t("mail.proposal.fields.comment"), true)];
      break;
    case "createMilestone":
      fields = [text("name", t("mail.proposal.fields.name")), date("dueDate", t("mail.proposal.fields.date"))];
      break;
  }

  const done = () => {
    const keys = Object.keys(values).filter((k) => !["projectId", "id", "taskId", "source"].includes(k));
    if (action.fn === "updateTask") onDone({ patch: values });
    else onDone(Object.fromEntries(keys.map((k) => [k, values[k]])));
  };

  return (
    <div
      className="flex flex-col gap-2.5 rounded-md bg-ink/4 p-3"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      {fields}
      <div className="flex items-center justify-end gap-2">
        <button type="button" className={quietButton} onClick={onReset}>
          {t("mail.proposal.reset")}
        </button>
        <button type="button" className={secondaryButton} onClick={done}>
          {t("mail.proposal.done")}
        </button>
      </div>
    </div>
  );
}

/** «Which project is this about?»: una riga per candidato, «None of these» = Ignora. */
function ChooseProject({
  view,
  chosen,
  busy,
  onChoose,
  onNone,
}: {
  view: MailProposalView;
  chosen: string | null;
  busy: boolean;
  onChoose: (projectId: string) => void;
  onNone: () => void;
}) {
  const { t } = useTranslation();
  const projects = useProjects().data;
  const action = view.proposal.actions.find((a) => a.fn === "chooseProject")!;
  const ids = (action.args.projectIds as string[] | undefined) ?? [];
  const row =
    "flex min-h-10 w-full items-center gap-2 rounded-md border border-rule px-3 text-left text-md text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 disabled:opacity-40";
  if (chosen) {
    const p = projects?.find((x) => x.id === chosen);
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-ink-muted">
        <WorkingRing size={10} />
        {t("mail.proposal.analysingFor", { code: p?.code ?? "" })}
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {ids.map((id) => {
        const p = projects?.find((x) => x.id === id);
        if (!p) return null;
        return (
          <li key={id}>
            <button type="button" className={row} disabled={busy} onClick={() => onChoose(id)}>
              <span className="num w-9 shrink-0 text-xs font-semibold tracking-[0.02em]">{p.code}</span>
              <span className="min-w-0 truncate">{p.name}</span>
            </button>
          </li>
        );
      })}
      <li>
        <button type="button" className={`${row} text-ink-muted`} disabled={busy} onClick={onNone}>
          {t("mail.proposal.none")}
        </button>
      </li>
    </ul>
  );
}

/** I codici nati, apribili se li vedo (con il nome), altrimenti solo il codice in `ink-faint` (R-E9). */
function Codes({ codes }: { codes: readonly string[] }) {
  const visible = useCodeCitations(codes).data;
  return (
    <>
      {codes.map((code, i) => {
        const seen = visible?.find((c) => c.code === code && c.visible);
        return (
          <span key={code}>
            {" · "}
            {seen ? (
              <a
                href={routeOfCode(code)}
                className="rounded-sm underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
              >
                <span className="num font-semibold text-ink">{code}</span>
                {seen.name && <span className="text-ink"> {seen.name}</span>}
              </a>
            ) : (
              <span className="num font-semibold text-ink-faint">{code}</span>
            )}
            {i < codes.length - 1 ? "" : null}
          </span>
        );
      })}
    </>
  );
}

/** La riga d'esito: chi ha deciso, quando, cosa è nato (o perché non è riuscita). */
function Outcome({
  view,
  code,
  ability,
  me,
  added,
}: {
  view: MailProposalView;
  code: string;
  ability: string;
  me: string;
  added: readonly string[];
}) {
  const { t, i18n } = useTranslation();
  const p = view.proposal;
  const mine = view.decidedBy?.personId === me;
  const name = view.decidedBy?.name ?? "";
  const when = p.decidedAt ? ` · ${whenWithTime(p.decidedAt, i18n.language)}` : "";
  switch (p.status) {
    case "confirmed":
      return (
        <p role="status" className="text-sm text-ink [overflow-wrap:anywhere]">
          <span className="font-semibold">
            {mine ? t("mail.outcome.confirmedByYou") : t("mail.outcome.confirmedBy", { name })}
          </span>
          <span className="num text-ink-muted">{when}</span>
          <Codes codes={p.resultCodes} />
          {p.confirmedActions && (
            <span className="text-ink-muted">
              {" · "}
              {t("mail.outcome.partial", { n: p.confirmedActions.length, count: p.actions.length })}
            </span>
          )}
          {added.map((who) => (
            <span key={who} className="text-ink-muted">
              {" · "}
              {t("mail.outcome.added", { name: who, code })}
            </span>
          ))}
        </p>
      );
    case "ignored":
      return (
        <p role="status" className="text-sm text-ink-muted">
          {mine ? t("mail.outcome.ignoredByYou") : t("mail.outcome.ignoredBy", { name })}
          <span className="num">{when}</span>
        </p>
      );
    case "handed":
      return (
        <p role="status" className="text-sm text-ink-muted">
          {mine ? t("mail.outcome.handedByYou") : t("mail.outcome.handedBy", { name })}
          <span className="num">{when}</span>
          {" · "}
          {t("mail.outcome.waitingFor", { ability, code })}
        </p>
      );
    case "failed":
      return (
        <p role="status" className="flex items-start gap-1.5 text-sm text-critical">
          <span className="mt-0.5">
            <AlertGlyph size={14} />
          </span>
          {t("mail.outcome.failed", { reason: t(`mail.outcome.reasons.${reasonKey(p.error)}`, { ability, code }) })}
        </p>
      );
    default:
      return null;
  }
}
