import type { CalendarEventView } from "../../types";
import { appClient } from "./client";

// Il salvataggio verso Google delle scritture del Calendario nella build app
// (area 6, F4). Q2 = a: la richiesta è SINCRONA (il server risponde dopo il
// sì di Google), ma la pagina, come nel prototipo (`data/calendar/save.ts`),
// vede SUBITO l'evento al posto nuovo con «Saving…», poi salvato o «Couldn't
// save» con «Retry» e «Undo the change». Lo stato «non riuscito» lo tiene il
// client, qui, in memoria per client: «Retry» rimanda la STESSA richiesta,
// «Undo» toglie la sovrapposizione (sul server non è cambiato niente).
// Le letture (`listEvents`, `getEvent`) sovrappongono questi eventi alle
// righe del server finché non sono salvati.

export type SaveError = "unreachable" | "rejected" | "changed";

interface Pending {
  /** L'evento come lo vede la pagina mentre si salva o dopo un fallimento. */
  view: CalendarEventView;
  /** La richiesta da rimandare con «Retry». */
  run: () => Promise<CalendarEventView>;
  /**
   * Una riunione NUOVA (review F4, 4): sul server non c'è ancora una riga su
   * cui sovrapporla, quindi le letture la AGGIUNGONO, nel loro intervallo.
   */
  created?: boolean;
}

const store = new WeakMap<object, Map<string, Pending>>();
function pendingMap(): Map<string, Pending> {
  const client = appClient();
  let map = store.get(client);
  if (!map) store.set(client, (map = new Map()));
  return map;
}

/**
 * Chi vuole sapere SUBITO di un evento in salvataggio (la cache delle query:
 * il blocco va al posto nuovo con «Saving…» prima che Google risponda, review
 * F4, 5). Restituisce la funzione che smette di ascoltare.
 */
const listeners = new Set<(e: CalendarEventView) => void>();
export function onSaving(fn: (e: CalendarEventView) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Per client: l'ultima scrittura di ogni evento, perché la prossima la aspetti (in fila per id). */
const chains = new WeakMap<object, Map<string, Promise<unknown>>>();
function chainOf(): Map<string, Promise<unknown>> {
  const client = appClient();
  let map = chains.get(client);
  if (!map) chains.set(client, (map = new Map()));
  return map;
}

/** Le righe del server con sopra gli eventi in salvataggio o non salvati. */
export function withPendingSaves(
  rows: CalendarEventView[],
  range?: { from: number; to: number },
): CalendarEventView[] {
  const map = pendingMap();
  if (map.size === 0) return rows;
  const out = rows.map((r) => map.get(r.id)?.view ?? r);
  if (range)
    for (const p of map.values())
      if (
        p.created &&
        Date.parse(p.view.startsAt) < range.to &&
        Date.parse(p.view.endsAt) > range.from
      )
        out.push(p.view);
  return out;
}

/** L'evento in salvataggio o non salvato, se c'è. */
export const pendingSave = (id: string): CalendarEventView | undefined =>
  pendingMap().get(id)?.view;

/**
 * Salva: l'evento è subito `patched` con «Saving…», poi la richiesta. Un
 * errore di Google (`saveErrorOf` lo riconosce) lascia l'evento «non salvato»
 * e si RISOLVE con quella vista; ogni altro errore si lancia e non lascia
 * niente (il gesto non doveva partire).
 */
export async function saveWith(
  patched: CalendarEventView,
  run: () => Promise<CalendarEventView>,
  saveErrorOf: (error: unknown) => SaveError | null,
  created = false,
): Promise<CalendarEventView> {
  const map = pendingMap();
  const entry: Pending = { view: { ...patched, save: { state: "saving" } }, run, created };
  map.set(patched.id, entry);
  for (const fn of [...listeners]) fn(entry.view);
  // In fila per evento: la seconda parte quando la prima è finita, e legge
  // l'etag che la prima ha lasciato (`run` lo legge al momento).
  const chain = chainOf();
  const before = chain.get(patched.id) ?? Promise.resolve();
  const turn = before.then(
    () => run(),
    () => run(),
  );
  chain.set(
    patched.id,
    turn.catch(() => undefined),
  );
  try {
    const saved = await turn;
    if (map.get(patched.id) === entry) map.delete(patched.id);
    return { ...saved, save: { state: "saved" } };
  } catch (error) {
    const reason = saveErrorOf(error);
    if (reason === null) {
      if (map.get(patched.id) === entry) map.delete(patched.id);
      throw error;
    }
    const failed: Pending = {
      view: { ...patched, save: { state: "failed", error: reason } },
      run,
      created,
    };
    if (map.get(patched.id) === entry) map.set(patched.id, failed);
    return failed.view;
  }
}

/** «Retry»: la stessa richiesta, con «Saving…» di nuovo. */
export async function retryPending(
  id: string,
  saveErrorOf: (error: unknown) => SaveError | null,
): Promise<CalendarEventView> {
  const entry = pendingMap().get(id);
  if (!entry || entry.view.save?.state !== "failed") throw new Error("invalid: not failed");
  return saveWith(entry.view, entry.run, saveErrorOf, entry.created === true);
}

/** «Undo the change»: la sovrapposizione se ne va, resta la riga del server. */
export function dropPending(id: string): void {
  const entry = pendingMap().get(id);
  if (!entry || entry.view.save?.state !== "failed") throw new Error("invalid: not failed");
  pendingMap().delete(id);
}

/** Al cambio di persona: i salvataggi in corso o non riusciti erano di quella di prima. */
export function forgetPendingSaves(): void {
  pendingMap().clear();
  chainOf().clear();
}
