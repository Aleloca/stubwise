import type { MailAddress, MailClassification, MailImportance, MailMessage } from "../../types";
import { at } from "../conversations/helpers";
import { GOOGLE_ACCOUNTS } from "../drive";
import { PEOPLE } from "../people";

export { at };

/**
 * L'indirizzo di una persona del team: quello del suo account Google se ce
 * l'ha (le caselle), altrimenti `nome.cognome@example.com`.
 */
export function person(personId: string): MailAddress {
  const p = PEOPLE.find((x) => x.id === personId);
  if (!p) throw new Error(`Unknown person: ${personId}`);
  const account = GOOGLE_ACCOUNTS.find((a) => a.personId === personId);
  const email = account?.email ?? `${p.name.toLowerCase().replace(/\s+/g, ".")}@example.com`;
  return { name: p.name, email, personId };
}

/** Un indirizzo fuori dal team. */
export const ext = (name: string, email: string): MailAddress => ({ name, email, personId: null });

/** Classificata: i progetti (anche nessuno), l'importanza e la scadenza. */
export function done(
  projectIds: string[],
  importance: MailImportance,
  dueDate: string | null = null,
  uncertainProjectIds: string[] = [],
): MailClassification {
  return { state: "done", projectIds, importance, dueDate, uncertainProjectIds };
}

/** Il Message-ID RFC di un messaggio del seme. */
export const rfcId = (local: string, domain = "mail.example"): string => `<${local}@${domain}>`;

type Essentials = Pick<
  MailMessage,
  | "id"
  | "threadId"
  | "from"
  | "to"
  | "subject"
  | "at"
  | "text"
  | "mailboxPersonIds"
  | "classification"
>;

/** Un messaggio con i default del seme (nessuna copia, niente citato, HTML o allegati). */
export function mail(m: Essentials & Partial<MailMessage>): MailMessage {
  return {
    messageId: rfcId(m.id),
    cc: null,
    quoted: null,
    html: null,
    attachments: [],
    readByPersonIds: [],
    kind: "email",
    context: false,
    ...m,
  };
}
