import type { MutableRefObject } from "react";
import { placeDraft } from "../../domain/claude/intents/mailDraft";
import { useFillableField } from "../../layout/claudePanel/fillable";
import type { MailFieldBridge } from "./Composer";

// Il corpo di un'email come campo del riquadro di Claude (area 10b, D1;
// shape `claude-drafts.md` §3.5): lo dichiara la PAGINA — la conversazione
// aperta della propria casella, o l'email nuova — e la casella di scrittura
// lo serve quando c'è (`MailFieldBridge`). A casella chiusa il campo c'è lo
// stesso: mettere la bozza apre «Reply» e la bozza entra appena la casella
// ha letto la sua bozza salvata [DR 6]. Il testo del campo finché la casella
// non c'è è quello della bozza salvata: «Replace or add below?» non copre
// mai un testo già scritto. La Posta mostra solo la propria casella
// (`mailbox_owner`): una conversazione di un altro non arriva mai qui.

export function useMailBodyField({
  threadId,
  ready,
  saved,
  bridge,
  open,
}: {
  threadId: string | null;
  /** Conversazione e bozze lette: prima il campo non si dichiara. */
  ready: boolean;
  /** Il corpo della bozza salvata, finché la casella non è aperta. */
  saved: string;
  bridge: MutableRefObject<MailFieldBridge>;
  /** Apre la casella (Reply) se è chiusa. */
  open: () => void;
}): void {
  const pending = () => {
    const q = bridge.current.queued;
    if (!q) return saved;
    return q.kind === "put" ? placeDraft(saved, q.text, q.how) : q.text;
  };
  useFillableField(
    ready
      ? {
          ref: { kind: "mailBody", threadId },
          labelKey: threadId ? "claude.drafts.placed.mailReply" : "claude.drafts.placed.mailNew",
          get: () => bridge.current.composer?.get() ?? pending(),
          put: (text, how, sources = []) => {
            const composer = bridge.current.composer;
            if (composer) composer.put(text, how, sources);
            else {
              bridge.current.queued = { kind: "put", text, how, sources };
              open();
            }
          },
          restore: (text) => {
            const composer = bridge.current.composer;
            if (composer) composer.restore(text);
            else {
              bridge.current.queued = { kind: "restore", text };
              open();
            }
          },
          focus: () => {
            if (bridge.current.composer) bridge.current.composer.focus();
            else open();
          },
        }
      : null,
  );
}
