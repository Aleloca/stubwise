import { fold } from "../../pages/chat/search";
import { state } from "../store";
import type { MailClassification, MailImportance, MailMessage } from "../types";
import { stubwiseRecipients } from "./visibility";

// La classificazione finta della Posta (area 6): nel prototipo il «modello»
// è un elenco di parole chiave sul seme, deterministico. Nessun filtro prima
// (domini, regole per progetto): ogni email ci passa, salvo le caselle con
// le proposte spente, che la lasciano `off` senza chiamarla. Qui si decide
// solo l'esito; le proposte le scrive il Task 3.

type Members = (projectId: string) => string[];

const projectMembers: Members = (projectId) => state.projectsById.get(projectId)?.memberIds ?? [];

/** Le parole che legano un'email a un progetto del seme. */
const PROJECT_KEYWORDS: Record<string, string[]> = {
  "prj-aud": ["audin", "billing", "callback", "dialer", "vat"],
  "prj-stw": ["stubwise", "desktop preview", "onboarding", "release notes", "copy freeze"],
  "prj-mkx": ["mix cucine", "ordine", "listini", "rivenditori"],
};

/** Posta automatica: niente progetto, importanza bassa. */
const NOISE_SENDERS = ["newsletter", "noreply", "no-reply", "promo", "hello@"];
const NOISE_WORDS = ["unsubscribe", "newsletter"];

const HIGH_WORDS = ["urgent", "asap", "by monday", "tomorrow", "freeze", "deadline"];
const LOW_WORDS = ["nothing urgent", "fyi", "just for reference"];

/**
 * I progetti candidati: quelli di cui almeno un destinatario del team
 * (mittente, `to`, `cc`, caselle) è membro. In ordine di progetto.
 */
export function candidateProjects(m: MailMessage, members: Members = projectMembers): string[] {
  const people = stubwiseRecipients(m);
  return state.projects
    .map((p) => p.id)
    .filter((id) => members(id).some((personId) => people.has(personId)));
}

/** Il giorno dopo quello del messaggio (ISO), per «domani». */
function dayAfter(at: string): string {
  const d = new Date(`${at.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * L'esito del modello finto su un'email: i progetti fra i candidati le cui
 * parole compaiono (uno → quello; più di uno → incerta, nessun progetto e i
 * candidati trovati in `uncertainProjectIds`), l'importanza e la scadenza
 * («tomorrow» → il giorno dopo l'email). Newsletter e posta automatica:
 * nessun progetto, bassa.
 */
export function classifyMessage(m: MailMessage, members: Members): MailClassification {
  const text = fold(`${m.subject}\n${m.text}`);
  const sender = fold(m.from.email);
  const noise =
    NOISE_SENDERS.some((w) => sender.includes(w)) || NOISE_WORDS.some((w) => text.includes(w));
  if (noise)
    return {
      state: "done",
      projectIds: [],
      importance: "low",
      dueDate: null,
      uncertainProjectIds: [],
    };
  const matched = candidateProjects(m, members).filter((id) =>
    (PROJECT_KEYWORDS[id] ?? []).some((w) => text.includes(w)),
  );
  const importance: MailImportance = HIGH_WORDS.some((w) => text.includes(w))
    ? "high"
    : LOW_WORDS.some((w) => text.includes(w))
      ? "low"
      : "normal";
  return {
    state: "done",
    projectIds: matched.length === 1 ? matched : [],
    importance,
    dueDate: text.includes("tomorrow") ? dayAfter(m.at) : null,
    uncertainProjectIds: matched.length > 1 ? matched : [],
  };
}
