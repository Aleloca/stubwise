import type { AiBlock, RunProvider } from "../model";
import { PEOPLE } from "../seed/people";
import { gate, now, state, visibleProjectIds } from "../store";
import type { AiProvider, QueuePause } from "./state";

// Il modulo foglia dei blocchi d'istanza (area 9b): le domande che le altre
// aree fanno allo stato d'istanza prima di partire («la coda di questo
// progetto è in pausa?», «si può caricare un file?»). Importa SOLO lo store,
// le persone del seme (i nomi) e i tipi dello stato d'istanza, così `servers/visibility.ts` e le altre
// letture lo usano senza raggiungere `api-mutations` né i segreti
// (`architecture.test.ts`, `architecture.secrets.test.ts`). Il Task 5 ci
// aggiunge `aiBlockFor`, la domanda che ogni partenza fa. Il Task 3 ci mette la catena dei provider
// (`pickProvider`) e il budget (`budgetReached`): li leggono le partenze
// dei lavori (Task 5, 6), e `providers.ts`/`budget.ts` li ri-espongono.

/** La pausa della coda di un progetto, se c'è (una copia). */
export function queuePauseOf(projectId: string): QueuePause | null {
  const pause = state.instance.queuePauses.find((p) => p.projectId === projectId);
  return pause ? { ...pause } : null;
}

/** L'archiviazione è configurata: endpoint, bucket, chiave d'accesso e la sua chiave segreta. */
export function storageConfigured(): boolean {
  const s = state.instance.storage;
  return s.secretId !== null && s.endpoint !== "" && s.bucket !== "" && s.accessKeyId !== "";
}

/**
 * Se si possono caricare file (Drive, allegati): l'archiviazione è
 * configurata, gli allegati sono accesi e l'ultima prova, se c'è, non è
 * fallita.
 */
export function storageAllowsUploads(): boolean {
  const s = state.instance.storage;
  return (
    storageConfigured() &&
    s.attachmentsEnabled &&
    (s.lastTest === null || s.lastTest.outcome === "ok")
  );
}

/** Un abbonamento è «al limite» finché la sua quota dice un `limitedUntil` futuro. */
export function isLimited(p: AiProvider): boolean {
  const until = p.quota?.limitedUntil ?? null;
  return until !== null && until > now();
}

/**
 * Con chi parte un lavoro AI nuovo: il primo abbonamento abilitato e non al
 * limite, nell'ordine della catena; la chiave API SOLO se nessun abbonamento
 * è abilitato (D3). Con abbonamenti abilitati ma tutti al limite: `null`, e
 * la chiave resta ferma (RF 4). Solo il nome e l'id, mai il segreto.
 */
export function pickProvider(): RunProvider | null {
  const enabled = state.instance.providers.filter((p) => p.enabled);
  const subscriptions = enabled.filter((p) => p.kind === "subscription");
  if (subscriptions.length > 0) {
    const free = subscriptions.find((p) => !isLimited(p));
    return free ? { kind: "account", name: free.name, id: free.id } : null;
  }
  const key = enabled.find((p) => p.kind === "api_key");
  return key ? { kind: "api_key", name: key.name, id: key.id } : null;
}

/** Lo speso del mese in corso, su tutti i progetti (il budget non guarda chi guarda). */
export function spentThisMonthUsd(): number {
  const month = now().slice(0, 7);
  const sum = state.instance.usage
    .filter((r) => r.at.startsWith(month))
    .reduce((a, r) => a + r.costUsd, 0);
  return Math.round(sum * 1e6) / 1e6;
}

/**
 * Il budget del mese è raggiunto: il simulatore del riquadro «Prototype
 * only», oppure lo speso arrivato al budget. Senza budget non lo è mai.
 */
export function budgetReached(): boolean {
  const { monthlyUsd } = state.instance.budget;
  return (
    state.instance.simulate.budgetReached ||
    (monthlyUsd !== null && spentThisMonthUsd() >= monthlyUsd)
  );
}

/**
 * Perché un lavoro AI nuovo non parte adesso, o `null` se può partire. Il
 * budget del mese vale ovunque (anche senza progetto, «Chiedi a Claude») e
 * vince sulla pausa (EF 1: ferma, la pausa fa solo aspettare); la pausa vale
 * solo per il suo progetto. Chi l'ha messa si legge per nome anche se è
 * stato disattivato: `PEOPLE` tiene anche le persone disattivate.
 */
export function aiBlockFor(projectId: string | null): AiBlock | null {
  if (budgetReached()) return { reason: "monthly_budget" };
  const pause = projectId === null ? null : queuePauseOf(projectId);
  if (!pause) return null;
  const byName = PEOPLE.find((p) => p.id === pause.byId)?.name ?? pause.byId;
  return { reason: "queue_paused", byId: pause.byId, byName, since: pause.at };
}

/**
 * Il blocco di un lavoro nuovo come lo legge chi guarda (Task 6, ruling 6):
 * la testata del progetto, «Chiedi a Claude», le automazioni. R-G5: un
 * progetto che non vede risponde come uno senza pausa (il budget vale
 * comunque, è dell'istanza).
 */
export async function getAiBlock(projectId: string | null): Promise<AiBlock | null> {
  const me = await gate("instance.getAiBlock");
  const visible = projectId === null || visibleProjectIds(me).has(projectId);
  return aiBlockFor(visible ? projectId : null);
}

/**
 * La sola pausa della coda di un progetto, col nome di chi l'ha messa: la
 * testata del progetto e la riga di All projects la dicono anche col budget
 * raggiunto (shape [EF 4]), che invece vince sugli avvii. R-G5: un progetto
 * che chi guarda non vede risponde `null`.
 */
export async function getQueuePause(
  projectId: string,
): Promise<{ byId: string; byName: string; since: string } | null> {
  const me = await gate("instance.getQueuePause");
  if (!visibleProjectIds(me).has(projectId)) return null;
  const pause = queuePauseOf(projectId);
  if (!pause) return null;
  const byName = PEOPLE.find((p) => p.id === pause.byId)?.name ?? pause.byId;
  return { byId: pause.byId, byName, since: pause.at };
}

/** Se si possono caricare file adesso (Task 6, ruling 6): il Drive e gli allegati dei composer. */
export async function getUploadsAllowed(): Promise<boolean> {
  await gate("instance.getUploadsAllowed");
  return storageAllowsUploads();
}
