import { state } from "../store";
import type { QueuePause } from "./state";

// Il modulo foglia dei blocchi d'istanza (area 9b): le domande che le altre
// aree fanno allo stato d'istanza prima di partire («la coda di questo
// progetto è in pausa?», «si può caricare un file?»). Importa SOLO lo store e
// i tipi dello stato d'istanza, così `servers/visibility.ts` e le altre
// letture lo usano senza raggiungere `api-mutations` né i segreti
// (`architecture.test.ts`, `architecture.secrets.test.ts`). Il Task 5 ci
// aggiunge `aiBlockFor`, il Task 3 legge da qui come da `budget.ts`.

/** La pausa della coda di un progetto, se c'è (una copia). */
export function queuePauseOf(projectId: string): QueuePause | null {
  const pause = state.instance.queuePauses.find((p) => p.projectId === projectId);
  return pause ? { ...pause } : null;
}

/**
 * Se si possono caricare file (Drive, allegati): l'archiviazione è
 * configurata (c'è una chiave), gli allegati sono accesi e l'ultima prova,
 * se c'è, non è fallita.
 */
export function storageAllowsUploads(): boolean {
  const s = state.instance.storage;
  return (
    s.secretId !== null &&
    s.attachmentsEnabled &&
    (s.lastTest === null || s.lastTest.outcome === "ok")
  );
}
