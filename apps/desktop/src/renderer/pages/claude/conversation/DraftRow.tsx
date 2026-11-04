import { useRouter } from "@tanstack/react-router";
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  useDescribeContext,
  useMailThread,
  useProjects,
  useSettlePageEvent,
} from "../../../data/queries";
import type { ContextRef, FieldRef } from "../../../data/types";
import {
  answerDraft,
  focusDraftField,
  undoDraft,
  useDraftView,
  wantDraft,
} from "../../../layout/claudePanel/pageActions";
import type { Ev } from "./flow";
import { ClaudeMark } from "../../../components/ClaudeMark";
import { CheckGlyph, primaryButton, secondaryButton, UndoneGlyph, WorkingRing } from "./parts";

// La riga di una bozza (area 10b, Task 10; shape `claude-drafts.md` §3.3):
// la stessa forma della riga eseguita del 10a — segno, verbo al passato,
// dove, a destra «Undo» — senza toast. «Dove» si compone a lettura nella
// lingua di chi guarda, da ciò che chi guarda vede (`describeContext`, il
// thread della propria casella). Chi l'ha chiesta vede lo stato e i bottoni;
// un altro lettore la frase chiusa, e chi non vede l'oggetto del campo
// (`field` `null`) solo «Claude put a draft in a field» (R-G5). Lo stato del
// campo lo sa il riquadro (`useDraftView`): la riga non lo deduce.

const K = "claude.drafts";

/** Il campo come lo dice la frase: la chiave del luogo, i valori, dove porta «Put it in the field». */
interface Where {
  kind:
    | "supportReply"
    | "releaseNotes"
    | "releaseNotesBare"
    | "mailReply"
    | "mailNew"
    | "taskDescription";
  /** Il gruppo per «Replace or add below?» e «com'era». */
  group: "reply" | "notes" | "email" | "description";
  values: { code?: string; number?: number; subject?: string };
  route: string;
}

const contextOfField = (field: FieldRef | null): ContextRef | null => {
  if (!field) return null;
  switch (field.kind) {
    case "supportReply":
      return { kind: "support", conversationId: field.conversationId };
    case "releaseNotes":
      return { kind: "pr", prId: field.prId };
    case "taskDescription":
      return { kind: "task", taskId: field.taskId };
    case "mailBody":
      return null;
  }
};

/** Il luogo della bozza, riletto per chi guarda; `null` finché non si sa (o non si vede). */
function useWhere(field: FieldRef | null): Where | null {
  const described = useDescribeContext(contextOfField(field)).data;
  const thread = useMailThread(field?.kind === "mailBody" ? field.threadId : null).data;
  const projects = useProjects().data;
  if (!field) return null;
  if (field.kind === "mailBody") {
    if (field.threadId === null) {
      return { kind: "mailNew", group: "email", values: {}, route: "/mail?compose=new" };
    }
    return {
      kind: "mailReply",
      group: "reply",
      values: { subject: thread?.subject ?? "" },
      route: `/mail/${field.threadId}`,
    };
  }
  if (!described?.code) return null;
  const projectCode = projects?.find((p) => p.id === described.projectId)?.code;
  switch (field.kind) {
    case "supportReply":
      return projectCode
        ? {
            kind: "supportReply",
            group: "reply",
            values: { code: described.code },
            route: `/p/${projectCode}/support/${described.code}`,
          }
        : null;
    case "releaseNotes": {
      const number = described.params?.number;
      return {
        kind: typeof number === "number" ? "releaseNotes" : "releaseNotesBare",
        group: "notes",
        values: { code: described.code, ...(typeof number === "number" ? { number } : {}) },
        route: `/p/${described.code}/releases?pr=${field.prId}`,
      };
    }
    case "taskDescription":
      return projectCode
        ? {
            kind: "taskDescription",
            group: "description",
            values: { code: described.code },
            route: `/p/${projectCode}/tasks?task=${described.code}`,
          }
        : null;
  }
}

/** Il «a»/«ad» italiano davanti al codice: lo sceglie la frase (contesto `vowel`). */
const vowel = (code: string | undefined) => (code && /^[AEIOU]/i.test(code) ? "vowel" : undefined);

function Phrase({ state, where }: { state: "pending" | "placed" | "waiting"; where: Where }) {
  return (
    <Trans
      i18nKey={`${K}.${state}.${where.kind}`}
      values={where.values}
      context={vowel(where.values.code)}
      components={{ obj: <span className="num font-semibold text-ink" /> }}
    />
  );
}

const linkButton =
  "rounded-sm font-medium text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink";

/** La riga che chiede prima di scrivere sopra il testo della persona (§3.2). */
function AskRow({
  where,
  onAnswer,
}: {
  where: Where;
  onAnswer: (how: "replace" | "below") => void;
}) {
  const { t } = useTranslation();
  const question = t(`${K}.ask.${where.group}`);
  return (
    <div
      role="group"
      aria-label={question}
      className="flex min-w-0 flex-wrap items-center gap-2 py-1 text-md text-ink"
    >
      <p className="min-w-0 flex-[1_1_14rem] [overflow-wrap:anywhere]">{question}</p>
      <span className="ml-auto inline-flex items-center gap-2">
        <button type="button" className={secondaryButton} onClick={() => onAnswer("below")}>
          {t(`${K}.addBelow`)}
        </button>
        <button type="button" className={primaryButton} onClick={() => onAnswer("replace")}>
          {t(`${K}.replace`)}
        </button>
      </span>
    </div>
  );
}

/** Il testo di una bozza che aspetta, chiuso a 4 righe (§3.3, [DR 4]). */
function DraftText({ text }: { text: string }) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const id = useId();
  const long = text.split("\n").length > 4 || text.length > 280;
  return (
    <div className="flex min-w-0 flex-col items-start gap-1 pl-6">
      <p
        id={id}
        aria-label={t(`${K}.text`)}
        className={`max-w-[68ch] border-l border-rule pl-3 text-sm whitespace-pre-wrap text-ink [overflow-wrap:anywhere] ${all ? "" : "line-clamp-4"}`}
      >
        {text}
      </p>
      {long && (
        <button
          type="button"
          aria-expanded={all}
          aria-controls={id}
          className={`${linkButton} ml-3 text-sm`}
          onClick={() => setAll((v) => !v)}
        >
          {all ? t(`${K}.showLess`) : t(`${K}.showAll`)}
        </button>
      )}
    </div>
  );
}

export function DraftRow({
  conversationId,
  event,
  viewerId,
  ownerId,
}: {
  conversationId: string;
  event: Ev<"draft">;
  viewerId: string;
  /** Chi ha aperto la conversazione: solo lui vede lo stato e i bottoni. */
  ownerId: string;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const mine = viewerId === ownerId;
  const where = useWhere(event.field);
  const view = useDraftView(event.id, event.field);
  const settle = useSettlePageEvent();
  const statusRef = useRef<HTMLSpanElement>(null);
  const [focusTick, setFocusTick] = useState(0);

  // Dopo un clic il bottone sparisce: il fuoco va sul testo nuovo, mai sul body.
  useLayoutEffect(() => {
    if (focusTick > 0) statusRef.current?.focus();
  }, [focusTick]);

  // Chi non vede l'oggetto del campo (o la casella non è sua): né codice, né testo, né stato.
  if (!event.field) {
    return (
      <p
        data-draft-row
        className="event-enter flex min-h-8 min-w-0 items-start gap-2 py-1 text-md text-ink"
      >
        <span className="mt-[3px]" aria-hidden="true">
          <CheckGlyph />
        </span>
        <span className="min-w-0">{t(`${K}.other`)}</span>
      </p>
    );
  }
  if (!where) return <p data-draft-row className="min-h-8" aria-busy="true" />;

  const field = event.field;
  const asking = mine && view.stage === "asking";
  // Il testo è già nel campo (lo dice la memoria del riquadro) mentre
  // l'evento si sta chiudendo: la riga dice già `placed`.
  const status =
    mine && view.stage === "placed" && (event.status === "pending" || event.status === "waiting")
      ? "placed"
      : event.status;
  const answer = (how: "replace" | "below") => {
    answerDraft(event.id, how);
    setFocusTick((n) => n + 1);
  };
  const putInField = () => {
    wantDraft(conversationId, event, settle.mutateAsync);
    if (!view.fieldOpen) void router.navigate({ href: where.route });
  };
  const show = () => {
    if (!focusDraftField(field)) void router.navigate({ href: where.route });
  };

  // In attesa del riquadro, o della scelta della persona.
  if (status === "pending") {
    if (asking) {
      return (
        <div data-draft-row className="event-enter flex min-w-0 flex-col">
          <AskRow where={where} onAnswer={answer} />
        </div>
      );
    }
    return (
      <p
        data-draft-row
        className="event-enter flex min-h-8 min-w-0 items-start gap-2 py-1 text-md text-ink-muted [overflow-wrap:anywhere]"
      >
        <span className="mt-[5px]">
          <WorkingRing />
        </span>
        <span className="min-w-0">
          <Phrase state="pending" where={where} />
        </span>
      </p>
    );
  }

  if (status === "waiting") {
    return (
      <div data-draft-row className="event-enter flex min-w-0 flex-col gap-1">
        {asking ? (
          <AskRow where={where} onAnswer={answer} />
        ) : (
          <p className="flex min-h-8 min-w-0 flex-wrap items-start gap-x-2 py-1 text-md text-ink [overflow-wrap:anywhere]">
            {/* L'anello fermo: la bozza è fatta, aspetta solo il suo campo ([CT 2]). */}
            <span className="mt-[5px] inline-flex">
              <ClaudeMark />
            </span>
            <span className="min-w-0 flex-1">
              <Phrase state="waiting" where={where} />
              {mine && (
                <span className="text-ink-muted">
                  {" · "}
                  <button type="button" className={linkButton} onClick={putInField}>
                    {t(`${K}.put`)}
                  </button>
                </span>
              )}
            </span>
          </p>
        )}
        {mine && <DraftText text={event.text} />}
      </div>
    );
  }

  const outcome =
    status === "undone" || view.outcome === "undone"
      ? "undone"
      : status === "changed_after" || view.outcome === "changed_after"
        ? "changed_after"
        : view.stage === "placed"
          ? "available"
          : "gone";

  function undo() {
    const result = undoDraft(event.id);
    setFocusTick((n) => n + 1);
    // Un secondo clic (o nessun testo di prima) non scrive niente.
    if (result === "not_undoable") return;
    settle.mutate({ id: conversationId, eventId: event.id, status: result });
  }

  const state = ((): ReactNode => {
    switch (outcome) {
      case "available":
        // «Undo» solo a pagina aperta: fuori, il campo non si può rileggere.
        return view.fieldOpen ? (
          <button
            type="button"
            onClick={undo}
            className="inline-flex h-7 shrink-0 items-center rounded-md px-2 text-sm font-semibold text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 active:bg-ink/10"
          >
            {t("claude.conversation.undo.undo")}
          </button>
        ) : null;
      case "undone":
        return (
          <span className="inline-flex items-center gap-1 text-ink-muted">
            <UndoneGlyph size={14} />
            {t(`${K}.undone.${where.group}`)}
          </span>
        );
      case "changed_after":
        return <span className="text-ink-muted">{t(`${K}.changedAfter`)}</span>;
      case "gone":
        return <span className="text-ink-muted">{t(`${K}.gone`)}</span>;
    }
  })();

  return (
    <div className="event-enter flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1" data-draft-row>
      <p className="flex min-h-8 min-w-0 flex-[1_1_16rem] items-start gap-2 py-1 text-md text-ink [overflow-wrap:anywhere]">
        <span className="mt-[3px]" aria-hidden="true">
          <CheckGlyph />
        </span>
        <span className="min-w-0">
          <Phrase state="placed" where={where} />
          {mine && outcome === "available" && (
            <span className="text-ink-muted">
              {" · "}
              <button type="button" className={linkButton} onClick={show}>
                {t(`${K}.show`)}
              </button>
            </span>
          )}
        </span>
      </p>
      {mine && (
        <span
          ref={statusRef}
          tabIndex={-1}
          aria-live="polite"
          data-undo={outcome}
          className="ml-auto inline-flex min-h-8 min-w-0 max-w-full items-center justify-end rounded-sm text-sm outline-offset-2 focus-visible:outline-2 focus-visible:outline-focus"
        >
          {state}
        </span>
      )}
    </div>
  );
}
