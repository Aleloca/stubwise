import { recordChange } from "../changelog/index";
import type { MonitoredServer } from "../types";

// La voce del registro di una scrittura sui server (area 9b), una per tutte:
// `monitor.ts` (server, soglie, controlli) e `access.ts` (accesso SSH) la
// chiamano a scrittura riuscita, DOPO i controlli e insieme al cambio di
// stato. Modulo foglia: non importa le scritture, così le due non si
// importano a vicenda.

/**
 * L'id dell'oggetto è il CODICE (`SRV-2`, come `objectLinkOf` lo rilegge) e
 * l'etichetta pure: è il nome con cui la frase lo chiama. Il prima/dopo, se
 * c'è, è la coppia di `changedFields` — valori stabili, le parole le mette
 * la pagina (Ruling T3) — e `null` significa «non è cambiato niente»: la
 * voce non si scrive (come in `admin/*`: nessuna voce per un salvataggio
 * identico). Senza `diff` la voce è solo la frase (creato, tolto, chiave
 * nuova, accesso cambiato: mai chiavi né segreti).
 */
export function recordServerChange(
  me: string,
  kind: string,
  server: Pick<MonitoredServer, "code">,
  params?: Record<string, string>,
  diff?: { before: string; after: string } | null,
): void {
  if (diff === null) return;
  recordChange({
    kind,
    actorId: me,
    projectId: null,
    object: { type: "server", id: server.code, label: server.code },
    ...(diff ? { before: diff.before, after: diff.after } : {}),
    ...(params ? { params } : {}),
  });
}
