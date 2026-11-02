import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  useCancelProposal,
  useCompleteEditedProposal,
  useConfirmProposal,
  useEditProposal,
  usePeople,
  useProjects,
} from "../../../data/queries";
import type { ClassReason, NewTaskInput, ProposedAction, UndoView } from "../../../data/types";
import { spoken } from "../../../domain/claude/answers";
import { useReauth } from "../../../layout/useReauth";
import { CheckBox } from "../../../tasks-ui/Menu";
import { NewRequestDialog } from "../../requests/NewRequestDialog";
import { NewTaskDialog } from "../../task/NewTaskDialog";
import { WhoCanLink } from "../../../components/WhoCanLink";
import { dangerSolidButton } from "../../tasks/controls";
import { isMasculineGroup, objectCodesOf } from "./ExecutedRow";
import type { Ev } from "./flow";
import { WaitingDot } from "./QuestionCard";
import {
  AutomationGlyph,
  BellGlyph,
  cardClass,
  IrreversibleGlyph,
  LockGlyph,
  primaryButton,
  quietButton,
  secondaryButton,
  useFocusWhenResolved,
  usePersonName,
} from "./parts";
import { UndoControl } from "./UndoControl";

/** Le azioni che si possono rifare dal loro dialogo, precompilato («Edit»). */
const EDITABLE: ReadonlySet<ProposedAction["fn"]> = new Set(["createTask", "createRequest"]);

/** Dove si apre un codice nato da una proposta (task o richiesta). */
export function routeOfCode(code: string): string {
  const project = code.split("-")[0];
  return /-R\d+$/.test(code) ? `#/p/${project}/requests` : `#/p/${project}/tasks?task=${code}`;
}

function ResultCodes({
  codes,
  renderCode,
}: {
  codes: readonly string[];
  renderCode?: ((code: string) => ReactNode) | undefined;
}) {
  return (
    <>
      {codes.map((code, i) => (
        <span key={code}>
          {renderCode ? (
            renderCode(code)
          ) : (
            <a
              href={routeOfCode(code)}
              className="num font-semibold text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
            >
              {code}
            </a>
          )}
          {i < codes.length - 1 && ", "}
        </span>
      ))}
    </>
  );
}

type EditState = { fn: ProposedAction["fn"]; args: Record<string, unknown> } | null;

/**
 * Le operazioni di una proposta, ovunque stia: la conversazione le fa per
 * id della conversazione, la Chat per id del messaggio (R-G1). Ognuna
 * fallisce con l'errore del livello dati.
 */
export interface ProposalOps {
  confirm: (actionIndexes: number[] | undefined) => Promise<unknown>;
  cancel: () => Promise<unknown>;
  edit: () => Promise<NonNullable<EditState>>;
  complete: (code: string) => Promise<unknown>;
  busy: boolean;
}

/**
 * Una modifica che Claude propone nella conversazione (vedi
 * `ProposalCardView`): le operazioni per id della conversazione.
 */
export function ProposalCard({
  conversationId,
  event,
  viewerId,
  undo,
}: {
  conversationId: string;
  event: Ev<"proposal">;
  viewerId: string;
  /** Area 10a: lo stato di «Annulla» del gruppo confermato, per chi guarda. */
  undo?: UndoView | undefined;
}) {
  const { t } = useTranslation();
  const confirm = useConfirmProposal();
  const cancel = useCancelProposal();
  const edit = useEditProposal();
  const complete = useCompleteEditedProposal();
  const reauth = useReauth();
  const viewerName = usePersonName(viewerId);
  const target = { id: conversationId, proposalId: event.proposalId };
  // La frase del dialogo della riconferma: il riassunto della scheda (C).
  const reauthAction = (indexes: number[] | undefined) => {
    const chosen = indexes ? indexes.map((i) => event.actions[i]!) : event.actions;
    if (chosen.length !== 1)
      return t("claude.conversation.proposal.reauthMany", { count: chosen.length });
    const text = spoken(t, chosen[0]!.summaryText, chosen[0]!.summary);
    // «Add Laura…» → «To add Laura…»; un codice in testa («MKX …») resta com'è.
    return /^[A-Z][a-z]/.test(text) ? text[0]!.toLowerCase() + text.slice(1) : text;
  };
  const confirmedCount = event.confirmedActions?.length ?? event.actions.length;
  const codes = objectCodesOf(event);
  return (
    <ProposalCardView
      event={event}
      viewerId={viewerId}
      after={
        event.status === "confirmed" && event.groupId ? (
          <UndoControl
            conversationId={conversationId}
            groupId={event.groupId}
            view={undo}
            count={confirmedCount}
            masculine={isMasculineGroup(event.actions)}
            code={codes.find((c) => c !== null) ?? null}
            viewerName={viewerName}
          />
        ) : null
      }
      ops={{
        // Una C passa dalla riconferma: col codice giusto la conferma riparte da sola.
        confirm: (actionIndexes) =>
          reauth(
            () => confirm.mutateAsync({ ...target, ...(actionIndexes ? { actionIndexes } : {}) }),
            { action: reauthAction(actionIndexes) },
          ),
        cancel: () => cancel.mutateAsync(target),
        edit: () => edit.mutateAsync(target),
        complete: (code) => complete.mutateAsync({ ...target, resultCodes: [code] }),
        busy: confirm.isPending || cancel.isPending || edit.isPending || complete.isPending,
      }}
    />
  );
}

/**
 * Una modifica che Claude propone: la esegue solo la conferma di chi l'ha
 * chiesta (Confirm, Edit, Cancel; con più azioni una casella per riga e
 * «Confirm all» / «Confirm selected»). Chi non l'ha chiesta legge
 * «Proposal for …» e nessun bottone. L'esito prende il posto dei bottoni.
 * `renderText` / `renderCode`: come si scrivono riassunti e codici nati
 * per chi guarda (la Chat li passa per R-E9); senza, testo e link.
 */
export function ProposalCardView({
  event,
  viewerId,
  ops,
  renderText,
  renderCode,
  canAct = true,
  cantActNote,
  after,
}: {
  event: Ev<"proposal">;
  viewerId: string;
  ops: ProposalOps;
  renderText?: (text: string) => ReactNode;
  renderCode?: (code: string) => ReactNode;
  /** Sotto l'esito di una scheda confermata («Undo» del gruppo, area 10a). */
  after?: ReactNode;
  /** Chi l'ha chiesta può ancora agire qui (nella Chat: membro, canale non archiviato). */
  canAct?: boolean;
  /** La riga per chi l'ha chiesta e non può più agire. */
  cantActNote?: string;
}) {
  const { t } = useTranslation();
  const requester = usePersonName(event.requesterId);
  const [selected, setSelected] = useState<boolean[]>(() => event.actions.map(() => true));
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditState>(null);
  const headingId = useId();
  const resolvedRef = useFocusWhenResolved<HTMLElement>(event.status !== "open");

  const own = event.requesterId === viewerId;
  const mine = own && canAct;
  const open = event.status === "open";
  // Un «Annulla» è tutto o niente: niente caselle (I1).
  const many = event.actions.length > 1 && !event.undoOf;
  const chosen = selected.flatMap((on, i) => (on ? [i] : []));
  const all = chosen.length === event.actions.length;
  const busy = ops.busy;
  const deletes = event.actions.some((a) => a.fn === "deleteTask");
  // La scheda di un «Annulla» (I1): ogni riga dice cosa si annulla.
  const summary = (text: string) => {
    const said = event.undoOf ? t("claude.conversation.undo.proposalRow", { action: text }) : text;
    return renderText ? renderText(said) : said;
  };

  const fail = (e: Error) =>
    setError(
      e.message === "expired"
        ? t("claude.conversation.proposal.expiredNow")
        : e.message === "forbidden"
          ? t("claude.conversation.proposal.notYours")
          : t("claude.conversation.proposal.failedNow"),
    );

  const doConfirm = () => {
    setError(null);
    ops
      .confirm(all ? undefined : chosen)
      .then((result) => {
        // Una C senza codice non resta muta (T5): se la riconferma non è
        // passata di qui, la scheda lo dice; chiuso il dialogo, il toast.
        const refusal = result as { ok?: boolean; error?: string } | undefined;
        if (refusal?.ok === false && refusal.error === "reauth_required")
          setError(t("claude.conversation.proposal.needsCode"));
      })
      .catch(fail);
  };
  const doCancel = () => {
    setError(null);
    ops.cancel().catch(fail);
  };
  const doEdit = () => {
    setError(null);
    ops.edit().then(setEditing, fail);
  };
  const edited = (code: string) => {
    setEditing(null);
    ops.complete(code).catch(fail);
  };

  const outcome = (() => {
    switch (event.status) {
      case "confirmed": {
        const codes = event.resultCodes ?? [];
        const partial = event.confirmedActions
          ? t("claude.conversation.proposal.partial", {
              done: event.confirmedActions.length,
              count: event.actions.length,
            })
          : null;
        return (
          <p className="flex flex-wrap items-baseline gap-x-1 text-sm text-ink">
            <span className="font-semibold">
              {event.edited
                ? t("claude.conversation.proposal.doneEdited")
                : t("claude.conversation.proposal.done")}
            </span>
            {partial && <span className="text-ink-muted">· {partial}</span>}
            {codes.length > 0 && (
              <span>
                · <ResultCodes codes={codes} renderCode={renderCode} />
              </span>
            )}
          </p>
        );
      }
      case "cancelled":
        return (
          <p className="text-sm text-ink-muted">{t("claude.conversation.proposal.cancelled")}</p>
        );
      case "expired":
        return (
          <p className="text-sm text-ink-muted">{t("claude.conversation.proposal.expired")}</p>
        );
      case "failed": {
        // Un permesso perso: la frase di quel permesso e «Who?» (shape, «Esiti negativi»).
        const failure = event.failure;
        if (failure?.code === "forbidden" && failure.whoAction) {
          const action = t(`whoCan.actions.${failure.whoAction}`);
          return (
            <p className="text-sm text-critical">
              {failure.projectCode
                ? t("claude.conversation.proposal.failedForbidden", {
                    action,
                    code: failure.projectCode,
                  })
                : t("claude.conversation.proposal.failedForbiddenNoProject", { action })}
              <span className="text-ink-muted">
                {" · "}
                <WhoCanLink
                  action={failure.whoAction}
                  projectId={failure.projectId}
                  projectCode={failure.projectCode}
                />
              </span>
            </p>
          );
        }
        return (
          <p className="text-sm text-critical">
            {t("claude.conversation.proposal.failed", { error: event.error ?? "" })}
          </p>
        );
      }
      default:
        return null;
    }
  })();

  return (
    <section
      aria-labelledby={headingId}
      ref={resolvedRef}
      tabIndex={-1}
      data-proposal={event.proposalId}
      className={`${cardClass} gap-3 p-4 ${open ? "" : "border-rule"}`}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className="text-sm font-semibold text-ink">
          {mine
            ? event.undoOf
              ? t("claude.conversation.undo.proposalTitle")
              : t("claude.conversation.proposal.title", { count: event.actions.length })
            : own
              ? t("claude.conversation.proposal.forYou")
              : t("claude.conversation.proposal.forPerson", { name: requester })}
        </h3>
        {mine && open && <WaitingDot label={t("claude.conversation.waitingOnYou")} />}
      </header>
      {own && !canAct && open && cantActNote && (
        <p className="text-sm text-ink-muted">{cantActNote}</p>
      )}
      <ul className="flex min-w-0 flex-col gap-1">
        {event.actions.map((action, i) => {
          const ran = event.confirmedActions ? event.confirmedActions.includes(i) : null;
          return (
            <li key={i} className="flex min-w-0 items-start gap-2.5 text-md text-ink">
              {mine && open && many ? (
                <label className="flex min-w-0 cursor-pointer items-start gap-2.5">
                  <input
                    type="checkbox"
                    className="peer sr-only"
                    checked={selected[i]}
                    onChange={() => setSelected((s) => s.map((on, j) => (j === i ? !on : on)))}
                  />
                  <span className="mt-[3px] rounded-[3px] outline-offset-2 peer-focus-visible:outline-2 peer-focus-visible:outline-focus">
                    <CheckBox checked={!!selected[i]} />
                  </span>
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    {summary(spoken(t, action.summaryText, action.summary))}
                  </span>
                </label>
              ) : (
                <span
                  className={`min-w-0 [overflow-wrap:anywhere] ${ran === false ? "text-ink-faint line-through decoration-ink/30" : ""}`}
                >
                  {summary(spoken(t, action.summaryText, action.summary))}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {open && event.reasons && event.reasons.length > 0 && <ReasonRows reasons={event.reasons} />}
      {open && mine ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {!many && EDITABLE.has(event.actions[0]!.fn) && (
            <button type="button" className={quietButton} disabled={busy} onClick={doEdit}>
              {t("claude.conversation.proposal.edit")}
            </button>
          )}
          <button type="button" className={secondaryButton} disabled={busy} onClick={doCancel}>
            {t("claude.conversation.proposal.cancel")}
          </button>
          <button
            type="button"
            // [CA 6] Un'eliminazione nella scheda: rosso pieno, e la parola dice cosa fa.
            className={deletes ? dangerSolidButton : primaryButton}
            disabled={busy || chosen.length === 0}
            onClick={doConfirm}
          >
            {deletes
              ? t("claude.conversation.proposal.delete")
              : !many
                ? t("claude.conversation.proposal.confirm")
                : all
                  ? t("claude.conversation.proposal.confirmAll")
                  : t("claude.conversation.proposal.confirmSelected", { count: chosen.length })}
          </button>
        </div>
      ) : (
        (outcome || after) && (
          <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            {outcome}
            {after}
          </div>
        )
      )}
      {error && (
        <p role="alert" className="text-sm text-critical">
          {error}
        </p>
      )}
      {editing?.fn === "createTask" && (
        <NewTaskDialog
          projectId={editing.args.projectId as string | undefined}
          initial={editing.args as Partial<NewTaskInput>}
          onCreated={(task) => edited(task.code)}
          onClose={() => setEditing(null)}
        />
      )}
      {editing?.fn === "createRequest" && (
        <NewRequestDialog
          projectId={editing.args.projectId as string | undefined}
          initial={{
            title: editing.args.title as string | undefined,
            description: editing.args.description as string | undefined,
          }}
          onCreated={(request) => edited(request.code)}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

/** Quante persone «Notifies» nomina prima di «and 2 more» [CA 4]. */
const NAMED = 3;

/**
 * Le righe dei motivi di una scheda B/C (area 10a, Task 9), lette da
 * `reasons` e nell'ordine del dato: chi viene avvisato, l'automazione che
 * parte, «Can't be undone», il codice a due fattori. I nomi sono quelli che
 * chi legge vede: una persona che non vede non c'è (e non si conta), un
 * progetto che non vede toglie la riga dell'automazione.
 */
function ReasonRows({ reasons }: { reasons: readonly ClassReason[] }) {
  const { t } = useTranslation();
  const people = usePeople().data;
  const projects = useProjects().data;
  const codeOf = (projectId: string | undefined) =>
    projectId ? (projects?.find((p) => p.id === projectId)?.code ?? null) : null;

  const listOf = (names: string[]): string => {
    const and = t("claude.conversation.proposal.reasons.and");
    if (names.length > NAMED) {
      return t("claude.conversation.proposal.reasons.andMore", {
        names: names.slice(0, NAMED).join(", "),
        count: names.length - NAMED,
      });
    }
    return names.length < 2
      ? (names[0] ?? "")
      : `${names.slice(0, -1).join(", ")}${and}${names.at(-1)}`;
  };

  const rows = reasons.flatMap((reason): { kind: string; glyph: ReactNode; text: string }[] => {
    switch (reason.kind) {
      case "notifies": {
        const names = reason.personIds.flatMap((id) => {
          const name = people?.find((p) => p.id === id)?.name;
          return name ? [name] : [];
        });
        const code = codeOf(reason.projectId);
        const key = "claude.conversation.proposal.reasons";
        const text =
          names.length > 0
            ? reason.more
              ? code
                ? t(`${key}.notifiesMore`, { names: listOf(names), code })
                : t(`${key}.notifiesMoreNoProject`, { names: listOf(names) })
              : t(`${key}.notifies`, { names: listOf(names) })
            : reason.more
              ? code
                ? t(`${key}.notifiesOnlyMore`, { code })
                : t(`${key}.notifiesOnlyMoreNoProject`)
              : null;
        return text ? [{ kind: "notifies", glyph: <BellGlyph />, text }] : [];
      }
      case "automation": {
        const code = codeOf(reason.projectId);
        if (!code) return [];
        const which =
          reason.event === "task_created"
            ? "automationCreated"
            : reason.event === "task_closed"
              ? "automationClosed"
              : "automation";
        return [
          {
            kind: "automation",
            glyph: <AutomationGlyph />,
            text: t(`claude.conversation.proposal.reasons.${which}`, { code }),
          },
        ];
      }
      case "irreversible":
        return [
          {
            kind: "irreversible",
            glyph: <IrreversibleGlyph />,
            text: t("claude.conversation.proposal.reasons.irreversible"),
          },
        ];
      case "reauth":
        return [
          {
            kind: "reauth",
            glyph: <LockGlyph />,
            text: t("claude.conversation.proposal.reasons.reauth"),
          },
        ];
    }
  });
  if (rows.length === 0) return null;
  return (
    <ul
      className="flex min-w-0 flex-col gap-1 border-t border-rule pt-2.5"
      aria-label={t("claude.conversation.proposal.reasons.label")}
    >
      {rows.map((row) => (
        <li key={row.kind} className="flex min-w-0 items-start gap-2 text-sm text-ink-muted">
          <span className="mt-px text-ink">{row.glyph}</span>
          <span className="min-w-0 [overflow-wrap:anywhere]" data-reason={row.kind}>
            {row.text}
          </span>
        </li>
      ))}
    </ul>
  );
}
