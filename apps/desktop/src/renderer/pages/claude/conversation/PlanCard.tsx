import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDecidePlan } from "../../../data/queries";
import { inputClass } from "../../../tasks-ui/Dialog";
import { Markdown } from "../../../tasks-ui/Markdown";
import type { Ev } from "./flow";
import { WaitingDot } from "./QuestionCard";
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
 */
export function PlanCard({
  conversationId,
  event,
  canDecidePlan,
  projectCode,
  onReadFull,
  statusShown = false,
}: {
  conversationId: string;
  event: Ev<"plan">;
  canDecidePlan: boolean;
  projectCode: string | null;
  onReadFull?: () => void;
  statusShown?: boolean;
}) {
  const { t } = useTranslation();
  const decide = useDecidePlan();
  const [full, setFull] = useState(false);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
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
      event.status === "approved"
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
    decide.mutate(
      {
        id: conversationId,
        decision,
        planId: event.id,
        ...(instructions ? { instructions } : {}),
      },
      {
        onError: (error) => {
          if (error.message === "already_answered") {
            setLostTo((error as Error & { byId?: string | null }).byId ?? "");
          } else setFailed(true);
        },
      },
    );
  };

  return (
    <section aria-labelledby={headingId} data-plan={event.id} className={`${cardClass} gap-3 p-4`}>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className="text-sm font-semibold text-ink">
          {t(`claude.conversation.plan.${statusShown ? "title" : "waiting"}`)}
        </h3>
        {canDecidePlan && lostTo === null && !statusShown && (
          <WaitingDot label={t("claude.conversation.waitingOnYou")} />
        )}
      </header>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-xs font-semibold text-ink-muted">
          {t("claude.conversation.plan.inBrief")}
        </span>
        <Markdown source={event.summary} className="max-w-[68ch]" />
      </div>
      {toggle}
      {fullPlan}
      {canDecidePlan ? (
        rejecting === null ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              className={secondaryButton}
              disabled={decide.isPending || lostTo !== null}
              onClick={() => setRejecting("")}
            >
              {t("claude.conversation.plan.reject")}
            </button>
            <button
              type="button"
              className={primaryButton}
              disabled={decide.isPending || lostTo !== null}
              onClick={() => run("approve")}
            >
              {t("claude.conversation.plan.approve")}
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
                disabled={decide.isPending || lostTo !== null}
              >
                {t("claude.conversation.plan.rejectAndSend")}
              </button>
            </div>
          </form>
        )
      ) : (
        // Al posto di Approve, dove chi può decidere trova i bottoni: chi decide.
        <p data-plan-who className="text-right text-sm text-ink-muted">
          {projectCode
            ? t("claude.conversation.plan.whoCanApprove", { code: projectCode })
            : t("claude.conversation.plan.whoCanApproveAny")}
        </p>
      )}
      {lostTo !== null && (
        <p role="status" className="text-sm text-ink">
          {t("claude.conversation.plan.alreadyDecided", { name: lostToName })}
        </p>
      )}
      {failed && (
        <p role="alert" className="text-sm text-critical">
          {t("claude.conversation.plan.failed")}
        </p>
      )}
    </section>
  );
}
