import { sees } from "../access";
import { gate, now, state } from "../store";
import type { MailImportance, MailMessage } from "../types";

// «Clienti in attesa» dalla posta delle caselle (area 8, piano di 72, W-3 =
// a, W-4 = b; `GET /api/me/waiting-customers` sul server). Un cliente aspetta
// ME quando un thread delle MIE caselle:
// (a) è ammesso — un suo messaggio non di contesto classificato — e di un
//     progetto che vedo;
// (b) ha l'ultimo messaggio da un indirizzo ESTERNO (né la mia casella né
//     un'altra casella collegata dell'istanza);
// (c) di più di 24 ore fa;
// (d) senza un nostro messaggio dopo: un invio partito conta, uno in
//     partenza o fallito no (il cliente aspetta ancora);
// (e) non è rumore (nel prototipo: l'importanza dell'ultimo ammesso non è bassa).
// Poi decide Claude («serve una mia risposta?», `mail_reply_judgment`): sì →
// la riga col suo motivo; non ancora giudicato → «da valutare» senza motivo;
// no → la riga non c'è. Dall'attesa più vecchia, al più 20, col totale.

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

export async function listWaitingCustomers(): Promise<{ items: WaitingCustomer[]; total: number }> {
  const me = await gate("mail.listWaitingCustomers");
  const instanceEmails = new Set(state.mailboxes.map((b) => b.email.toLowerCase()));
  const at = Date.parse(now());
  const out: WaitingCustomer[] = [];
  for (const box of state.mailboxes.filter((b) => b.personId === me)) {
    const threads = new Map<string, MailMessage[]>();
    for (const m of state.mailMessages) {
      if (!m.mailboxPersonIds.includes(me) || !arrived(m)) continue;
      threads.set(m.threadId, [...(threads.get(m.threadId) ?? []), m]);
    }
    for (const [threadId, msgs] of threads) {
      const ordered = [...msgs].sort((a, b) => a.at.localeCompare(b.at));
      const last = ordered.at(-1)!;
      // (b) e (d): l'ultimo è di un esterno (un nostro invio partito dopo lo chiude).
      if (instanceEmails.has(last.from.email.toLowerCase())) continue;
      // (c)
      if (at - Date.parse(last.at) <= WAIT_MS) continue;
      // (a): l'ultimo messaggio ammesso e classificato, di un progetto che vedo.
      const admitted = ordered.filter(
        (m) => !m.context && m.kind === "email" && m.classification.state === "done",
      );
      const latest = admitted.at(-1);
      if (!latest || latest.classification.state !== "done") continue;
      const projectId = latest.classification.projectIds.find((id) => sees(me, id));
      const project = projectId ? state.projectsById.get(projectId) : undefined;
      if (!project) continue;
      // (e)
      if (latest.classification.importance === "low") continue;
      const judged = state.mailReplyJudgments.get(`${box.email}|${last.id}`);
      if (judged?.judgment === "no") continue;
      out.push({
        threadId,
        accountId: box.email,
        accountEmail: box.email,
        customer: { name: last.from.name || null, email: last.from.email },
        subject: last.subject || null,
        project: { id: project.id, code: project.code, name: project.name },
        waitingSince: last.at,
        signal: null,
        importance: latest.classification.importance,
        judgment: judged?.judgment === "yes" ? "yes" : "pending",
        reason: judged?.judgment === "yes" ? judged.reason : null,
      });
    }
  }
  out.sort((a, b) => a.waitingSince.localeCompare(b.waitingSince));
  return { items: out.slice(0, MAX_ROWS), total: out.length };
}
