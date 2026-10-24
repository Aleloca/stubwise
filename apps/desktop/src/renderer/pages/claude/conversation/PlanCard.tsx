import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDecidePlan } from "../../../data/queries";
import { inputClass } from "../../../tasks-ui/Dialog";
import { Markdown } from "../../../tasks-ui/Markdown";
import type { Ev } from "./flow";
import { WaitingDot } from "./QuestionCard";
import { cardClass, primaryButton, quietButton, secondaryButton, usePersonName } from "./parts";

/**
 * Il piano di Claude. In attesa: «In brief», «Read the full plan» che lo
 * apre dentro la scheda, e — solo con `canDecidePlan` (lo calcola il
 * livello dati) — Approve / Reject with instructions. Gli altri leggono chi
 * può approvare. Deciso: una riga, con «Show plan».
 */
export function PlanCard({
  conversationId,
  event,
  canDecidePlan,
  projectCode,
}: {
  conversationId: string;
  event: Ev<"plan">;
  canDecidePlan: boolean;
  projectCode: string | null;
}) {
  const { t } = useTranslation();
  const decide = useDecidePlan();
  const [full, setFull] = useState(false);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const decidedBy = usePersonName(event.decidedById);
  const headingId = useId();
  const planId = useId();
  const reasonId = useId();

  const fullPlan = full && (
    <div id={planId} className="event-enter min-w-0 rounded-md bg-ink/3 px-3 py-2.5">
      <Markdown source={event.planText} codeLabel={t("claude.conversation.codeBlock")} />
    </div>
  );
  const toggle = (
    <button
      type="button"
      aria-expanded={full}
      aria-controls={planId}
      onClick={() => setFull((f) => !f)}
      className="-ml-1.5 self-start rounded-md px-1.5 py-0.5 text-sm font-medium text-ink-muted hover:bg-ink/6 hover:text-ink"
    >
      {full
        ? t("claude.conversation.plan.hide")
        : event.status === "pending"
          ? t("claude.conversation.plan.readFull")
          : t("claude.conversation.plan.show")}
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
      <div className="event-enter flex min-w-0 flex-col gap-1.5" data-plan={event.id}>
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
      { id: conversationId, decision, ...(instructions ? { instructions } : {}) },
      { onError: () => setFailed(true) },
    );
  };

  return (
    <section aria-labelledby={headingId} data-plan={event.id} className={`${cardClass} gap-3 p-4`}>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className="text-sm font-semibold text-ink">
          {t("claude.conversation.plan.waiting")}
        </h3>
        {canDecidePlan && <WaitingDot label={t("claude.conversation.waitingOnYou")} />}
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
              disabled={decide.isPending}
              onClick={() => setRejecting("")}
            >
              {t("claude.conversation.plan.reject")}
            </button>
            <button
              type="button"
              className={primaryButton}
              disabled={decide.isPending}
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
              <button type="submit" className={primaryButton} disabled={decide.isPending}>
                {t("claude.conversation.plan.rejectAndSend")}
              </button>
            </div>
          </form>
        )
      ) : (
        <p className="text-sm text-ink-muted">
          {projectCode
            ? t("claude.conversation.plan.whoCanApprove", { code: projectCode })
            : t("claude.conversation.plan.whoCanApproveAny")}
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
