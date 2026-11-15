import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { WhoCanLink } from "../../../components/WhoCanLink";
import { useDecidePlan } from "../../../data/queries";
import { inputClass } from "../../../tasks-ui/Dialog";
import { Markdown } from "../../../tasks-ui/Markdown";
import type { Ev } from "./flow";
import { TroubleGlyph } from "../../servers/glyphs";
import { WaitingDot } from "./QuestionCard";
import { stepLabel, type ServerFixPlan } from "./serverFixPlan";
import {
  cardClass,
  DisclosureGlyph,
  primaryButton,
  quietButton,
  secondaryButton,
  useFocusWhenResolved,
  usePersonName,
} from "./parts";

/**
 * Il piano di Claude. In attesa: «In brief», «Read the full plan» che lo
 * apre dentro la scheda, e — solo con `canDecidePlan` (lo calcola il
 * livello dati) — Approve / Reject with instructions. Gli altri leggono chi
 * può approvare. Una decisione arrivata prima da un altro dice chi (anche
 * se nel frattempo Claude ha scritto un piano nuovo: la decisione vale
 * solo per il piano letto). Deciso: una riga, con «Show plan». `onReadFull`: nel
 * pannello della task «Read the full plan» apre la sessione su quel punto
 * invece di aprirlo nella scheda stretta. `statusShown`: chi la ospita dice
 * già che il piano aspetta (la riga di stato della task), e la scheda non
 * lo ripete — si intitola solo «Plan».
 *
 * `serverFix` (area 8, F4b): il piano di una correzione di server. Mostra
 * SOLO le azioni dell'insieme chiuso (`serverPlan`), tradotte, col perché
 * come testo — mai un comando, mai un campo per scriverne uno —; dice che
 * le esegue l'agente, una alla volta, e che un piano che rilascia va
 * rifiutato; nessuna approvazione in anticipo; chi l'ha avviata e può
 * approvare legge che approvando partono le azioni. Un piano che libera
 * spazio su un server CONDIVISO lo dice prima dei bottoni, coi progetti che
 * chi guarda vede (decisione del maintainer). Con l'approvazione spenta
 * (`blockedReason`, calcolata dal livello dati) Approve resta visibile ma
 * spento, col motivo sopra, e Reject resta attivo se il livello dati lo
 * permette (`canReject`).
 */
export function PlanCard({
  conversationId,
  event,
  canDecidePlan,
  projectCode,
  onReadFull,
  statusShown = false,
  serverFix,
  onDecide,
  decideElsewhere = false,
}: {
  conversationId: string;
  event: Ev<"plan">;
  canDecidePlan: boolean;
  projectCode: string | null;
  onReadFull?: () => void;
  statusShown?: boolean;
  serverFix?: ServerFixPlan | undefined;
  /**
   * La decisione passa da qui invece che dalla conversazione: la scheda di
   * una correzione nella sezione Server della task (decisione del
   * maintainer, 15 nov 2026), con le azioni della correzione.
   */
  onDecide?: (decision: "approve" | "reject", instructions?: string) => Promise<void>;
  /**
   * La sessione di una correzione: il piano si legge, ma si decide nella
   * sezione Server della task (nessun bottone qui, la frase lo dice).
   */
  decideElsewhere?: boolean;
}) {
  const { t } = useTranslation();
  const decide = useDecidePlan();
  const [deciding, setDeciding] = useState(false);
  const busy = decide.isPending || deciding;
  const [full, setFull] = useState(false);
  const [rejecting, setRejecting] = useState<string | null>(null);
  /** `changed`: 409 `plan_changed`, il piano è stato riscritto dopo che lo si è letto. */
  const [failed, setFailed] = useState<boolean | "changed" | "stale">(false);
  const [lostTo, setLostTo] = useState<string | null>(null);
  const decidedBy = usePersonName(event.decidedById);
  const lostToName = usePersonName(lostTo);
  const headingId = useId();
  const resolvedRef = useFocusWhenResolved<HTMLDivElement>(event.status !== "pending");
  const planId = useId();
  const reasonId = useId();

  const fullPlan = full && (
    <div id={planId} className="event-enter min-w-0 rounded-md bg-ink/3 px-3 py-2.5">
      <Markdown
        source={event.planText}
        codeLabel={t("claude.conversation.codeBlock")}
        tableLabel={t("claude.conversation.table")}
      />
    </div>
  );
  // Un'apertura come quella dei gruppi d'azione: in inchiostro, con la freccia
  // che gira (o che porta alla sessione, nel pannello della task).
  // Senza testo del piano né sessione da aprire non c'è niente da leggere (review F4b).
  const readable = event.planText !== "" || onReadFull !== undefined;
  const toggle = (
    <button
      type="button"
      aria-expanded={onReadFull ? undefined : full}
      aria-controls={onReadFull ? undefined : planId}
      onClick={() => (onReadFull ? onReadFull() : setFull((f) => !f))}
      className="-ml-1.5 inline-flex min-h-7 items-center gap-1.5 self-start rounded-md px-1.5 py-0.5 text-sm font-medium text-ink hover:bg-ink/6"
    >
      {full
        ? t("claude.conversation.plan.hide")
        : event.status === "pending"
          ? t("claude.conversation.plan.readFull")
          : t("claude.conversation.plan.show")}
      <DisclosureGlyph open={full} />
    </button>
  );

  if (event.status !== "pending") {
    const line =
      event.status === "undecided"
        ? t("claude.conversation.plan.undecided")
        : event.status === "approved"
        ? t("claude.conversation.plan.approvedBy", { name: decidedBy })
        : event.status === "pre_approved"
          ? t("claude.conversation.plan.preApprovedBy", { name: decidedBy })
          : event.instructions
            ? t("claude.conversation.plan.rejectedWith", {
                name: decidedBy,
                instructions: event.instructions,
              })
            : t("claude.conversation.plan.rejectedBy", { name: decidedBy });
    return (
      <div
        ref={resolvedRef}
        tabIndex={-1}
        className="event-enter flex min-w-0 flex-col gap-1.5 rounded-md"
        data-plan={event.id}
      >
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm text-ink-muted">
          <span className="font-semibold text-ink">{t("claude.conversation.plan.title")}</span>
          <span>{line}</span>
          {toggle}
        </p>
        {fullPlan}
      </div>
    );
  }

  const run = (decision: "approve" | "reject", instructions?: string) => {
    setFailed(false);
    if (onDecide) {
      setDeciding(true);
      void onDecide(decision, instructions)
        .then(() => setRejecting(null))
        .catch((error: Error) =>
          setFailed(
            /plan_changed/.test(error.message)
              ? "changed"
              : /plan_stale/.test(error.message)
                ? "stale"
                : true,
          ),
        )
        .finally(() => setDeciding(false));
      return;
    }
    decide.mutate(
      {
        id: conversationId,
        decision,
        planId: event.id,
        // Il digest del piano che chi decide ha davanti (build app).
        ...(event.digest ? { planDigest: event.digest } : {}),
        ...(instructions ? { instructions } : {}),
      },
      {
        onError: (error) => {
          if (error.message === "already_answered") {
            setLostTo((error as Error & { byId?: string | null }).byId ?? "");
          } else if ((error as { code?: unknown }).code === "plan_changed") {
            setFailed("changed");
          } else setFailed(true);
        },
      },
    );
  };

  // Rifiutare resta possibile anche con l'approvazione spenta (correzione di server).
  const canReject = serverFix ? serverFix.canReject : canDecidePlan;
  const decides = !decideElsewhere && (canDecidePlan || canReject);
  const F = "taskDetail.server.planCard";
  return (
    <section
      aria-labelledby={headingId}
      data-plan={event.id}
      className={`${cardClass} @container gap-3 p-4`}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className="text-sm font-semibold text-ink">
          {serverFix
            ? t(`${F}.planTitle`, { code: serverFix.code })
            : t(`claude.conversation.plan.${statusShown ? "title" : "waiting"}`)}
        </h3>
        {decides && lostTo === null && !statusShown && (
          <WaitingDot label={t("claude.conversation.waitingOnYou")} />
        )}
      </header>
      {serverFix && (
        <p data-runs-as className="-mt-1.5 flex items-start gap-1.5 text-sm text-ink">
          <span className="mt-0.5 shrink-0">
            <TroubleGlyph />
          </span>
          {t(`${F}.runsAs`, { code: serverFix.code })}
        </p>
      )}
      {/* La scheda della sezione Server (dalla vista della correzione) non ha un riassunto. */}
      {event.summary && (
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs font-semibold text-ink-muted">
            {t("claude.conversation.plan.inBrief")}
          </span>
          <Markdown source={event.summary} className="max-w-[68ch]" />
        </div>
      )}
      {serverFix && event.serverPlan && event.serverPlan.steps.length > 0 && (
        // Chi approva legge il piano azione per azione, sempre a vista (shape
        // server-task §3): le azioni tradotte, il perché (del modello) come testo.
        <ol
          aria-label={t(`${F}.commands`, { code: serverFix.code })}
          className="flex min-w-0 flex-col gap-2"
        >
          {event.serverPlan.steps.map((step, i) => (
            <li key={i} className="flex min-w-0 gap-2" data-plan-step={step.action}>
              <span className="num w-4 shrink-0 text-right text-xs leading-5 text-ink-muted">
                {i + 1}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="text-sm leading-5 font-medium text-ink [overflow-wrap:anywhere]">
                  {stepLabel(t, step)}
                </span>
                <span className="text-[13px] text-ink-muted [overflow-wrap:anywhere]">
                  {step.why}
                </span>
              </span>
            </li>
          ))}
        </ol>
      )}
      {serverFix?.pruneWarning && (
        // «Libera spazio» tocca tutto il server: su uno condiviso si dice
        // PRIMA di approvare, coi progetti che chi guarda vede (gli altri contati).
        <div
          role="note"
          aria-label={t(`${F}.shared.title`, { code: serverFix.code })}
          data-shared-warning
          className="flex items-start gap-1.5 border-l border-critical py-0.5 pl-2.5 text-sm text-ink"
        >
          <span className="mt-0.5 shrink-0">
            <TroubleGlyph />
          </span>
          <span>{sharedLine(t, serverFix.code, serverFix.pruneWarning)}</span>
        </div>
      )}
      {readable && toggle}
      {fullPlan}
      {serverFix &&
        decides &&
        rejecting === null &&
        // Sopra i bottoni: perché Approve è spento, o che approvando partono i comandi.
        (serverFix.blockedReason ? (
          <p role="note" className="text-sm text-ink">
            {t(`${F}.blocked.${serverFix.blockedReason}`, { code: serverFix.code })}
          </p>
        ) : (
          serverFix.startedByViewer &&
          canDecidePlan && (
            <p className="text-sm text-ink">{t(`${F}.youStarted`, { code: serverFix.code })}</p>
          )
        ))}
      {decides ? (
        rejecting === null ? (
          // Stretta (pannello della task): impilati a tutta larghezza, il primario in alto.
          <div className="flex flex-col-reverse gap-2 @[400px]:flex-row @[400px]:flex-wrap @[400px]:items-center @[400px]:justify-end">
            <button
              type="button"
              className={secondaryButton}
              disabled={busy || lostTo !== null || !canReject}
              // Approvazione spenta: il rifiuto chiude la correzione e libera il
              // server, senza indicazioni (un piano riscritto sarebbe bloccato uguale).
              onClick={() => (serverFix?.blockedReason ? run("reject") : setRejecting(""))}
            >
              {serverFix?.blockedReason
                ? t(`${F}.rejectBlocked`)
                : t("claude.conversation.plan.reject")}
            </button>
            <button
              type="button"
              className={primaryButton}
              // Review F4b I1: con l'approvazione spenta (operazioni dell'agente
              // spente, server tolto) Approve resta spento anche se il permesso c'è.
              disabled={busy || lostTo !== null || !canDecidePlan || !!serverFix?.blockedReason}
              onClick={() => run("approve")}
            >
              {serverFix ? t(`${F}.approve`) : t("claude.conversation.plan.approve")}
            </button>
          </div>
        ) : (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              run("reject", rejecting.trim() || undefined);
            }}
          >
            <label htmlFor={reasonId} className="text-sm font-medium text-ink">
              {t("claude.conversation.plan.instructionsLabel")}
            </label>
            <textarea
              id={reasonId}
              autoFocus
              rows={3}
              value={rejecting}
              onChange={(e) => setRejecting(e.target.value)}
              placeholder={t("claude.conversation.plan.instructionsPlaceholder")}
              className={`${inputClass} resize-none`}
            />
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className={quietButton} onClick={() => setRejecting(null)}>
                {t("claude.conversation.cancel")}
              </button>
              <button
                type="submit"
                className={primaryButton}
                disabled={busy || lostTo !== null}
              >
                {t("claude.conversation.plan.rejectAndSend")}
              </button>
            </div>
          </form>
        )
      ) : (
        decideElsewhere ? (
          <p data-plan-where className="text-sm text-ink-muted">
            {t(`${F}.decideInServer`, { code: serverFix?.code ?? "" })}
          </p>
        ) : (
        // Al posto di Approve, dove chi può decidere trova i bottoni: chi decide.
        <p data-plan-who className="text-right text-sm text-ink-muted">
          {serverFix
            ? projectCode
              ? t(`${F}.waitingFor`, { project: projectCode })
              : t(`${F}.waitingForAny`)
            : projectCode
              ? t("claude.conversation.plan.whoCanApprove", { code: projectCode })
              : t("claude.conversation.plan.whoCanApproveAny")}
          {projectCode && (
            <>
              {" "}
              <WhoCanLink action="approvePlan" projectCode={projectCode} />
            </>
          )}
        </p>
        )
      )}
      {serverFix && (
        <p data-release-rule className="text-xs text-ink-muted">
          {t(`${F}.releaseRule`)}
        </p>
      )}
      {lostTo !== null && (
        <p role="status" className="text-sm text-ink">
          {t("claude.conversation.plan.alreadyDecided", { name: lostToName })}
        </p>
      )}
      {failed && (
        <p role="alert" className="text-sm text-critical">
          {t(
            failed === "changed"
              ? "claude.conversation.plan.changed"
              : failed === "stale"
                ? "taskDetail.server.planCard.stale"
                : "claude.conversation.plan.failed",
          )}
        </p>
      )}
    </section>
  );
}

/** La frase dell'avviso «server condiviso»: i progetti che chi guarda vede, gli altri contati. */
function sharedLine(
  t: ReturnType<typeof useTranslation>["t"],
  code: string,
  warning: NonNullable<ServerFixPlan["pruneWarning"]>,
): string {
  const F = "taskDetail.server.planCard.shared";
  const projects = warning.projects.join(", ");
  const count = warning.hiddenCount;
  if (warning.projects.length > 0 && count > 0) return t(`${F}.both`, { code, projects, count });
  if (warning.projects.length > 0) return t(`${F}.projects`, { code, projects });
  return t(`${F}.hidden`, { code, count });
}
