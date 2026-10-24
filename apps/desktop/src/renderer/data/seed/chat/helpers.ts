import type {
  Attachment,
  ChatEventKind,
  ChatMessage,
  CitationRef,
  ConversationEvent,
} from "../../types";
import type { Draft } from "../conversations/helpers";
import { CLAUDE_ID } from "../people";

export { at, done, says } from "../conversations/helpers";

/**
 * Un messaggio del seme, scritto come si legge: chi, quando, cosa. Le
 * risposte del thread stanno dentro la radice; gli id li dà `channelFlow`,
 * in ordine (`<canale>-m<n>`, le risposte `<canale>-m<n>-r<k>`).
 */
export interface Spec {
  /** Id della persona; per un messaggio di sistema usa `system`, per Claude `claude`. */
  by: string;
  at: string;
  text?: string;
  cites?: CitationRef[];
  files?: Attachment[];
  /** Emoji → chi ha reagito. */
  react?: [string, string[]][];
  /** A chi il messaggio chiede una risposta. */
  asks?: string[];
  edited?: string;
  deleted?: { at: string; by: string };
  linked?: string[];
  /** Solo una risposta: «Rispondi anche nel canale». */
  also?: boolean;
  event?: { kind: ChatEventKind; ref: CitationRef };
  /** Solo una risposta di Claude: chi l'ha chiamato e le righe del flusso (senza id). */
  claude?: { calledBy: string; events: Draft[] };
  replies?: Spec[];
}

/** Un messaggio di una persona. */
export function say(by: string, at: string, text: string, extra: Partial<Spec> = {}): Spec {
  return { by, at, text, ...extra };
}

/** Un messaggio di sistema: l'evento di progetto con la scheda dell'oggetto. */
export function sys(at: string, kind: ChatEventKind, ref: CitationRef, text: string): Spec {
  return { by: "system", at, text, event: { kind, ref } };
}

/** Un allegato: un'immagine se il nome finisce come un'immagine. */
export function file(id: string, name: string, sizeBytes: number): Attachment {
  return { id, name, sizeBytes, kind: /\.(png|jpe?g|gif|webp)$/i.test(name) ? "image" : "file" };
}

export const task = (id: string): CitationRef => ({ kind: "task", id });
export const request = (id: string): CitationRef => ({ kind: "request", id });
export const doc = (id: string): CitationRef => ({ kind: "doc", id });
export const repoFile = (id: string): CitationRef => ({ kind: "file", id });
export const project = (id: string): CitationRef => ({ kind: "project", id });

function build(channelId: string, id: string, threadOf: string | null, s: Spec): ChatMessage {
  const deleted = s.deleted ?? null;
  const kind = s.event ? "system" : s.claude ? "claude" : "person";
  const message: ChatMessage = {
    id,
    channelId,
    threadOf,
    authorId: kind === "system" ? null : kind === "claude" ? CLAUDE_ID : s.by,
    kind,
    // Eliminato: il testo sparisce ovunque, con allegati e citazioni.
    text: deleted ? "" : (s.text ?? ""),
    attachments: deleted ? [] : (s.files ?? []),
    citations: deleted ? [] : (s.cites ?? []),
    reactions: deleted ? [] : (s.react ?? []).map(([emoji, personIds]) => ({ emoji, personIds })),
    asksReplyOf: deleted ? [] : (s.asks ?? []),
    linkedCodes: s.linked ?? [],
    createdAt: s.at,
    editedAt: s.edited ?? null,
    deletedAt: deleted?.at ?? null,
    deletedById: deleted?.by ?? null,
  };
  if (s.event) message.event = s.event;
  if (s.also) message.alsoInChannel = true;
  if (s.claude) {
    message.calledById = s.claude.calledBy;
    message.claudeEvents = s.claude.events.map(
      (e, i) => ({ ...e, id: `${id}-e${i + 1}` }) as ConversationEvent,
    );
  }
  return message;
}

/** I messaggi di un canale, radici e risposte, nell'ordine in cui sono scritti. */
export function channelFlow(channelId: string, specs: Spec[]): ChatMessage[] {
  return specs.flatMap((root, i) => {
    const rootId = `${channelId}-m${i + 1}`;
    return [
      build(channelId, rootId, null, root),
      ...(root.replies ?? []).map((r, k) => build(channelId, `${rootId}-r${k + 1}`, rootId, r)),
    ];
  });
}
