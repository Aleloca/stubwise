import { useMemo, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { WhoCanLink } from "../../../components/WhoCanLink";
import { useAutomations, useCodeCitations, usePeople, useProjects } from "../../../data/queries";
import type { CitationView, ProposedAction, UndoView } from "../../../data/types";
import { spoken } from "../../../domain/claude/answers";
import { shortWeekIn, weekNumberOf } from "../../../domain/weeks";
import { HiddenCode } from "./citations";
import type { Ev } from "./flow";
import { CheckGlyph, CrossGlyph } from "./parts";
import { busyWords, routeOfObject, UndoControl } from "./UndoControl";

// La riga di ciò che Claude ha fatto (area 10a, Task 9; shape
// `claude-actions.md`): una riga di risultato, non una scheda [CA 1]. Segno,
// verbo al passato, codice (link solo se chi legge lo apre: altrimenti
// tenue e senza nome, R-E9 [CA 2]), nome e dettagli dopo «·», e a destra
// «Undo» del gruppo — uno solo, sotto l'ultima riga [CA 3]. Un'azione che
// all'invio è stata rifiutata è «Didn't run», con «Who?» se manca un
// permesso, e senza Undo. La riga legge il dato, non lo ricalcola.

/** Le azioni il cui oggetto è un progetto (o sta nel progetto): al maschile in italiano. */
const MASCULINE: ReadonlySet<ProposedAction["fn"]> = new Set([
  "archiveProject",
  "reopenProject",
  "setSubscription",
  "saveProjectAutomations",
  "updateProjectGeneral",
  "setProjectAi",
  "addMember",
  "removeMember",
  "setMemberRole",
  "createMilestone",
  "deleteMilestone",
  // Il filtro salvato (area 10b): «Annullato».
  "saveFilter",
]);

export const isMasculineGroup = (actions: readonly Pick<ProposedAction, "fn">[]) =>
  actions.every((a) => MASCULINE.has(a.fn));

/** Il codice dell'oggetto di ogni azione: quello registrato, o il solo nato da un'azione sola. */
export function objectCodesOf(event: {
  actions: readonly ProposedAction[];
  objectCodes?: (string | null)[];
  resultCodes?: string[];
}): (string | null)[] {
  return event.actions.map(
    (_, i) =>
      event.objectCodes?.[i] ??
      (event.actions.length === 1 ? (event.resultCodes?.[0] ?? null) : null),
  );
}

interface Lookup {
  /** Task e richieste che chi legge apre (codice → vista). */
  objects: ReadonlyMap<string, CitationView>;
  /** I progetti che chi legge vede, per codice. */
  projects: ReadonlySet<string>;
  /** I nomi delle persone che chi legge vede. */
  people: ReadonlyMap<string, string>;
  viewerId: string;
}

/** Le letture di una riga: i codici citati e le persone, come le vede chi legge. */
export function useObjectLookup(codes: readonly (string | null)[], viewerId: string): Lookup {
  const coded = useMemo(
    () => [...new Set(codes.filter((c): c is string => !!c && c.includes("-")))],
    [codes],
  );
  const views = useCodeCitations(coded).data;
  const projects = useProjects().data;
  const people = usePeople().data;
  return useMemo(
    () => ({
      objects: new Map((views ?? []).map((v) => [v.code ?? "", v])),
      projects: new Set((projects ?? []).map((p) => p.code)),
      people: new Map((people ?? []).map((p) => [p.id, p.name])),
      viewerId,
    }),
    [views, projects, people, viewerId],
  );
}

/** Il codice dell'oggetto: un link se chi legge lo apre, altrimenti tenue e non un link. */
function ObjectCode({ code, lookup }: { code: string; lookup: Lookup }) {
  const open = code.includes("-") ? !!lookup.objects.get(code)?.route : lookup.projects.has(code);
  if (!open) return <HiddenCode code={code} />;
  return (
    <a
      href={code.includes("-") ? lookup.objects.get(code)!.route! : routeOfObject(code)}
      className="num font-semibold text-ink underline decoration-ink/25 underline-offset-2 hover:decoration-ink/70"
    >
      {code}
    </a>
  );
}

/**
 * L'automazione creata da Claude: il codice apre il costruttore se chi legge
 * la vede (nome e stato solo allora, R-G5), e «draft, off» finché è ancora
 * una bozza mai accesa — la riga non afferma ciò che il dato non dice più.
 */
function CreatedAutomation({ code }: { code: string }) {
  const { t } = useTranslation();
  const row = useAutomations().data?.find((a) => a.code === code);
  return (
    <>
      <Trans
        i18nKey="claude.conversation.executed.verb.createAutomation"
        components={{
          obj: row ? (
            <a
              href={`#/automations/${code}/edit`}
              className="num font-semibold text-ink underline decoration-ink/25 underline-offset-2 hover:decoration-ink/70"
            >
              {code}
            </a>
          ) : (
            <HiddenCode code={code} />
          ),
        }}
      />
      {row && <> {t("claude.conversation.executed.named", { name: row.name })}</>}
      {row?.status === "draft" && (
        <span className="text-ink-muted">
          {" · "}
          {t("claude.conversation.executed.draftOff")}
        </span>
      )}
    </>
  );
}

/** La frase di un'azione eseguita: verbo al passato e oggetto, poi nome e dettagli. */
function ActionPhrase({
  action,
  code,
  lookup,
  mine,
}: {
  action: ProposedAction;
  code: string | null;
  lookup: Lookup;
  /** Chi legge è chi l'ha chiesta (non un lettore di una pubblica altrui). */
  mine: boolean;
}) {
  const { t } = useTranslation();
  const args = action.args;
  const view = code ? lookup.objects.get(code) : undefined;
  const person = (id: unknown) => (typeof id === "string" ? lookup.people.get(id) : undefined);
  const week = (w: unknown) => {
    return typeof w === "string" && weekNumberOf(w) !== null ? shortWeekIn(t, w) : null;
  };
  const verb = (key: string, values: Record<string, unknown> = {}): ReactNode => (
    <Trans
      i18nKey={`claude.conversation.executed.verb.${key}`}
      values={values}
      components={{ obj: code ? <ObjectCode code={code} lookup={lookup} /> : <span /> }}
    />
  );
  const generic = () => (
    <>
      {t("claude.conversation.executed.generic", {
        summary: spoken(t, action.summaryText, action.summary),
      })}
    </>
  );

  let head: ReactNode = null;
  const details: string[] = [];
  let named = false;
  switch (action.fn) {
    case "createTask": {
      if (!code) return generic();
      head = verb("createTask");
      named = true;
      // I dettagli solo se chi legge vede la task (R-G5).
      if (view) {
        if (args.assigneeId === lookup.viewerId)
          details.push(t("claude.conversation.executed.assignedToYou"));
        else if (person(args.assigneeId))
          details.push(
            t("claude.conversation.executed.assignedTo", { name: person(args.assigneeId) }),
          );
        const w = week(args.plannedWeek);
        if (w) details.push(w);
      }
      break;
    }
    case "updateTask": {
      const patch = (args.patch ?? {}) as Record<string, unknown>;
      const name = person(patch.assigneeId);
      if (!code || Object.keys(patch).length !== 1 || !name) return generic();
      head = verb("assign", { name });
      break;
    }
    case "planTask": {
      const plan = (args.plan ?? {}) as Record<string, unknown>;
      const w = week(plan.week);
      if (!code || !w) return generic();
      head = verb("planTask", { week: w });
      const name = person(plan.assigneeId);
      if (name && view) details.push(name);
      break;
    }
    case "addMember":
    case "removeMember":
    case "setMemberRole": {
      const name = person(args.personId);
      if (!code || !name) return generic();
      head = verb(action.fn, { name });
      break;
    }
    // Il filtro salvato personale (area 10b, Task 9): il nome, e che lo vede solo chi l'ha chiesto.
    case "saveFilter": {
      if (typeof args.name !== "string") return generic();
      head = t("claude.conversation.page.savedFilter", { name: args.name });
      // «lo vedi solo tu» è vero solo per chi l'ha chiesto: agli altri, «privato».
      details.push(
        t(mine ? "claude.conversation.page.onlyYou" : "claude.conversation.page.private"),
      );
      break;
    }
    // S1 (area 10b, shape `claude-automations.md` §3.2): «Created ACQ-A4 “…” ·
    // draft, off». La riga che rassicura: Claude non accende niente.
    case "createAutomation":
      if (!code) return generic();
      return <CreatedAutomation code={code} />;
    case "deleteTask":
    case "addComment":
    case "startRun":
    case "archiveProject":
    case "reopenProject":
    case "setSubscription":
    case "saveProjectAutomations":
      if (!code) return generic();
      head = verb(action.fn);
      break;
    default:
      return generic();
  }
  return (
    <>
      {head}
      {named && view?.name && <> {t("claude.conversation.executed.named", { name: view.name })}</>}
      {details.map((d) => (
        <span key={d} className="text-ink-muted">
          {" · "}
          {d}
        </span>
      ))}
    </>
  );
}

export function ExecutedRow({
  conversationId,
  event,
  undo,
  viewerId,
  ownerId,
  viewerName,
}: {
  conversationId: string;
  event: Ev<"executed">;
  undo: UndoView | undefined;
  viewerId: string;
  /** Chi ha aperto la conversazione: «lo vedi solo tu» è vero solo per lui (M4). */
  ownerId: string;
  viewerName: string;
}) {
  const codes = useMemo(() => objectCodesOf(event), [event]);
  const lookup = useObjectLookup(codes, viewerId);

  if (event.status === "failed") return <DidntRun event={event} />;

  return (
    <div
      className={`event-enter flex min-w-0 gap-x-3 gap-y-1 ${event.actions.length > 1 ? "flex-col items-end" : "flex-wrap items-start"}`}
      data-executed={event.groupId}
    >
      <ul
        className={`flex min-w-0 flex-col gap-1 ${event.actions.length > 1 ? "self-stretch" : "flex-[1_1_16rem]"}`}
        aria-live="polite"
      >
        {event.actions.map((action, i) => (
          <li
            key={i}
            data-executed-action={action.fn}
            className="flex min-h-8 min-w-0 items-start gap-2 py-1 text-md text-ink [overflow-wrap:anywhere]"
          >
            <span className="mt-[3px]" aria-hidden="true">
              <CheckGlyph />
            </span>
            <span className="min-w-0">
              <ActionPhrase
                action={action}
                code={codes[i] ?? null}
                lookup={lookup}
                mine={viewerId === ownerId}
              />
            </span>
          </li>
        ))}
      </ul>
      <UndoControl
        conversationId={conversationId}
        groupId={event.groupId}
        view={undo}
        count={event.actions.length}
        masculine={isMasculineGroup(event.actions)}
        code={codes[0] ?? null}
        viewerName={viewerName}
      />
    </div>
  );
}

/** «Didn't run: <motivo>», col verbo al presente sotto; nessun Undo (non è cambiato niente). */
function DidntRun({ event }: { event: Ev<"executed"> }) {
  const { t } = useTranslation();
  const failure = event.failure;
  const action = event.actions[failure?.index ?? 0];
  const reason = ((): ReactNode => {
    if (!failure) return event.errorText ? t(event.errorText.key, event.errorText.params) : null;
    const actionWords = failure.whoAction ? t(`whoCan.actions.${failure.whoAction}`) : null;
    switch (failure.code) {
      case "forbidden":
        if (!actionWords) break;
        return (
          <>
            {failure.projectCode
              ? t("claude.conversation.executed.reason.forbidden", {
                  action: actionWords,
                  code: failure.projectCode,
                })
              : t("claude.conversation.executed.reason.forbiddenNoProject", {
                  action: actionWords,
                })}
            {" · "}
            <WhoCanLink
              action={failure.whoAction!}
              projectId={failure.projectId}
              projectCode={failure.projectCode}
            />
          </>
        );
      case "busy":
        if (!failure.reasons?.length) break;
        return t("claude.conversation.executed.reason.busy", {
          reasons: busyWords(t, failure.reasons, null),
        });
      case "invalid":
        return t("claude.conversation.executed.reason.invalid");
      default:
        break;
    }
    return event.errorText ? t(event.errorText.key, event.errorText.params) : null;
  })();
  return (
    <div
      className="event-enter flex min-w-0 flex-col gap-0.5"
      data-executed={event.groupId}
      data-executed-failed
    >
      <p className="flex min-w-0 items-start gap-2 text-md text-ink [overflow-wrap:anywhere]">
        <span className="mt-[3px] text-critical" aria-hidden="true">
          <CrossGlyph />
        </span>
        <span className="min-w-0">
          <span className="text-critical">{t("claude.conversation.executed.didntRunLead")}</span>{" "}
          {reason}
        </span>
      </p>
      {action && (
        <p className="pl-6 text-sm text-ink-muted [overflow-wrap:anywhere]">
          {spoken(t, action.summaryText, action.summary)}
        </p>
      )}
    </div>
  );
}
