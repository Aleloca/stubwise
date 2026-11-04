import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  useCancelProposal,
  useCompleteEditedProposal,
  useConfirmProposal,
  useEditProposal,
  usePeople,
  useProjects,
  useRoles,
} from "../../../data/queries";
import type {
  ClassReason,
  NewTaskInput,
  ProposalNote,
  ProposedAction,
  UndoView,
  Utterance,
} from "../../../data/types";
import { spoken } from "../../../domain/claude/answers";
import type { T } from "../../../domain/claude/context";
import { busyLine } from "../../../domain/claude/intents/archive";
import { nameList } from "../../../domain/names";
import { useReauth } from "../../../layout/useReauth";
import { CheckBox } from "../../../tasks-ui/Menu";
import { NewRequestDialog } from "../../requests/NewRequestDialog";
import { NewTaskDialog } from "../../task/NewTaskDialog";
import { ClaudeMark } from "../../../components/ClaudeMark";
import { CodeLink } from "../../../components/CodeLink";
import { WhoCanLink } from "../../../components/WhoCanLink";
import { itemClass, MenuGroup } from "../../../tasks-ui/Menu";
import { dangerSolidButton, MenuButton } from "../../tasks/controls";
import { isMasculineGroup, objectCodesOf } from "./ExecutedRow";
import { CODE_IN_TEXT, type Ev } from "./flow";
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
  reauthPhrases,
}: {
  conversationId: string;
  event: Ev<"proposal">;
  viewerId: string;
  /** Area 10a: lo stato di «Annulla» del gruppo confermato, per chi guarda. */
  undo?: UndoView | undefined;
  /** Area 10a (M1): le frasi all'infinito della riconferma, una per azione (dal livello dati). */
  reauthPhrases?: (Utterance | null)[] | undefined;
}) {
  const { t } = useTranslation();
  const confirm = useConfirmProposal();
  const cancel = useCancelProposal();
  const edit = useEditProposal();
  const complete = useCompleteEditedProposal();
  const reauth = useReauth();
  const viewerName = usePersonName(viewerId);
  const target = { id: conversationId, proposalId: event.proposalId };
  // La frase del dialogo della riconferma: all'infinito, dal livello dati
  // («To add …» / «Per aggiungere …», M1); mai il riassunto, che è
  // all'imperativo e in it non si piega dentro «Per …».
  const reauthAction = (indexes: number[] | undefined) => {
    if (event.undoOf) return t("claude.conversation.undo.reauthAction");
    const chosen = indexes ?? event.actions.map((_, i) => i);
    if (chosen.length !== 1)
      return t("claude.conversation.proposal.reauthMany", { count: chosen.length });
    const phrase = reauthPhrases?.[chosen[0]!];
    return phrase ? t(phrase.key, phrase.params) : t("claude.conversation.proposal.reauthOne");
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
  const [expanded, setExpanded] = useState(false);
  const headingId = useId();
  const confirmWhyId = useId();
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
  // Area 10b (S4): oltre 5 righe, le prime 5 e «Show N more»; le nascoste
  // restano nella scelta (spuntate), e il primario dice sempre il numero vero.
  const masculine = isMasculineGroup(event.actions);
  const projects = event.actions.every((a) => a.fn === "archiveProject");
  const overflow = event.actions.length > SHOWN_ROWS;
  const shownRows = overflow && !expanded ? SHOWN_ROWS : event.actions.length;
  // Area 10b (S5): la scheda nata bloccata (`escalation`): Confirm spento con la sua frase.
  const blocked = open && mine ? event.blocked : undefined;
  const none = many && chosen.length === 0;
  const confirmWhy = none
    ? t(
        projects
          ? "claude.conversation.proposal.chooseOneProject"
          : "claude.conversation.proposal.chooseOne",
      )
    : null;
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

  const card = (
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
        {event.actions.slice(0, shownRows).map((action, i) => {
          const ran = event.confirmedActions ? event.confirmedActions.includes(i) : null;
          const out = mine && open && many && !selected[i];
          const why = action.why ? <WhyLine why={action.why} /> : null;
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
                  <span
                    className={`flex min-w-0 flex-col [overflow-wrap:anywhere] transition-colors duration-[var(--duration-fast)] ease-out ${out ? "text-ink-faint" : ""}`}
                  >
                    <span>
                      {summary(spoken(t, action.summaryText, action.summary))}
                      {out && (
                        <span className="sr-only">
                          {` · ${t(masculine ? "claude.conversation.proposal.excludedMasculine" : "claude.conversation.proposal.excluded")}`}
                        </span>
                      )}
                    </span>
                    {why}
                  </span>
                </label>
              ) : (
                <span
                  className={`flex min-w-0 flex-col [overflow-wrap:anywhere] ${ran === false ? "text-ink-faint line-through decoration-ink/30" : ""}`}
                >
                  <span>{summary(spoken(t, action.summaryText, action.summary))}</span>
                  {open && why}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {overflow && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="-mt-1 self-start rounded-md text-sm font-medium text-ink-muted underline decoration-ink/30 underline-offset-2 transition-colors duration-[var(--duration-fast)] ease-out hover:text-ink hover:decoration-ink"
        >
          {expanded
            ? t("claude.conversation.proposal.more.fewer")
            : t(
                masculine
                  ? "claude.conversation.proposal.more.show"
                  : "claude.conversation.proposal.more.showFeminine",
                { count: event.actions.length - SHOWN_ROWS },
              )}
        </button>
      )}
      {open && event.reasons && event.reasons.length > 0 && (
        <ReasonRows
          reasons={blocked ? event.reasons.filter((r) => r.kind !== "reauth") : event.reasons}
        />
      )}
      {blocked && <BlockedLine id={confirmWhyId} event={event} />}
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
            disabled={busy || chosen.length === 0 || !!blocked}
            aria-describedby={blocked || confirmWhy ? confirmWhyId : undefined}
            onClick={doConfirm}
          >
            {deletes
              ? t("claude.conversation.proposal.delete")
              : !many
                ? t("claude.conversation.proposal.confirm")
                : all
                  ? t(
                      masculine
                        ? "claude.conversation.proposal.confirmAllN"
                        : "claude.conversation.proposal.confirmAllNFeminine",
                      { count: event.actions.length },
                    )
                  : t("claude.conversation.proposal.confirmSelected", { count: chosen.length })}
          </button>
          {confirmWhy && !blocked && (
            // La frase del Confirm spento per «nessuna spunta», a vista.
            <span id={confirmWhyId} className="basis-full text-right text-sm text-ink-muted">
              {confirmWhy}
            </span>
          )}
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
  // Area 10b (S4): le righe a parte stanno SOTTO la scheda, fuori dal contorno.
  const notes = event.notes ?? [];
  if (notes.length === 0) return card;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {card}
      <NoteRows notes={notes} />
    </div>
  );
}

/** Quante righe di una scheda in blocco si vedono prima di «Show N more» ([SC 10]). */
const SHOWN_ROWS = 5;
/** Quante righe `busy` si nominano prima di «and N more busy». */
const SHOWN_BUSY = 5;

/** Il perché di una riga, in un fatto: «last activity: Jul 24»; al passaggio data e ora intere. */
function WhyLine({ why }: { why: Utterance }) {
  const { t, i18n } = useTranslation();
  const date = typeof why.params?.date === "string" ? why.params.date : null;
  const title = date
    ? new Intl.DateTimeFormat(i18n.language, {
        dateStyle: "long",
        ...(date.length > 10 ? { timeStyle: "short" } : {}),
        timeZone: "UTC",
      }).format(new Date(date.length > 10 ? date : `${date}T00:00:00Z`))
    : undefined;
  return (
    <span data-why title={title} className="num text-xs text-ink-muted">
      {spoken(t, why, "")}
    </span>
  );
}

/**
 * La riga della scheda bloccata (S5, [SC 14]), al posto di quella della
 * riconferma: ⊘ in `critical` e la frase, col nome del ruolo letto adesso.
 * È anche la descrizione del Confirm spento (`id`). Nessun «Who?»: non è un
 * permesso che manca a chi chiede, è un tetto.
 */
function BlockedLine({ id, event }: { id: string; event: Ev<"proposal"> }) {
  const { t } = useTranslation();
  const roles = useRoles().data;
  const projects = useProjects().data;
  const projectId = event.actions[0]?.args.projectId;
  const code = projects?.find((p) => p.id === projectId)?.code ?? null;
  const role = roles?.find((r) => r.id === event.blocked?.roleId)?.name;
  const K = "claude.conversation.proposal.blocked";
  // Senza il codice (il progetto non si legge più) la frase non lo nomina (m9).
  const text = code
    ? role
      ? t(`${K}.escalation`, { role, code })
      : t(`${K}.escalationNoRole`, { code })
    : role
      ? t(`${K}.escalationNoCode`, { role })
      : t(`${K}.escalationNoRoleNoCode`);
  return (
    <p id={id} data-blocked className="flex min-w-0 items-start gap-2 text-sm text-ink">
      <span className="mt-px text-critical">
        <BlockedGlyph />
      </span>
      <span className="min-w-0 [overflow-wrap:anywhere]">{text}</span>
    </p>
  );
}

/** ⊘ disegnato: la scheda non si può confermare (non un permesso che manca: un tetto, [SC 14]). */
const BlockedGlyph = () => (
  <svg viewBox="0 0 16 16" width={16} height={16} aria-hidden="true" focusable="false">
    <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth={1.4} />
    <path d="m4.2 11.8 7.6-7.6" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
  </svg>
);

/** Il lucchetto aperto: i progetti che chi chiede vede ma non gestisce. */
const OpenLockGlyph = () => (
  <svg
    viewBox="0 0 16 16"
    width={16}
    height={16}
    fill="none"
    stroke="currentColor"
    strokeWidth={1.4}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <rect x="3.5" y="7.5" width="9" height="6" rx="1.2" />
    <path d="M5.5 7.5V5.2a2.5 2.5 0 0 1 4.9-.7" />
  </svg>
);

/** Un testo di riga a parte («**BSC** has Claude working on **BSC-3**…») coi codici apribili. */
function withCodes(text: string): ReactNode {
  return text.split(/\*\*([^*]+)\*\*/).map((part, i) => {
    if (i % 2 === 0) return <Fragment key={i}>{part}</Fragment>;
    if (new RegExp(`^${CODE_IN_TEXT.source}$`).test(part)) return <CodeLink key={i} code={part} />;
    // Un codice di progetto: chi legge lo vede (le note non nominano mai l'invisibile).
    if (/^[A-Z]{2,4}$/.test(part)) {
      return (
        <a
          key={i}
          href={`#/p/${part}/overview`}
          className="num font-semibold text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
        >
          {part}
        </a>
      );
    }
    return (
      <strong key={i} className="font-semibold text-ink">
        {part}
      </strong>
    );
  });
}

/**
 * Le righe sotto la scheda (area 10b, S4; shape §3.7): i progetti che chi
 * chiede vede ma non gestisce, con «Who?» per progetto, poi i progetti
 * occupati con le ragioni di `busyReasonsOf`. Le legge da `notes`: niente si
 * deduce qui, e nessuna nomina o conta un progetto invisibile.
 */
function NoteRows({ notes }: { notes: readonly ProposalNote[] }) {
  const { t } = useTranslation();
  const busy = notes.flatMap((n) =>
    n.kind === "busy" ? n.reasons.map((r) => ({ code: n.code, reason: r })) : [],
  );
  const extra = Math.max(0, busy.length - SHOWN_BUSY);
  return (
    <ul
      aria-label={t("claude.conversation.proposal.notes.label")}
      className="flex min-w-0 flex-col gap-1.5"
    >
      {notes.map((note, i) =>
        note.kind === "not_manageable" ? (
          <li key={`n${i}`} className="flex min-w-0 items-start gap-2 text-sm text-ink-muted">
            <span className="mt-px text-ink">
              <OpenLockGlyph />
            </span>
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {t("claude.conversation.proposal.notes.notManageable", { count: note.count })}
              <WhoForNote note={note} />
            </span>
          </li>
        ) : null,
      )}
      {busy.slice(0, SHOWN_BUSY).map(({ code, reason }, i) => (
        <li key={`b${i}`} className="flex min-w-0 items-start gap-2 text-sm text-ink-muted">
          <span className="mt-[3px] flex size-4 shrink-0 items-start justify-center">
            <ClaudeMark />
          </span>
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {withCodes(busyLine(t as unknown as T, code, reason))}
          </span>
        </li>
      ))}
      {extra > 0 && (
        <li className="pl-6 text-sm text-ink-muted">
          {t("claude.conversation.proposal.notes.moreBusy", { count: extra })}
        </li>
      )}
    </ul>
  );
}

/**
 * «Who?» dei non gestibili: con un progetto il `WhoCanLink` diretto; con più
 * progetti prima un menu coi codici e i nomi (solo visibili, `codes`), poi il
 * «Who?» del progetto scelto ([SC 11]). Senza codici, la riga resta senza.
 */
function WhoForNote({ note }: { note: Extract<ProposalNote, { kind: "not_manageable" }> }) {
  const { t } = useTranslation();
  const projects = useProjects().data;
  const codes = note.codes ?? [];
  const [chosen, setChosen] = useState<string | null>(null);
  const who = useRef<HTMLSpanElement>(null);
  // Scelto il progetto, il suo «Who?» si apre subito: è ciò che si è chiesto.
  useEffect(() => {
    if (chosen) who.current?.querySelector<HTMLButtonElement>("button")?.click();
  }, [chosen]);
  if (codes.length === 0) return null;
  if (codes.length === 1) {
    return (
      <>
        {" · "}
        <WhoCanLink action={note.whoAction} projectCode={codes[0]!} />
      </>
    );
  }
  return (
    <>
      {" · "}
      <MenuButton
        menuLabel={t("claude.conversation.proposal.notes.whichProject")}
        className="rounded-sm font-medium text-ink underline-offset-2 hover:underline aria-expanded:underline"
        label={t("whoCan.link.who")}
      >
        {(close) => (
          <MenuGroup>
            {codes.map((code) => (
              <button
                key={code}
                type="button"
                role="menuitem"
                className={itemClass}
                onClick={() => {
                  close();
                  setChosen(code);
                }}
              >
                <span className="num font-semibold text-ink">{code}</span>
                <span className="text-ink-muted">
                  {projects?.find((p) => p.code === code)?.name ?? ""}
                </span>
              </button>
            ))}
          </MenuGroup>
        )}
      </MenuButton>
      {chosen && (
        <span ref={who} className="ml-1.5">
          <WhoCanLink action={note.whoAction} projectCode={chosen} />
        </span>
      )}
    </>
  );
}

/** Quante persone «Notifies» nomina prima di «and 2 more» [CA 4]. */
const NAMED = 3;

/**
 * Le righe dei motivi di una scheda B/C (area 10a, Task 9), lette da
 * `reasons` e nell'ordine del dato: chi viene avvisato, l'automazione che
 * parte, «Can't be undone», il codice della verifica in due passaggi. I nomi sono quelli che
 * chi legge vede: una persona che non vede non c'è (e non si conta), un
 * progetto che non vede toglie la riga dell'automazione.
 */
function ReasonRows({ reasons }: { reasons: readonly ClassReason[] }) {
  const { t } = useTranslation();
  const people = usePeople().data;
  const projects = useProjects().data;
  const codeOf = (projectId: string | undefined) =>
    projectId ? (projects?.find((p) => p.id === projectId)?.code ?? null) : null;

  // Lo stesso elenco della frase sopra la scheda (`nameList`, minore T5 e M6 del 10a).
  const listOf = (names: string[]): string => nameList(t, names, NAMED);

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
