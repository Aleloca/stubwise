import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  useChooseMailProject,
  useConfirmMailProposal,
  useDecideMailProposalNow,
  useHandMailProposal,
  useIgnoreMailProposal,
  usePeople,
  useProjects,
  useReassignMailProposal,
  useSessionPersonId,
  useTasks,
} from "../../data/queries";
import type { MailProposalView, Project, ProposedAction } from "../../data/types";
import { can, useViewer } from "../../data/viewer";
import { hasModKey } from "../../platform/platform";
import { CheckBox, MenuGroup, itemClass } from "../../tasks-ui/Menu";
import {
  cardClass,
  primaryButton,
  quietButton,
  secondaryButton,
  useFocusWhenResolved,
} from "../claude/conversation/parts";
import { MenuButton } from "../tasks/controls";
import { ChooseProject } from "./ChooseProject";
import { EditRow } from "./EditRow";
import { dayLabel } from "./format";
import { MoreGlyph, PersonPlusGlyph } from "./glyphs";
import { Outcome } from "./Outcome";
import { OutsiderPrompt } from "./OutsiderPrompt";
import {
  ABILITY,
  EDITABLE,
  PORTABLE,
  assigneeOf,
  effectiveArgs,
  isLiveProposal,
  phraseOf,
  type Args,
  type Ctx,
  type Edits,
} from "./proposalText";

// Una proposta nata da un'email (shape mail.md §4): la stessa scheda nella
// Posta (sotto il messaggio d'origine) e in «Da decidere». Parla la lingua
// della `ProposalCardView` di Claude — contorno `rule-strong`, righe
// catalogo, l'esito al posto dei bottoni — con le differenze della posta: è
// CONDIVISA (chi decide per primo chiude per tutti, gli altri vedono chi),
// si MODIFICA sul posto (A13), ha «Passa al progetto» per chi non può
// confermare (A14) e il passo per l'incaricato fuori dal progetto (A15).
// I permessi e la condivisione li dice il livello dati (`canConfirm`,
// `canHand`, `outsiders`, `decidedBy`, `sharedWith`): la scheda non li
// deduce. L'unica eccezione è un incaricato CAMBIATO nella modifica sul
// posto: il livello dati non lo conosce finché non si conferma, quindi lì la
// scheda guarda i membri del progetto (e la conferma lo ricontrolla comunque).

/** Le decisioni che «Da decidere» tiene nella finestra dell'«Undo». */
export type MailDecisionKind = "confirm" | "ignore" | "hand";

export function MailProposalCard({
  view,
  excerptOpen = false,
  fromEmailTo,
  onDecide,
  collapsed = false,
}: {
  view: MailProposalView;
  /** L'estratto aperto di default: in «Da decidere» e per chi non ha l'email. */
  excerptOpen?: boolean;
  /** Proposta passata vista da chi non ha l'email: a chi era l'email (chi l'ha passata). */
  fromEmailTo?: string | null;
  /**
   * In «Da decidere»: conferma, «Ignora» e «Passa» non partono qui ma passano
   * a chi ospita la scheda, che le tiene nella finestra dell'«Undo» (shape
   * home.md §8 [A 2]). `send` fa partire la chiamata in modo sincrono.
   */
  onDecide?: (kind: MailDecisionKind, send: () => Promise<unknown>) => void;
  /**
   * Densità di blocco («Da decidere», shape home.md §8): la prima azione per
   * intero, le altre dietro «+N more», che espande sul posto.
   */
  collapsed?: boolean;
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
  const decideNow = useDecideMailProposalNow();

  const project = projects?.find((x) => x.id === p.projectId);
  const code = project?.code ?? "";
  const people = useMemo(() => new Map((peopleList ?? []).map((x) => [x.id, x])), [peopleList]);
  const tasks = useMemo(() => new Map((taskList ?? []).map((x) => [x.id, x])), [taskList]);
  const ctx: Ctx = { t, language: i18n.language, code, people, tasks };

  const [selected, setSelected] = useState<boolean[]>(() => p.actions.map(() => true));
  const [edits, setEdits] = useState<Edits>({});
  const [editing, setEditing] = useState<{ index: number; focus?: "assignee" } | null>(null);
  const [showRead, setShowRead] = useState(excerptOpen);
  const [allActions, setAllActions] = useState(!collapsed);
  const hiddenActions = allActions ? 0 : p.actions.length - 1;
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
  // Aspetta me = posso decidere, passarla o sceglierne il progetto.
  const live = isLiveProposal(view);
  const resolvedRef = useFocusWhenResolved<HTMLElement>(!live);
  const busy = confirm.isPending || ignore.isPending || hand.isPending || choose.isPending || reassign.isPending;
  const many = p.actions.length > 1;
  const indexes = selected.flatMap((on, i) => (on ? [i] : []));
  const waitsOnMe = live;
  // Che cosa serve per decidere, da tutte le azioni: «create tasks and comment on tasks».
  const abilities = [...new Set(p.actions.flatMap((a) => (ABILITY[a.fn] ? [ABILITY[a.fn]!] : [])))].map(
    (key) => t(`mail.proposal.ability.${key}`),
  );
  const ability =
    abilities.length <= 1
      ? (abilities[0] ?? t("mail.proposal.ability.createTasks"))
      : `${abilities.slice(0, -1).join(", ")} ${t("mail.outsider.and")} ${abilities.at(-1)}`;
  const members = useMemo(() => new Set(project?.memberIds ?? []), [project]);
  const outsiderIds = new Set(view.outsiders.map((o) => o.personId));
  /**
   * Fuori dal progetto: per l'incaricato del modello lo dice il livello dati
   * (`outsiders`); solo per uno scelto nella modifica sul posto si guardano
   * i membri del progetto.
   */
  const isOutside = (index: number, personId: string) => {
    const action = p.actions[index]!;
    const original = assigneeOf(action.fn, action.args);
    return personId === original ? outsiderIds.has(personId) : !members.has(personId);
  };

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
      if (typeof who === "string" && isOutside(i, who)) ids.add(who);
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
    const input = {
      ...(all ? {} : { actionIndexes: indexes }),
      ...(Object.keys(payload).length ? { edits: payload } : {}),
      ...(opts.add?.length ? { addOutsiders: opts.add } : {}),
    };
    if (onDecide) {
      setAsking(null);
      onDecide("confirm", () => decideNow.confirm(p.id, input));
      return;
    }
    confirm
      .mutateAsync({ id: p.id, ...input })
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
    if (index !== undefined) {
      // La riga da cambiare può essere fra quelle raccolte dietro «+N more».
      setAllActions(true);
      setEditing({ index, focus: "assignee" });
    }
  };
  const doIgnore = () => {
    setError(null);
    if (onDecide) onDecide("ignore", () => decideNow.ignore(p.id));
    else ignore.mutateAsync(p.id).catch(fail);
  };
  const doHand = () => {
    setError(null);
    if (onDecide) onDecide("hand", () => decideNow.hand(p.id));
    else hand.mutateAsync(p.id).catch(fail);
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
          {!choosing && (p.excerpt !== "" || canMove) && (
            <MenuButton
              menuLabel={t("mail.proposal.menu")}
              ariaLabel={t("mail.proposal.menu")}
              align="right"
              className="grid size-7 shrink-0 place-items-center rounded-md text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink aria-expanded:bg-ink/10"
              label={<MoreGlyph />}
            >
              {(close) => (
                <>
                  {p.excerpt !== "" && (
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
                  )}
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
          <p className="text-xs text-ink-muted">
            {p.source === "transcript"
              ? t("mail.proposal.fromMeeting")
              : t("mail.proposal.fromEmailTo", { name: fromEmailTo })}
          </p>
        )}
        {handedHeader && !fromEmailTo && (
          <p className="text-xs text-ink-muted">
            {t("mail.outcome.handedBy", { name: people.get(p.handedById!)?.name ?? "" })}
          </p>
        )}
        {view.sharedWith.length > 0 && (
          <p className="text-xs text-ink-muted">
            {t("mail.proposal.alsoFor", { names: view.sharedWith.map((x) => x.name).join(", ") })}
          </p>
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
            // Raccolta: la prima azione per intero, le altre dietro «+N more».
            if (!allActions && i > 0) return null;
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
                      <Phrase action={action} args={args} who={who} ctx={ctx} isOutside={(who) => isOutside(i, who)} edited={!!edits[i]} />
                    </label>
                  ) : (
                    <span tabIndex={decidable ? 0 : undefined} className="min-w-0 flex-1 rounded-sm outline-offset-2">
                      <Phrase action={action} args={args} who={who} ctx={ctx} isOutside={(who) => isOutside(i, who)} edited={!!edits[i]} />
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
          {hiddenActions > 0 && (
            <li className="flex min-h-8 items-center">
              <button
                type="button"
                aria-expanded={false}
                className="rounded-sm text-sm font-medium text-ink-muted underline decoration-ink/30 underline-offset-2 hover:text-ink"
                onClick={() => setAllActions(true)}
              >
                {t("mail.proposal.moreActions", { count: hiddenActions })}
              </button>
            </li>
          )}
        </ul>
      )}

      {!choosing && p.excerpt !== "" && (
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
