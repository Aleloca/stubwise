import { now, state } from "./store";

// L'ultima attività di un progetto (area 10b): serve a Claude per dire quali
// progetti sono fermi da tempo («Which projects have gone quiet?») e al
// riepilogo dell'archivio. Una regola sola, qui, sopra i segnali che il
// prototipo già tiene.

/** I giorni oltre i quali un progetto è «senza attività» (S4: «da 3 mesi»). */
export const INACTIVE_DAYS = 90;

const later = (a: string | null, b: string): string => (a === null || b > a ? b : a);

/**
 * L'ultima attività di un progetto (ISO), il massimo fra i segnali dichiarati:
 * voci di `state.activity` sulle sue task, creazione delle task, `createdAt` e
 * `objectWrites` delle richieste, voci del registro del progetto, messaggi di
 * supporto, PR aperte o rilasci. NON contano: le sessioni di Claude e le
 * letture. `null` = nessun segnale.
 *
 * Una scrittura su una richiesta (`objectWrites`) non porta una data: è
 * accaduta in questa sessione, quindi vale `now()`.
 */
export function lastActivityOf(projectId: string): string | null {
  let last: string | null = null;
  const taskIds = new Set<string>();
  for (const t of state.tasks) {
    if (t.projectId !== projectId) continue;
    taskIds.add(t.id);
    last = later(last, t.createdAt);
  }
  for (const a of state.activity) if (taskIds.has(a.taskId)) last = later(last, a.at);
  const requestIds = new Set<string>();
  for (const r of state.requests) {
    if (r.projectId !== projectId) continue;
    requestIds.add(r.id);
    last = later(last, r.createdAt);
  }
  if (state.objectWrites.some((w) => w.kind === "request" && requestIds.has(w.id)))
    last = later(last, now());
  for (const d of state.decisionLog) if (d.projectId === projectId) last = later(last, d.decidedAt);
  for (const c of state.supportConversations) {
    if (c.projectId !== projectId) continue;
    for (const m of c.messages) last = later(last, m.at);
  }
  for (const p of state.openPrs) if (p.projectId === projectId) last = later(last, p.openedAt);
  for (const r of state.releases) if (r.projectId === projectId) last = later(last, r.mergedAt);
  return last;
}
