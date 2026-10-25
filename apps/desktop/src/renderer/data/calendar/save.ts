import { CALENDAR_CASES } from "../seed/calendar";
import { copy, gate, onStoreReset, state, storeGeneration } from "../store";
import type { CalendarEvent } from "../types";

// Il salvataggio verso Google delle scritture del Calendario (area 6):
// crea, modifica, sposta e risposta cambiano SUBITO lo store con
// `save.state: "saving"`; un passo simulato (`calendar.advanceSave`, via
// `gate()`: segue `setLatency`, `failNext` lo fa fallire) le porta a
// `saved` o `failed`. Un evento del seme (`CALENDAR_CASES.saveFails`)
// fallisce sempre al primo salvataggio.
//
// Gli eventi di una stessa scrittura (una serie intera, per esempio) sono un
// GRUPPO: «Riprova» e «Annulla la modifica» valgono per tutti quelli del
// gruppo ancora non confermati, non solo per quello su cui si clicca.

const pending = new Set<Promise<void>>();

/** Un lavoro simulato in corso, che `whenCalendarIdle` aspetta. */
export function track(work: Promise<void>): void {
  pending.add(work);
  void work.finally(() => pending.delete(work));
}

/** Si risolve quando nessun salvataggio o allineamento simulato è più in corso. */
export async function whenCalendarIdle(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending]);
}

/**
 * La versione di Google di ogni evento con un salvataggio non confermato
 * (`null`: l'evento non c'era, è nato qui). La rimette «Annulla la modifica».
 */
const googleVersion = new Map<string, CalendarEvent | null>();
/** Il gruppo (gli id della stessa scrittura) dell'ultimo salvataggio di ogni evento. */
const groupOf = new Map<string, readonly string[]>();
onStoreReset(() => {
  googleVersion.clear();
  groupOf.clear();
});

/** Un passo del salvataggio: `saving` → `saved` (o `failed`). */
async function advanceSave(ids: readonly string[]): Promise<void> {
  const generation = storeGeneration();
  const alive = () => storeGeneration() === generation;
  const saving = () =>
    state.calendarEvents.filter((e) => ids.includes(e.id) && e.save?.state === "saving");
  try {
    await gate("calendar.advanceSave");
    if (!alive()) return;
    for (const e of saving()) {
      if (e.id === CALENDAR_CASES.saveFails && !state.calendarFailedOnce.has(e.id)) {
        state.calendarFailedOnce.add(e.id);
        e.save = { state: "failed", error: "rejected" };
        continue;
      }
      e.save = { state: "saved" };
      googleVersion.delete(e.id);
    }
  } catch {
    if (!alive()) return;
    for (const e of saving()) e.save = { state: "failed", error: "unreachable" };
  }
}

/** Un evento nato qui: su Google non c'era, «Annulla la modifica» lo toglie. */
export function markCreated(e: CalendarEvent): void {
  googleVersion.set(e.id, null);
}

/**
 * Applica `change` agli eventi e li manda a Google come un gruppo: subito
 * `saving`, poi il passo simulato. La versione di Google si tiene la prima
 * volta (dopo un fallimento la modifica successiva non la sovrascrive).
 */
export function save(events: CalendarEvent[], change: (e: CalendarEvent) => void): void {
  const ids = events.map((e) => e.id);
  for (const e of events) {
    if (!googleVersion.has(e.id)) googleVersion.set(e.id, copy(e));
    groupOf.set(e.id, ids);
    change(e);
    e.save = { state: "saving" };
  }
  track(advanceSave(ids));
}

/** Gli eventi non più su Google (eliminati): niente da ripristinare. */
export function forget(ids: readonly string[]): void {
  for (const id of ids) {
    googleVersion.delete(id);
    groupOf.delete(id);
  }
}

const invalid = (what: string) => new Error(`invalid: ${what}`);

/** Gli eventi falliti del gruppo di `e` (`e` compreso). */
function failedGroup(e: CalendarEvent): CalendarEvent[] {
  if (e.save?.state !== "failed") throw invalid("not failed");
  const ids = groupOf.get(e.id) ?? [e.id];
  return state.calendarEvents.filter((x) => ids.includes(x.id) && x.save?.state === "failed");
}

/** «Riprova»: il gruppo fallito torna `saving` e riparte. */
export function retryGroup(e: CalendarEvent): void {
  const group = failedGroup(e);
  for (const x of group) x.save = { state: "saving" };
  track(advanceSave(group.map((x) => x.id)));
}

/**
 * «Annulla la modifica»: ogni evento fallito del gruppo torna alla versione
 * di Google (uno nato qui sparisce). Senza una versione nota non si tocca
 * nulla (`invalid`): mai togliere un evento per eccesso di zelo.
 */
export function revertGroup(e: CalendarEvent): void {
  const group = failedGroup(e);
  if (group.some((x) => !googleVersion.has(x.id))) throw invalid("no version");
  for (const x of group) {
    const before = googleVersion.get(x.id)!;
    forget([x.id]);
    const index = state.calendarEvents.indexOf(x);
    if (before === null) state.calendarEvents.splice(index, 1);
    else state.calendarEvents[index] = before;
  }
}
