import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { placeDraft } from "../../domain/claude/intents/mailDraft";
import {
  MAIL_LIMITS,
  useLoadMailDraft,
  useSaveMailDraft,
  useUndoMailSend,
} from "../../data/queries";
import { onBeforePersonaChange } from "../../data/session";
import type {
  MailAddress,
  MailDraft,
  MailDraftAttachment,
  MailDraftRestore,
  MailSendResult,
} from "../../data/types";
import { hasModKey } from "../../platform/platform";
import { useToast } from "../../tasks-ui/Toast";
import { typing } from "../tasks/useTaskKeys";
import { closeComposer, requestCompose } from "./composeRequest";

// L'avviso dopo «Send» (shape mail-compose §5 [A 12]): «Sending to Monica
// Corsi · Undo» per i 5 s dell'invio — la `Toast` esistente, che dura già
// 5 s — con ⌘Z come scorciatoia finché l'avviso c'è. «Undo» toglie il
// messaggio senza traccia e riapre la casella com'era, col fuoco nel corpo;
// gli allegati che non rientrano (una bozza scritta nel frattempo, R-I9) si
// dicono. Un «Undo» tardivo dice che l'email è partita. Cambiare persona
// spegne l'avviso e il ⌘Z: l'invio resta di chi l'ha fatto.

/** «Monica Corsi», «Monica Corsi and Marco Bellini», «Monica Corsi, Marco Bellini and 3 others». */
export function recipientNames(
  list: readonly MailAddress[],
  t: (key: string, options?: Record<string, unknown>) => string,
  language: string,
): string {
  const names = list.map((a) => a.name || a.email);
  if (names.length <= 2) {
    return new Intl.ListFormat(language, { style: "long", type: "conjunction" }).format(names);
  }
  return t("mail.compose.andOthers", {
    names: names.slice(0, 2).join(", "),
    count: names.length - 2,
  });
}

// Il ⌘Z dell'avviso: uno solo per volta (l'ultimo invio), di modulo perché
// valga anche se la pagina che l'ha aperto non c'è più.
let active: { run: () => void; timer: number } | null = null;
let listening = false;

function clearUndoKey() {
  if (active) window.clearTimeout(active.timer);
  active = null;
}

function onKeyDown(e: KeyboardEvent) {
  if (!active || !hasModKey(e) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "z") return;
  // In un campo ⌘Z è l'annulla del testo.
  if (typing(e.target)) return;
  e.preventDefault();
  const { run } = active;
  clearUndoKey();
  run();
}

function armUndoKey(run: () => void) {
  if (!listening) {
    window.addEventListener("keydown", onKeyDown);
    onBeforePersonaChange(clearUndoKey);
    listening = true;
  }
  clearUndoKey();
  active = { run, timer: window.setTimeout(clearUndoKey, MAIL_LIMITS.undoMs) };
}

/** Il nome dei file rimasti fuori, per l'avviso. */
const namesOf = (list: readonly MailDraftAttachment[]) => list.map((a) => a.name).join(", ");

/** Gli allegati rimasti fuori da una bozza tornata (R-I9): si dicono. */
export function useDroppedNotice() {
  const { t } = useTranslation();
  const toast = useToast();
  return useCallback(
    ({ droppedAttachments }: MailDraftRestore) => {
      if (droppedAttachments.length === 0) return;
      toast.show(
        t("mail.compose.dropped", {
          count: droppedAttachments.length,
          names: namesOf(droppedAttachments),
        }),
      );
    },
    [t, toast],
  );
}

/**
 * «Discard» toglie la bozza senza conferma; l'avviso «Draft discarded ·
 * Undo» la rimette e riapre la casella. Una bozza scritta nel frattempo
 * nella stessa conversazione non si sovrascrive (R-I9): quella tornata ci
 * va sotto, i suoi allegati si aggiungono finché stanno nei limiti.
 */
export function useDiscardedNotice() {
  const { t } = useTranslation();
  const toast = useToast();
  const save = useSaveMailDraft();
  const load = useLoadMailDraft();
  const dropped = useDroppedNotice();
  const saveAsync = save.mutateAsync;
  return useCallback(
    (snapshot: MailDraft) =>
      toast.show(t("mail.compose.discarded"), {
        action: {
          label: t("mail.compose.undo"),
          run: () =>
            void closeComposer(snapshot.threadId)
              .then(() => load(snapshot.threadId, snapshot.mode))
              .then(async (current) => {
                const busy = current.body.trim() !== "" || current.attachments.length > 0;
                const merged = busy
                  ? mergeDrafts(current, snapshot)
                  : { draft: snapshot, droppedAttachments: [] };
                await saveAsync(merged.draft);
                dropped(merged);
                requestCompose({
                  threadId: snapshot.threadId,
                  mode: merged.draft.mode,
                  focus: "body",
                });
              }),
        },
      }),
    [t, toast, load, saveAsync, dropped],
  );
}

/** La bozza tornata sotto quella che c'è (R-I9): destinatari e oggetto restano quelli di adesso. */
function mergeDrafts(current: MailDraft, back: MailDraft): MailDraftRestore {
  const attachments = [...current.attachments];
  const droppedAttachments: MailDraftAttachment[] = [];
  let bytes = attachments.reduce((sum, a) => sum + (a.as === "link" ? 0 : a.sizeBytes), 0);
  for (const a of back.attachments) {
    if (attachments.some((x) => x.id === a.id)) continue;
    const size = a.as === "link" ? 0 : a.sizeBytes;
    if (attachments.length >= MAIL_LIMITS.attachments || bytes + size > MAIL_LIMITS.bytes) {
      droppedAttachments.push(a);
      continue;
    }
    attachments.push(a);
    bytes += size;
  }
  return {
    draft: { ...current, body: placeDraft(current.body, back.body, "below"), attachments },
    droppedAttachments,
  };
}

/**
 * Mostra l'avviso di un invio appena partito (o di un «Retry»). `threadId`
 * `null` = un'email nuova: «Undo» riapre la nuova email.
 */
export function useUndoSendToast() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const undo = useUndoMailSend();
  const navigate = useNavigate();
  const undoAsync = undo.mutateAsync;

  return useCallback(
    (result: MailSendResult, recipients: readonly MailAddress[], newEmail: boolean) => {
      const run = () => {
        clearUndoKey();
        toast.dismiss(id);
        // Una casella riaperta nel frattempo salva prima: la bozza tornata ci si unisce.
        closeComposer(newEmail ? null : result.threadId)
          .then(() => undoAsync(result.messageId))
          .then(
            ({ draft, droppedAttachments }) => {
              requestCompose({ threadId: draft.threadId, mode: draft.mode, focus: "body" });
              if (draft.threadId === null || newEmail) {
                void navigate({
                  to: "/mail",
                  search: (prev: Record<string, unknown>) => ({ ...prev, compose: "new" }),
                } as never);
              } else {
                void navigate({
                  to: "/mail/$threadId",
                  params: { threadId: draft.threadId },
                  search: (prev: Record<string, unknown>) => ({ ...prev, compose: undefined }),
                } as never);
              }
              if (droppedAttachments.length > 0) {
                toast.show(
                  t("mail.compose.dropped", {
                    count: droppedAttachments.length,
                    names: namesOf(droppedAttachments),
                  }),
                );
              }
            },
            (error: unknown) => {
              const tooLate = error instanceof Error && error.message === "too_late";
              if (tooLate) toast.show(t("mail.compose.tooLate"));
              else
                toast.error(
                  t("mail.compose.couldntSend", { reason: t("mail.compose.reason.other") }),
                );
            },
          );
      };
      const id = toast.show(
        t("mail.compose.sendingTo", { names: recipientNames(recipients, t, i18n.language) }),
        { action: { label: t("mail.compose.undo"), run } },
      );
      armUndoKey(run);
    },
    [t, i18n.language, toast, undoAsync, navigate],
  );
}
