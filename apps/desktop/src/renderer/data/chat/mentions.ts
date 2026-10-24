import { DEPARTMENTS } from "../seed/departments";
import { PEOPLE } from "../seed/people";
import type { ChatMessage } from "../types";
import { isHuman } from "./visibility";

// Le menzioni nel testo di un messaggio, nella forma che scrive la casella:
// `@Nome Cognome` (persona), `@<Reparto>` (i membri del canale di quel
// reparto), `@channel` (tutti i membri del canale), `@Claude` (una chiamata,
// non una persona). Una menzione finisce dove finisce il nome: `@Marco
// Bellini,` sì, `@Marco Bellinis` no.

const patterns = new Map<string, RegExp>();

function pattern(name: string): RegExp {
  let re = patterns.get(name);
  if (!re) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(`@${escaped}(?![\\p{L}\\p{N}_])`, "u");
    patterns.set(name, re);
  }
  return re;
}

/** Il testo nomina `@<name>`. */
export const mentionsName = (text: string, name: string): boolean => pattern(name).test(text);

/** Il testo chiama Claude («@Claude»). */
export const callsClaude = (text: string): boolean => mentionsName(text, "Claude");

/** Le persone nominate direttamente (`@Nome Cognome`), Claude escluso. */
export function directMentionIds(text: string): string[] {
  return PEOPLE.filter((p) => isHuman(p.id) && mentionsName(text, p.name)).map((p) => p.id);
}

/**
 * Le persone a cui il messaggio chiede una risposta: quelle nominate
 * direttamente, se il testo finisce con «?» o la casella lo forza («Ask for
 * a reply»). Mai chi scrive.
 */
export function questionTargets(text: string, authorId: string, forced = false): string[] {
  if (!forced && !/\?\s*$/.test(text.trim())) return [];
  return directMentionIds(text).filter((id) => id !== authorId);
}

/**
 * Come il messaggio riguarda una persona: `direct` (nominata, o il messaggio
 * le chiede una risposta), `group` (`@channel` o il suo reparto, solo se è
 * nel canale) o `null`. Mai i messaggi di sistema, quelli eliminati o i
 * propri.
 */
export function mentionKindFor(
  m: ChatMessage,
  personId: string,
  memberIds: readonly string[],
): "direct" | "group" | null {
  if (m.kind === "system" || m.deletedAt !== null || m.authorId === personId) return null;
  const person = PEOPLE.find((p) => p.id === personId);
  if (!person) return null;
  if (m.asksReplyOf.includes(personId) || mentionsName(m.text, person.name)) return "direct";
  if (!memberIds.includes(personId)) return null;
  if (mentionsName(m.text, "channel")) return "group";
  const departments = DEPARTMENTS.filter((d) => person.departmentIds.includes(d.id));
  return departments.some((d) => mentionsName(m.text, d.name)) ? "group" : null;
}
