import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useCancelProposal,
  useCompleteEditedProposal,
  useConfirmProposal,
  useEditProposal,
} from "../../../data/queries";
import type { NewTaskInput, ProposedAction } from "../../../data/types";
import { CheckBox } from "../../../tasks-ui/Menu";
import { NewRequestDialog } from "../../requests/NewRequestDialog";
import { NewTaskDialog } from "../../task/NewTaskDialog";
import type { Ev } from "./flow";
import { WaitingDot } from "./QuestionCard";
import {
  cardClass,
  primaryButton,
  quietButton,
  secondaryButton,
  useFocusWhenResolved,
  usePersonName,
} from "./parts";

/** Le azioni che si possono rifare dal loro dialogo, precompilato («Edit»). */
const EDITABLE: ReadonlySet<ProposedAction["fn"]> = new Set(["createTask", "createRequest"]);

/** Dove si apre un codice nato da una proposta (task o richiesta). */
export function routeOfCode(code: string): string {
  const project = code.split("-")[0];
  return /-R\d+$/.test(code) ? `#/p/${project}/requests` : `#/p/${project}/tasks?task=${code}`;
}

function ResultCodes({ codes }: { codes: readonly string[] }) {
  return (
    <>
      {codes.map((code, i) => (
        <span key={code}>
          <a
            href={routeOfCode(code)}
            className="num font-semibold text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
          >
            {code}
          </a>
          {i < codes.length - 1 && ", "}
        </span>
      ))}
    </>
  );
}

type EditState = { fn: ProposedAction["fn"]; args: Record<string, unknown> } | null;

/**
 * Una modifica che Claude propone: la esegue solo la conferma di chi l'ha
 * chiesta (Confirm, Edit, Cancel; con più azioni una casella per riga e
 * «Confirm all» / «Confirm selected»). Chi non l'ha chiesta legge
 * «Proposal for …» e nessun bottone. L'esito prende il posto dei bottoni.
 */
export function ProposalCard({
  conversationId,
  event,
  viewerId,
}: {
  conversationId: string;
  event: Ev<"proposal">;
  viewerId: string;
}) {
  const { t } = useTranslation();
  const confirm = useConfirmProposal();
  const cancel = useCancelProposal();
  const edit = useEditProposal();
  const complete = useCompleteEditedProposal();
  const requester = usePersonName(event.requesterId);
  const [selected, setSelected] = useState<boolean[]>(() => event.actions.map(() => true));
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditState>(null);
  const headingId = useId();
  const resolvedRef = useFocusWhenResolved<HTMLElement>(event.status !== "open");

  const mine = event.requesterId === viewerId;
  const open = event.status === "open";
  const many = event.actions.length > 1;
  const chosen = selected.flatMap((on, i) => (on ? [i] : []));
  const all = chosen.length === event.actions.length;
  const busy = confirm.isPending || cancel.isPending || edit.isPending || complete.isPending;

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
    confirm.mutate(
      {
        id: conversationId,
        proposalId: event.proposalId,
        ...(all ? {} : { actionIndexes: chosen }),
      },
      { onError: fail },
    );
  };
  const doCancel = () => {
    setError(null);
    cancel.mutate({ id: conversationId, proposalId: event.proposalId }, { onError: fail });
  };
  const doEdit = () => {
    setError(null);
    edit.mutate(
      { id: conversationId, proposalId: event.proposalId },
      { onSuccess: (result) => setEditing(result), onError: fail },
    );
  };
  const edited = (code: string) => {
    setEditing(null);
    complete.mutate(
      { id: conversationId, proposalId: event.proposalId, resultCodes: [code] },
      { onError: fail },
    );
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
                · <ResultCodes codes={codes} />
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
      case "failed":
        return (
          <p className="text-sm text-critical">
            {t("claude.conversation.proposal.failed", { error: event.error ?? "" })}
          </p>
        );
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
            ? t("claude.conversation.proposal.title", { count: event.actions.length })
            : t("claude.conversation.proposal.forPerson", { name: requester })}
        </h3>
        {mine && open && <WaitingDot label={t("claude.conversation.waitingOnYou")} />}
      </header>
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
                  <span className="min-w-0 [overflow-wrap:anywhere]">{action.summary}</span>
                </label>
              ) : (
                <span
                  className={`min-w-0 [overflow-wrap:anywhere] ${ran === false ? "text-ink-faint line-through decoration-ink/30" : ""}`}
                >
                  {action.summary}
                </span>
              )}
            </li>
          );
        })}
      </ul>
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
            className={primaryButton}
            disabled={busy || chosen.length === 0}
            onClick={doConfirm}
          >
            {!many
              ? t("claude.conversation.proposal.confirm")
              : all
                ? t("claude.conversation.proposal.confirmAll")
                : t("claude.conversation.proposal.confirmSelected", { count: chosen.length })}
          </button>
        </div>
      ) : (
        outcome
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
