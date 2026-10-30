import type { RunProvider } from "../model";
import { now, state } from "../store";
import type { AiProvider, QueuePause } from "./state";

// Il modulo foglia dei blocchi d'istanza (area 9b): le domande che le altre
// aree fanno allo stato d'istanza prima di partire («la coda di questo
// progetto è in pausa?», «si può caricare un file?»). Importa SOLO lo store e
// i tipi dello stato d'istanza, così `servers/visibility.ts` e le altre
// letture lo usano senza raggiungere `api-mutations` né i segreti
// (`architecture.test.ts`, `architecture.secrets.test.ts`). Il Task 5 ci
// aggiunge `aiBlockFor`. Il Task 3 ci mette la catena dei provider
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
