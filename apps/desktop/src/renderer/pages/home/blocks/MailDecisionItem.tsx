import { eventDayKey } from "@stubwise/shared";
import { Link, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useDecideMailProposalNow, usePeople, useProjects } from "../../../data/queries";
import { TASK_CODE_RE } from "../../../data/routes";
import type { MailProposalOrigin, MailProposalView } from "../../../data/types";
import { useToast } from "../../../tasks-ui/Toast";
import { dayLabel } from "../../mail/format";
import { MailProposalCard, type MailDecisionKind } from "../../mail/MailProposalCard";
import { deferAnswer } from "../pendingAnswers";
import { useOpenTask } from "./BlockSection";

/**
 * Una proposta della posta in «Da decidere» (shape home.md §8): la riga
 * d'origine («From an email · Elena Rossi · Export CSV: new deadline», «From
 * the meeting …», «From your calendar …») con il link all'email o
 * all'evento, poi la stessa scheda della Posta. Conferma, «Ignore» e «Pass
 * to project» seguono la finestra dell'«Undo» come le altre risposte [A 2]:
 * la voce si chiude subito e la decisione parte allo scadere. Se un collega
 * ha deciso prima, il messaggio dice chi, e nulla nasce due volte (lo
 * garantisce il livello dati: `already_handled`).
 */
export function MailDecisionItem({ view }: { view: MailProposalView }) {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const openTask = useOpenTask();
  const decideNow = useDecideMailProposalNow();
  const people = usePeople().data;
  const project = useProjects().data?.find((p) => p.id === view.proposal.projectId);
  const code = project?.code ?? "";
  const name = (id: string | null | undefined) =>
    people?.find((p) => p.id === id)?.name ?? t("taskUi.stall.someone");

  // L'email nella Posta, dove la scheda dice l'esito per intero (chi non vede
  // l'email — una proposta passata — non ha dove andare).
  const threadId = view.origin && view.origin.kind !== "calendar" ? view.origin.threadId : null;
  const openEmail = threadId
    ? {
        label: t("home.decide.mail.openEmail"),
        run: () => void navigate({ to: "/mail/$threadId", params: { threadId } }),
      }
    : undefined;

  /** Chi è arrivato prima: come l'ha decisa e, se è nato qualcosa, il link. */
  const raced = async (byId: string | null | undefined) => {
    const fresh = await decideNow.read(view.proposal.id).catch(() => null);
    const p = fresh?.proposal;
    const who = fresh?.decidedBy?.name ?? name(byId);
    const status = p?.status;
    const text =
      status === "confirmed" || status === "ignored" || status === "handed"
        ? t(`home.decide.mail.already_${status}`, { name: who })
        : t("home.decide.claude.alreadyDecided", { name: who });
    const born =
      p?.status === "confirmed" ? p.resultCodes.find((c) => TASK_CODE_RE.test(c)) : undefined;
    toast.show(text, {
      action: born
        ? { label: t("home.decide.mail.openCode", { code: born }), run: () => openTask(born) }
        : undefined,
    });
  };

  const onDecide = (kind: MailDecisionKind, send: () => Promise<unknown>) => {
    const done = {
      confirm: t("home.decide.mail.confirmed", { code }),
      ignore: t("home.decide.mail.ignored", { code }),
      hand: t("home.decide.mail.handed", { code }),
    }[kind];
    const cancel = deferAnswer(
      view.proposal.id,
      () =>
        send().then((outcome) => {
          const o = outcome as
            | { status: "confirmed"; resultCodes: string[] }
            | { status: "failed"; error: string }
            | undefined;
          // R-I22: il codice di ciò che è nato si dice dopo la finestra, in un secondo messaggio.
          if (o?.status === "confirmed" && o.resultCodes.length > 0) {
            toast.show(t("home.decide.mail.created", { codes: o.resultCodes.join(", ") }));
          } else if (o?.status === "failed") {
            // Non eseguita (tutto o niente): nulla è nato, l'esito sta nella Posta.
            toast.error(t("home.decide.mail.confirmFailed", { code }), { action: openEmail });
          }
        }),
      (error) => {
        const err = error as (Error & { byId?: string | null }) | null;
        if (err?.message === "already_handled") void raced(err.byId);
        else toast.error(t("home.decide.mail.failed", { code }), { action: openEmail });
      },
    );
    toast.show(done, { action: { label: t("home.decide.undo"), run: cancel } });
  };

  return (
    <div
      data-mail-decision={view.proposal.id}
      className="flex flex-col gap-2 border-b border-rule py-3 pr-3 pl-4"
    >
      {view.origin && <OriginLine origin={view.origin} />}
      <div className="max-w-[72ch]">
        <MailProposalCard
          view={view}
          onDecide={onDecide}
          collapsed
          // In «Da decidere» si legge sempre ciò che Stubwise ha letto; chi non
          // vede l'email (una proposta passata) legge a chi era: chi l'ha passata.
          excerptOpen
          fromEmailTo={
            !view.origin && view.proposal.handedById ? name(view.proposal.handedById) : null
          }
        />
      </div>
    </div>
  );
}

/** «From an email · Elena Rossi · oggetto» e il link all'email o all'evento. */
function OriginLine({ origin }: { origin: MailProposalOrigin }) {
  const { t, i18n } = useTranslation();
  const text =
    origin.kind === "email"
      ? t("home.decide.mail.fromEmail", { name: origin.from, subject: origin.subject })
      : origin.kind === "meeting"
        ? t("home.decide.mail.fromMeeting", {
            title: origin.title,
            date: dayLabel(origin.at, i18n.language),
          })
        : t("home.decide.mail.fromCalendar", { title: origin.title });
  const linkClass =
    "shrink-0 rounded-sm text-xs font-medium text-ink-muted underline decoration-ink/30 underline-offset-2 hover:text-ink hover:decoration-ink";
  return (
    <div className="flex min-w-0 items-baseline gap-3 text-sm text-ink-muted">
      <span title={text} className="min-w-0 truncate">
        {text}
      </span>
      {origin.kind === "calendar" ? (
        <Link
          to="/calendar"
          search={
            {
              view: "day",
              date: eventDayKey(origin),
              event: origin.eventId,
            } as never
          }
          className={linkClass}
        >
          {t("home.decide.mail.openEvent")}
        </Link>
      ) : (
        <Link to="/mail/$threadId" params={{ threadId: origin.threadId }} className={linkClass}>
          {t("home.decide.mail.openEmail")}
        </Link>
      )}
    </div>
  );
}
