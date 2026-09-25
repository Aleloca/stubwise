/**
 * LE RISPOSTE FINTE DI WISEY («Wisey, anteprima nell'app», 25 set 2026,
 * design §6). Wisey è un'anteprima: recita tutte le fasi, ma dice cosa FARÀ
 * e dove si fa oggi — non inventa dati su progetti veri, e nessuna risposta
 * nomina un ticket, un progetto o un numero.
 *
 * Dalla domanda si ricava un GRUPPO per parole chiave, in inglese e in
 * italiano. Le parole si cercano INTERE (`pr` non deve scattare dentro
 * «project» o «approva»), e l'ordine dei gruppi è una precedenza: le
 * richieste prima, poi le domande, il saluto per ultimo — «ciao, crea una
 * voce di backlog» è una richiesta di backlog, non un saluto.
 */

export type WiseyReplyGroup = "backlog" | "ticket" | "pr" | "mail" | "inbox" | "status" | "greeting" | "generic";

export interface WiseyReply {
  /**
   * `action` quando la domanda chiede di FARE qualcosa: la schermata ci
   * mette in mezzo la fase «sta lavorando». `answer` per tutto il resto.
   */
  kind: "answer" | "action";
  group: WiseyReplyGroup;
  /** La chiave i18n del testo, `mobile.wisey.replies.<gruppo>`. */
  textKey: string;
}

const GROUPS: { group: Exclude<WiseyReplyGroup, "generic">; kind: WiseyReply["kind"]; words: string[] }[] = [
  { group: "backlog", kind: "action", words: ["backlog", "idea", "ideas", "idee", "voce", "voci"] },
  { group: "ticket", kind: "action", words: ["ticket", "tickets", "fix", "bug", "bugs", "run", "lancia", "esegui", "correggi"] },
  { group: "pr", kind: "answer", words: ["pr", "prs", "pull request", "merge", "mergia", "mergiare", "release", "rilascio"] },
  { group: "mail", kind: "answer", words: ["mail", "mails", "email", "emails", "posta", "casella", "mailbox"] },
  { group: "inbox", kind: "answer", words: ["waiting", "wait", "pending", "aspetta", "aspettano", "attesa", "inbox", "notifiche", "notifications"] },
  { group: "status", kind: "answer", words: ["status", "stato", "doing", "going", "progress", "andamento", "come va", "come sta", "project", "progetto"] },
  { group: "greeting", kind: "answer", words: ["hi", "hello", "hey", "ciao", "buongiorno", "buonasera", "salve"] },
];

/** Una parola (o frase) intera: nessuna lettera o cifra subito prima o dopo. */
function containsWord(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "u").test(text);
}

export function mockReply(question: string): WiseyReply {
  const text = question.toLowerCase();
  for (const { group, kind, words } of GROUPS) {
    if (words.some((word) => containsWord(text, word))) {
      return { kind, group, textKey: `mobile.wisey.replies.${group}` };
    }
  }
  return { kind: "answer", group: "generic", textKey: "mobile.wisey.replies.generic" };
}
