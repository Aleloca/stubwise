import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { MAIL_LIMITS, useRestoreDiscardedMailDraft, useUndoMailSend } from "../../data/queries";
import { onBeforePersonaChange } from "../../data/session";
import type {
  MailAddress,
  MailDraft,
  MailDraftAttachment,
  MailDraftRestore,
  MailSendResult,
} from "../../data/types";
import { hasModKey } from "../../platform/platform";
import { isToastShown, onToastsChange, useToast } from "../../tasks-ui/Toast";
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
// valga anche se la pagina che l'ha aperto non c'è più. Vive quanto il suo
// avviso: chiuso (×), scaduto o spinto fuori da altri, il ⌘Z si spegne.
let active: { run: () => void; toastId: number; timer: number } | null = null;
let listening = false;

function clearUndoKey() {
  if (active) window.clearTimeout(active.timer);
  active = null;
}

function onKeyDown(e: KeyboardEvent) {
  if (!active || !hasModKey(e) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "z") return;
  // In un campo ⌘Z è l'annulla del testo; in un dialogo o un menu i tasti sono loro.
  if (typing(e.target)) return;
  const focus = document.activeElement;
  if (focus instanceof Element && focus.closest('[aria-modal="true"], [role="menu"]')) return;
  if (e.target instanceof Element && e.target.closest('[aria-modal="true"], [role="menu"]')) return;
  e.preventDefault();
  const { run } = active;
  clearUndoKey();
  run();
}

function armUndoKey(run: () => void, toastId: number) {
  if (!listening) {
    window.addEventListener("keydown", onKeyDown);
    onBeforePersonaChange(clearUndoKey);
    onToastsChange(() => {
      if (active && !isToastShown(active.toastId)) clearUndoKey();
    });
    listening = true;
  }
  clearUndoKey();
  active = { run, toastId, timer: window.setTimeout(clearUndoKey, MAIL_LIMITS.undoMs) };
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
 * Riapre la casella di una bozza tornata: la conversazione (o la nuova
 * email) si apre e prende la richiesta subito — nessuna richiesta resta in
 * attesa per dopo.
 */
function useReopen() {
  const navigate = useNavigate();
  return useCallback(
    (draft: Pick<MailDraft, "threadId" | "mode" | "slot">) => {
      requestCompose({
        threadId: draft.threadId,
        mode: draft.mode,
        focus: "body",
        ...(draft.slot ? { slot: draft.slot } : {}),
      });
      if (draft.threadId === null) {
        void navigate({
          to: "/mail",
          search: (prev: Record<string, unknown>) => ({ ...prev, compose: draft.slot ?? "new" }),
        } as never);
      } else {
        void navigate({
          to: "/mail/$threadId",
          params: { threadId: draft.threadId },
          search: (prev: Record<string, unknown>) => ({ ...prev, compose: undefined }),
        } as never);
      }
    },
    [navigate],
  );
}

/**
 * «Discard» toglie la bozza senza conferma; l'avviso «Draft discarded ·
 * Undo» la rimette (`restoreDiscardedDraft`, le stesse regole di «Annulla»
 * un invio: una bozza scritta nel frattempo non si sovrascrive, R-I9) e
 * riapre la casella.
 */
export function useDiscardedNotice() {
  const { t } = useTranslation();
  const toast = useToast();
  const restore = useRestoreDiscardedMailDraft();
  const dropped = useDroppedNotice();
  const reopen = useReopen();
  const restoreAsync = restore.mutateAsync;
  return useCallback(
    (snapshot: MailDraft) =>
      toast.show(t("mail.compose.discarded"), {
        action: {
          label: t("mail.compose.undo"),
          run: () =>
            void closeComposer(snapshot.threadId, snapshot.slot)
              .then(() => restoreAsync(snapshot))
              .then((restored) => {
                dropped(restored);
                reopen(restored.draft);
              })
              .catch(() => toast.error(t("mail.compose.restoreFailed"))),
        },
      }),
    [t, toast, restoreAsync, dropped, reopen],
  );
}

/**
 * Mostra l'avviso di un invio appena partito (o di un «Retry»). `newEmail`:
 * «Undo» riapre la nuova email.
 */
export function useUndoSendToast() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const undo = useUndoMailSend();
  const dropped = useDroppedNotice();
  const reopen = useReopen();
  const undoAsync = undo.mutateAsync;

  return useCallback(
    (result: MailSendResult, recipients: readonly MailAddress[], newEmail: boolean) => {
      const run = () => {
        clearUndoKey();
        toast.dismiss(id);
        // Una casella riaperta nel frattempo salva prima: la bozza tornata ci
        // si unisce. Un'email nuova partita da uno slot (R-K14) chiude quella.
        closeComposer(newEmail ? null : result.threadId, newEmail ? result.slot : undefined)
          .then(() => undoAsync(result.messageId))
          .then(
            (restored) => {
              reopen(restored.draft);
              dropped(restored);
            },
            (error: unknown) => {
              const tooLate = error instanceof Error && error.message === "too_late";
              if (tooLate) toast.show(t("mail.compose.tooLate"));
              // Non sappiamo se è partita: lo diciamo, senza fingere che sia ferma.
              else toast.error(t("mail.compose.undoFailed"));
            },
          );
      };
      const id = toast.show(
        t("mail.compose.sendingTo", { names: recipientNames(recipients, t, i18n.language) }),
        { action: { label: t("mail.compose.undo"), run } },
      );
      armUndoKey(run, id);
    },
    [t, i18n.language, toast, undoAsync, reopen, dropped],
  );
}
