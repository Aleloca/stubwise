import { useTranslation } from "react-i18next";
import type { Attachment, ContextRef, ConversationDetail } from "../../../data/types";
import { ContextNote } from "../../../layout/claudePanel/ContextChip";
import { ActionRows } from "./ActionRows";
import { CommandRows, isServerCommand } from "./CommandRows";
import { AssistantMessage, CitationRow, ClaudeHeader } from "./AssistantMessage";
import { AttachmentChip } from "./AttachmentChip";
import { ExecutedRow } from "./ExecutedRow";
import type { Ev, FlowItem } from "./flow";
import { clock, usePersonName } from "./parts";
import { PageActionRow } from "./PageActionRow";
import { PhaseDivider } from "./PhaseDivider";
import { PlanCard } from "./PlanCard";
import { useServerFixPlan } from "./serverFixPlan";
import { ProposalCard } from "./ProposalCard";
import { QuestionCard } from "./QuestionCard";
import { WorkResultRow } from "./WorkResultRow";

/** Lo stato di consegna di un messaggio come lo vede chi l'ha scritto. */
export type DeliveryView =
  | { kind: "pending" }
  | { kind: "delivered" }
  | { kind: "undelivered"; reason: string | null }
  | null;

/**
 * Un messaggio di una persona: riga «Giulia Ferri · 10:41» e il testo su
 * una fascia a tinta d'inchiostro 5%; sotto, gli allegati e (a chi l'ha
 * scritto) lo stato di consegna con «Resend».
 */
export function UserMessage({
  authorId,
  at,
  text,
  attachments,
  delivery,
  onResend,
  context,
}: {
  authorId: string;
  at: string | null;
  text: string;
  attachments: readonly Attachment[];
  delivery: DeliveryView;
  onResend?: () => void;
  /** Area 10a: la pagina da cui è partito (il chip del riquadro), riletta per chi guarda. */
  context?: ContextRef | null | undefined;
}) {
  const { t, i18n } = useTranslation();
  const name = usePersonName(authorId);
  return (
    <div className="event-enter flex min-w-0 flex-col gap-1.5 pt-2" data-user-message>
      <p className="flex min-w-0 items-center gap-1.5 text-xs text-ink-muted">
        <span className="shrink-0 font-semibold text-ink">{name}</span>
        {at && (
          <>
            <span aria-hidden="true">·</span>
            <time className="num shrink-0" dateTime={at}>
              {clock(at, i18n.language)}
            </time>
          </>
        )}
        {context && <ContextNote context={context} />}
      </p>
      {text && (
        <p className="min-w-0 rounded-md bg-ink/5 px-3 py-2 text-md whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">
          {text}
        </p>
      )}
      {attachments.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {attachments.map((a) => (
            <li key={a.id} className="min-w-0">
              <AttachmentChip attachment={a} />
            </li>
          ))}
        </ul>
      )}
      {delivery && (
        <p
          className={`text-xs ${delivery.kind === "undelivered" ? "text-critical" : "text-ink-muted"}`}
          data-delivery={delivery.kind}
        >
          {delivery.kind === "pending" && t("claude.conversation.delivery.pending")}
          {delivery.kind === "delivered" && t("claude.conversation.delivery.delivered")}
          {delivery.kind === "undelivered" && (
            <>
              {delivery.reason
                ? t("claude.conversation.delivery.undeliveredWith", { reason: delivery.reason })
                : t("claude.conversation.delivery.undelivered")}
              {onResend && (
                <>
                  {" · "}
                  <button
                    type="button"
                    onClick={onResend}
                    className="font-semibold text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
                  >
                    {t("claude.conversation.delivery.resend")}
                  </button>
                </>
              )}
            </>
          )}
        </p>
      )}
    </div>
  );
}

/** Il flusso disegnato: una riga per ogni `FlowItem`, in ordine. */
export function EventList({
  items,
  detail,
  viewerId,
  compact,
  projectCode,
  deliveryOf,
  onResend,
}: {
  items: readonly FlowItem[];
  detail: ConversationDetail;
  viewerId: string;
  compact: boolean;
  projectCode: string | null;
  deliveryOf: (event: Ev<"user">) => DeliveryView;
  onResend: (event: Ev<"user">) => void;
}) {
  const working = detail.state === "working";
  // Area 10a: lo stato di «Annulla» per chi guarda; facoltativo (P25).
  const undo = detail.undo ?? {};
  const reauthPhrases = detail.reauthPhrases ?? {};
  const viewerName = usePersonName(viewerId);
  // I comandi su un server (correzione o analisi) sono righe del registro.
  const serverCode = detail.serverFix?.serverCode ?? detail.serverAnalysis?.serverCode ?? null;
  const fixPlan = useServerFixPlan(detail, projectCode);
  const lastAssistant = [...items].reverse().find((i) => i.kind === "assistant")?.key;
  // La fase in corso: l'ultima aperta, se la conversazione sta lavorando.
  const lastPhase = [...items].reverse().find((i) => i.kind === "phase");
  const livePhase =
    working && lastPhase?.kind === "phase" && lastPhase.event.outcome === null
      ? lastPhase.key
      : null;

  return (
    <ol className="flex min-w-0 flex-col gap-2.5" aria-label={detail.title}>
      {items.map((item) => (
        <li key={item.key} className="min-w-0" data-flow={item.kind}>
          {(() => {
            switch (item.kind) {
              case "user":
                return (
                  <UserMessage
                    authorId={item.event.authorId}
                    at={item.event.at}
                    text={item.event.text}
                    attachments={item.event.attachments}
                    context={item.event.context}
                    delivery={item.event.authorId === viewerId ? deliveryOf(item.event) : null}
                    {...(detail.canWrite && item.event.authorId === viewerId
                      ? { onResend: () => onResend(item.event) }
                      : {})}
                  />
                );
              case "claude":
                return <ClaudeHeader at={item.at} compact={compact} />;
              case "assistant":
                return (
                  <AssistantMessage item={item} streaming={working && item.key === lastAssistant} />
                );
              case "actions":
                return item.actions.every(isServerCommand) ? (
                  <CommandRows actions={item.actions} serverCode={serverCode} />
                ) : (
                  <ActionRows actions={item.actions} compact={compact} />
                );
              case "citation":
                return <CitationRow item={item} />;
              case "phase":
                return <PhaseDivider item={item} live={item.key === livePhase} />;
              case "question":
                return (
                  <QuestionCard
                    conversationId={detail.id}
                    event={item.event}
                    canAnswer={detail.canAnswer && item.event.answer === null}
                    ownerId={detail.ownerId}
                    projectCode={projectCode}
                  />
                );
              case "plan":
                return (
                  <PlanCard
                    conversationId={detail.id}
                    event={item.event}
                    canDecidePlan={detail.canDecidePlan && item.event.status === "pending"}
                    projectCode={projectCode}
                    serverFix={fixPlan}
                  />
                );
              case "proposal":
                return (
                  <ProposalCard
                    conversationId={detail.id}
                    event={item.event}
                    viewerId={viewerId}
                    undo={item.event.groupId ? undo[item.event.groupId] : undefined}
                    reauthPhrases={reauthPhrases[item.event.proposalId]}
                  />
                );
              case "executed":
                return (
                  <ExecutedRow
                    conversationId={detail.id}
                    event={item.event}
                    undo={undo[item.event.groupId]}
                    viewerId={viewerId}
                    ownerId={detail.ownerId}
                    viewerName={viewerName}
                  />
                );
              case "pageAction":
                return (
                  <PageActionRow
                    conversationId={detail.id}
                    event={item.event}
                    viewerId={viewerId}
                    ownerId={detail.ownerId}
                  />
                );
              case "work_result":
                return <WorkResultRow event={item.event} />;
            }
          })()}
        </li>
      ))}
    </ol>
  );
}
