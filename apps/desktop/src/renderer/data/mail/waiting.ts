import { sees } from "../access";
import { gate, now, state } from "../store";
import type { MailImportance, MailMessage } from "../types";

// «Clienti in attesa» dalla posta delle caselle (area 8, piano di 72, W-3 =
// a, W-4 = b; `GET /api/me/waiting-customers` sul server). Per ognuna delle
// MIE caselle, un thread è un candidato quando:
// (a) è ammesso — un suo messaggio non di contesto — e attribuito a un
//     progetto che vedo (da un suo messaggio classificato; l'ultimo può non
//     esserlo, con le proposte spente: W-3 = a);
// (b) c'è un ultimo messaggio ESTERNO (né una casella collegata dell'istanza);
// (c) di più di 24 ore fa — l'attesa e il cliente vengono da lì;
// (d) dopo, nessun mio messaggio partito (un collega con casella non esclude:
//     la sua risposta, parziale o completa, la giudica Claude);
// (e) non è rumore: l'equivalente di `ignored` (classificato senza progetti)
//     senza importanza alta.
// Poi decide Claude («serve una mia risposta?», `mail_reply_judgment`), sul
// giudizio dell'ULTIMO messaggio del thread: sì → la riga col suo motivo;
// non ancora giudicato → «da valutare»; no → la riga non c'è. Dall'attesa
// più vecchia, al più 20, col totale.

export interface WaitingCustomer {
  threadId: string;
  accountId: string;
  accountEmail: string;
  customer: { name: string | null; email: string };
  subject: string | null;
  project: { id: string; code: string; name: string };
  waitingSince: string;
  signal: string | null;
  importance: MailImportance | null;
  /** `pending` = da valutare (anche dopo tentativi falliti); un «no» non arriva mai. */
  judgment: "yes" | "pending";
  /** Il motivo di Claude, testo NON fidato; `null` da valutare. */
  reason: string | null;
}

const WAIT_MS = 24 * 3_600_000;
const MAX_ROWS = 20;

/** Non un nostro invio non ancora partito: il cliente non l'ha ricevuto. */
const arrived = (m: MailMessage) => !m.delivery || m.delivery.state === "sent";

/** Il messaggio sta in quella casella: della persona, e con l'indirizzo della casella fra i partecipanti. */
function inBox(m: MailMessage, box: { personId: string; email: string }): boolean {
  if (!m.mailboxPersonIds.includes(box.personId)) return false;
  const email = box.email.toLowerCase();
  return [m.from, ...m.to, ...(m.cc ?? [])].some((a) => a.email.toLowerCase() === email);
}

export async function listWaitingCustomers(): Promise<{ items: WaitingCustomer[]; total: number }> {
  const me = await gate("mail.listWaitingCustomers");
  const instanceEmails = new Set(state.mailboxes.map((b) => b.email.toLowerCase()));
  const at = Date.parse(now());
  const out: WaitingCustomer[] = [];
  // Per CASELLA (review M5): la stessa persona può averne più d'una.
  for (const box of state.mailboxes.filter((b) => b.personId === me)) {
    const mine = box.email.toLowerCase();
    const threads = new Map<string, MailMessage[]>();
    for (const m of state.mailMessages) {
      if (!inBox(m, box) || !arrived(m)) continue;
      threads.set(m.threadId, [...(threads.get(m.threadId) ?? []), m]);
    }
    for (const [threadId, msgs] of threads) {
      const ordered = [...msgs].sort((a, b) => a.at.localeCompare(b.at));
      const last = ordered.at(-1)!;
      // (b) l'ultimo messaggio esterno: il cliente e l'attesa vengono da lì.
      const external = ordered.filter((m) => !instanceEmails.has(m.from.email.toLowerCase()));
      const lastExternal = external.at(-1);
      if (!lastExternal) continue;
      // (d) dopo, un mio messaggio partito chiude l'attesa (un collega no).
      if (ordered.some((m) => m.at > lastExternal.at && m.from.email.toLowerCase() === mine))
        continue;
      // (c)
      if (at - Date.parse(lastExternal.at) <= WAIT_MS) continue;
      // (a) ammesso, e il progetto da un suo messaggio classificato che vedo.
      const admitted = ordered.filter((m) => !m.context && m.kind === "email");
      if (admitted.length === 0) continue;
      const classified = admitted.filter(
        (m): m is MailMessage & { classification: { state: "done" } } =>
          m.classification.state === "done",
      );
      let project: { id: string; code: string; name: string } | undefined;
      for (const m of [...classified].reverse()) {
        const id = m.classification.projectIds.find((p) => sees(me, p));
        const p = id ? state.projectsById.get(id) : undefined;
        if (p) {
          project = { id: p.id, code: p.code, name: p.name };
          break;
        }
      }
      if (!project) continue;
      // (e) il rumore: l'ultimo classificato senza progetti e senza importanza alta.
      const latest = classified.at(-1);
      if (
        latest &&
        latest.classification.projectIds.length === 0 &&
        latest.classification.importance !== "high"
      )
        continue;
      const judged = state.mailReplyJudgments.get(`${box.email}|${last.id}`);
      if (judged?.judgment === "no") continue;
      out.push({
        threadId,
        accountId: box.email,
        accountEmail: box.email,
        customer: { name: lastExternal.from.name || null, email: lastExternal.from.email },
        subject: lastExternal.subject || null,
        project,
        waitingSince: lastExternal.at,
        signal: null,
        importance: latest?.classification.importance ?? null,
        judgment: judged?.judgment === "yes" ? "yes" : "pending",
        reason: judged?.judgment === "yes" ? judged.reason : null,
      });
    }
  }
  out.sort((a, b) => a.waitingSince.localeCompare(b.waitingSince));
  return { items: out.slice(0, MAX_ROWS), total: out.length };
}
