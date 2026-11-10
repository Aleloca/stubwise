import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { useConversation, useSessionPersonId, useSettlePageEvent } from "../../data/queries";
import { onStoreReset } from "@backend/runtime";
import { isAppBuild } from "../../data/build";
import { getSessionPersonId } from "../../data/session";
import type { ConversationEvent, FieldRef, PageAction } from "../../data/types";
import { placeDraft } from "../../domain/claude/intents/mailDraft";
import i18n, { setLanguage, type Language } from "../../i18n";
import { useTheme } from "../../theme/ThemeProvider";
import type { ThemePreference } from "../../theme/theme";
import { fillableFor, subscribeFillable, type FillableField } from "./fillable";

// Le azioni della pagina (area 10b, Task 9; shape `claude-scenarios.md`
// §3.10): lingua, tema, il filtro della pagina sotto. Non sono dati di
// Stubwise ma la pagina di chi chiede, quindi le esegue il riquadro — una
// volta, solo per la persona della sessione, solo nelle sue conversazioni
// (il «vedi come»: un altro lettore della pubblica non le esegue mai) — e le
// chiude con `settlePageEvent`. Il valore di prima sta solo qui, in memoria
// per persona: «Undo» lo rimette solo se c'è ancora il valore di Claude, e
// dopo un ricaricamento non c'è più. Nessun toast (maintainer).
//
// Nella build app (chat, fetta 3) l'esito vive solo in questa finestra (il
// server non lo salva): un'azione parte SOLO se arriva dal vivo in questa
// finestra, cioè dopo la prima occhiata alla conversazione — mai da una
// lettura del dettaglio o della storia (un ricaricamento, un riavvio,
// un'altra scheda del browser). Quelle già lette restano «non applicate» e la
// riga offre il gesto per applicarle adesso («Apply»).

type PageEvent = Extract<ConversationEvent, { type: "pageAction" }>;

/** Com'è la pagina, per ciò che un'azione tocca: la lingua, il tema, l'indirizzo. */
type Value = string;

interface Remembered {
  conversationId: string;
  kind: PageAction["kind"];
  /** Il valore da rimettere (per il filtro, l'indirizzo intero di prima). */
  before: Value;
  /** Ciò che Claude ha messo, come lo confronta `read` (per il filtro, pagina e criteri). */
  after: Value;
  /** Dopo un clic su «Undo»: com'è andata (un secondo clic non scrive). */
  outcome?: "undone" | "changed_after";
}

/** La pagina di adesso, scritta dal runner montato: leggere e rimettere un valore. */
interface Page {
  /** Il valore da confrontare con `after`: per il filtro solo pagina e criteri (I1). */
  read(kind: PageAction["kind"]): Value;
  /** Il valore da rimettere (`before`): per il filtro, l'indirizzo intero. */
  current(kind: PageAction["kind"]): Value;
  write(kind: PageAction["kind"], value: Value): void;
}

/** Per persona: gli eventi già partiti (una volta sola) e il valore di prima. */
const started = new Map<string, Set<string>>();
/**
 * Build app: per persona, le conversazioni già guardate in questa finestra
 * con le azioni della pagina che c'erano alla prima occhiata (lette, non
 * arrivate dal vivo), e per quelle il gesto che le applica adesso.
 */
const firstLook = new Map<string, Map<string, Set<string>>>();
const appliers = new Map<string, Map<string, () => void>>();
const memory = new Map<string, Map<string, Remembered>>();
/**
 * I runner montati (il riquadro e la pagina intera della conversazione,
 * I2): vale l'ultimo, e smontarne uno non spegne gli altri.
 */
const pages: { personId: string; page: Page }[] = [];
const currentPage = () => pages.at(-1) ?? null;

const listeners = new Set<() => void>();
let version = 0;
function changed() {
  version += 1;
  for (const l of listeners) l();
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

const forget = () => {
  started.clear();
  firstLook.clear();
  appliers.clear();
  memory.clear();
  drafts.clear();
  changed();
};
onStoreReset(forget);

/** Solo per i test: come un riquadro ricaricato, nessun evento è già partito. */
export const __forgetStartedForTest = (): void => {
  started.clear();
  firstLook.clear();
  appliers.clear();
  changed();
};

/** Solo per i test: come dopo un ricaricamento, il valore di prima non c'è più. */
export const __forgetPageEventsForTest = (): void => {
  memory.clear();
  drafts.clear();
  changed();
};

const memoryOf = (personId: string) => {
  let m = memory.get(personId);
  if (!m) memory.set(personId, (m = new Map()));
  return m;
};

/** Il filtro come indirizzo della pagina («/p/ACQ/tasks?filters=…»), da rimettere com'era. */
const hrefOf = (router: ReturnType<typeof useRouter>) => router.state.location.href;

/** JSON con le chiavi in ordine: lo stesso oggetto dà sempre lo stesso testo. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Ciò che il filtro di Claude ha cambiato: la pagina e i criteri, non il
 * resto dell'indirizzo — aprire una task (`?task=`, J/K) non lo cambia (I1).
 */
function filterKeyOf(router: ReturnType<typeof useRouter>): Value {
  const { pathname, search } = router.state.location;
  return `${pathname}|${stable((search as Record<string, unknown>).filters)}`;
}

/**
 * Un `pending` vecchio: dopo di lui chi chiede ha già scritto un altro
 * messaggio. Eseguirlo adesso cambierebbe la pagina senza che l'abbia appena
 * chiesto (I2); si chiude `failed`, con la sua riga. Criterio scelto al posto
 * di «trovato al montaggio»: il riquadro monta la conversazione nuova dopo
 * il primo invio, e al primo caricamento l'evento fresco c'è già.
 */
function isStale(events: readonly ConversationEvent[], index: number): boolean {
  return events.slice(index + 1).some((e) => e.type === "user");
}

/** D2: la prova di Claude che il riquadro apre nel costruttore, e la pagina che lascia. */
export interface TrialOpening {
  code: string;
  /** La prima prova che passa; `null`: nessuna passa, si apre il costruttore (`/edit`, [AU 6]). */
  simId: string | null;
  /** L'indirizzo lasciato, per «Back to …». */
  from: string;
}

/**
 * Esegue i `pageAction` `pending` della conversazione: solo se è di chi
 * guarda, una volta per evento (anche dopo altri render), poi li chiude
 * `done` (o `failed` se la pagina non cambia). Anche i `draft` (Task 10,
 * P22): la bozza va nel campo dichiarato della pagina aperta, o aspetta.
 *
 * Con `onTrial` (solo il riquadro, area 10b D2): la prima prova `done` del
 * turno IN DIRETTA apre il costruttore sulla prova, una volta sola. «In
 * diretta» = arrivata mentre questo runner guardava già la conversazione (o
 * col turno ancora in corso alla prima occhiata): riaprendo una conversazione
 * finita non si naviga, c'è «Open the test». `onTrial` parte prima della
 * navigazione, quando la pagina lasciata è ancora quella di prima.
 */
export function usePageEventRunner(
  conversationId: string | null,
  options: { onTrial?: (opening: TrialOpening) => void } = {},
): void {
  const me = useSessionPersonId();
  const router = useRouter();
  const theme = useTheme();
  const settle = useSettlePageEvent().mutateAsync;
  const detail = useConversation(conversationId ?? "").data;
  const onTrialRef = useRef(options.onTrial);
  onTrialRef.current = options.onTrial;
  /** Le conversazioni già guardate da QUESTO runner: la prima occhiata non è il turno in diretta. */
  const observed = useRef(new Set<string>());

  // La pagina come la vede «Undo»: i valori di ADESSO (il tema dall'ultimo render).
  const themeRef = useRef(theme);
  themeRef.current = theme;
  /** Cambia il tema e lo dice subito al ref: prima del render dopo, `read` vede già il nuovo. */
  const setTheme = (v: ThemePreference) => {
    themeRef.current.setPreference(v);
    themeRef.current = { ...themeRef.current, preference: v };
  };
  useEffect(() => {
    const value = (kind: PageAction["kind"]) =>
      kind === "language" ? i18n.language : themeRef.current.preference;
    const current: Page = {
      read: (kind) => (kind === "filter" ? filterKeyOf(router) : value(kind)),
      current: (kind) => (kind === "filter" ? hrefOf(router) : value(kind)),
      write: (kind, v) => {
        if (kind === "language") setLanguage(v as Language);
        else if (kind === "theme") setTheme(v as ThemePreference);
        else void router.navigate({ href: v });
      },
    };
    const entry = { personId: me, page: current };
    pages.push(entry);
    changed();
    return () => {
      const at = pages.indexOf(entry);
      if (at !== -1) pages.splice(at, 1);
      changed();
    };
  }, [me, router]);

  useEffect(() => {
    if (!conversationId || !detail || detail.ownerId !== me) return;
    let mine = started.get(me);
    if (!mine) started.set(me, (mine = new Set()));
    const live = observed.current.has(conversationId) || detail.state === "working";
    observed.current.add(conversationId);
    // Build app: le azioni della pagina presenti alla PRIMA occhiata in questa
    // finestra sono lette, non dal vivo (vedi il commento in cima).
    let looks = firstLook.get(me);
    if (!looks) firstLook.set(me, (looks = new Map()));
    let readNotLive = looks.get(conversationId);
    if (!readNotLive) {
      readNotLive = new Set(
        isAppBuild() ? detail.events.filter((e) => e.type === "pageAction").map((e) => e.id) : [],
      );
      looks.set(conversationId, readNotLive);
    }
    detail.events.forEach((event, index) => {
      if (event.type === "trial") {
        if (!onTrialRef.current || event.status !== "done" || !event.code) return;
        if (mine.has(event.id)) return;
        mine.add(event.id);
        // Una conversazione riaperta, o un messaggio dopo la prova: non si naviga.
        if (live && !isStale(detail.events, index))
          void openTrial(event.code, event.openSimId ?? null);
        return;
      }
      if (event.type === "draft") {
        if (event.status !== "pending" || !event.field || mine.has(event.id)) return;
        mine.add(event.id);
        // Una bozza vecchia non entra in un campo da sola: aspetta «Put it in the field».
        startDraft(me, conversationId, event, settle, isStale(detail.events, index));
        return;
      }
      if (event.type !== "pageAction" || event.status !== "pending" || mine.has(event.id)) return;
      mine.add(event.id);
      if (readNotLive.has(event.id)) {
        // Letta, non arrivata dal vivo: non parte da sola; la riga offre il gesto.
        appliersOf(me).set(event.id, () => {
          appliersOf(me).delete(event.id);
          changed();
          void run(event);
        });
        changed();
        // Chiusa «non partita» solo in questa finestra (l'esito non è sul server).
        void settle({ id: conversationId, eventId: event.id, status: "failed" }).catch(() => {});
        return;
      }
      if (isStale(detail.events, index)) {
        void settle({ id: conversationId, eventId: event.id, status: "failed" }).catch(() => {});
      } else void run(event);
    });

    async function openTrial(code: string, simId: string | null) {
      onTrialRef.current?.({ code, simId, from: hrefOf(router) });
      await router.navigate(
        (simId
          ? { to: "/automations/$code/test", params: { code }, search: { sim: simId } }
          : { to: "/automations/$code/edit", params: { code } }) as never,
      );
    }

    async function run(event: PageEvent) {
      const action = event.action;
      const before =
        action.kind === "language"
          ? i18n.language
          : action.kind === "theme"
            ? themeRef.current.preference
            : hrefOf(router);
      let after: Value;
      try {
        if (action.kind === "language") {
          setLanguage(action.to);
          after = action.to;
        } else if (action.kind === "theme") {
          setTheme(action.to);
          after = action.to;
        } else {
          await router.navigate({ to: action.route, search: action.search } as never);
          after = filterKeyOf(router);
        }
      } catch {
        await settle({ id: conversationId!, eventId: event.id, status: "failed" }).catch(() => {});
        return;
      }
      // Prima la memoria, poi `done`: la riga trova «Undo» appena si chiude.
      memoryOf(me).set(event.id, {
        conversationId: conversationId!,
        kind: action.kind,
        before,
        after,
      });
      changed();
      try {
        await settle({ id: conversationId!, eventId: event.id, status: "done" });
      } catch {
        // Chiuderla non è riuscito (M3): la pagina non resta cambiata senza
        // traccia. Si rimette il valore di prima (se c'è ancora quello di
        // Claude) e la riga dice «Didn't run».
        memoryOf(me).delete(event.id);
        changed();
        const now = currentPage()?.page;
        if (now && now.read(action.kind) === after) now.write(action.kind, before);
        await settle({ id: conversationId!, eventId: event.id, status: "failed" }).catch(() => {});
      }
    }
  }, [conversationId, detail, me, router, settle]);
}

/**
 * «Undo» di un'azione della pagina: rimette il valore di prima solo se c'è
 * ancora quello di Claude (`changed_after` altrimenti). Senza il valore di
 * prima (un ricaricamento, un altro lettore, un clic già fatto):
 * `not_undoable`, e niente cambia. Chiudere l'evento tocca a chi chiama.
 */
export function undoPageEvent(eventId: string): "undone" | "changed_after" | "not_undoable" {
  const page = currentPage();
  if (!page) return "not_undoable";
  const entry = memory.get(page.personId)?.get(eventId);
  if (!entry || entry.outcome) return "not_undoable";
  const now = page.page.read(entry.kind);
  entry.outcome = now === entry.after ? "undone" : "changed_after";
  if (entry.outcome === "undone") page.page.write(entry.kind, entry.before);
  changed();
  return entry.outcome;
}

/**
 * Cosa può dire la riga a chi guarda: «Undo» (`available`), com'è andato il
 * clic, o niente valore di prima (`gone`). Solo la persona della sessione
 * ha memoria: per gli altri è sempre `gone`.
 */
export type PageUndoView = "available" | "undone" | "changed_after" | "gone";

const appliersOf = (personId: string) => {
  let m = appliers.get(personId);
  if (!m) appliers.set(personId, (m = new Map()));
  return m;
};

/**
 * Build app: il gesto che applica adesso un'azione della pagina letta (non
 * arrivata dal vivo), o `null` se non c'è (partita, chiusa, di un altro).
 */
export function usePageApply(eventId: string): (() => void) | null {
  const me = useSessionPersonId();
  useSyncExternalStore(subscribe, () => version);
  return appliers.get(me)?.get(eventId) ?? null;
}

export function usePageUndoView(eventId: string): PageUndoView {
  const me = useSessionPersonId();
  useSyncExternalStore(subscribe, () => version);
  const entry = memory.get(me)?.get(eventId);
  if (!entry) return "gone";
  return entry.outcome ?? "available";
}

// --- le bozze (Task 10) -------------------------------------------------------
//
// Una bozza va SOLO nel campo dichiarato della pagina aperta adesso
// (`fillableFor`), mai in un campo di un'altra pagina. Campo vuoto: la bozza
// entra e la riga dice `placed`. Campo con del testo: la riga chiede
// «Replace or add below?» e il campo non cambia finché non si sceglie. Campo
// non dichiarato: `waiting`, e «Put it in the field» porta alla pagina e la
// mette appena il campo si dichiara, una volta sola. Il testo di prima sta
// solo qui, in memoria per persona: «Undo» lo rimette solo se il campo ha
// ancora il testo di Claude, altrimenti `changed_after`. Nessun toast.

type DraftEvent = Extract<ConversationEvent, { type: "draft" }>;
type Settle = (vars: {
  id: string;
  eventId: string;
  status: "placed" | "waiting" | "undone" | "changed_after";
}) => Promise<unknown>;

interface DraftEntry {
  conversationId: string;
  ref: FieldRef;
  text: string;
  sources: readonly string[];
  settle: Settle;
  /**
   * `wanted`: «Put it in the field», aspetta che il campo si dichiari;
   * `busy`: il campo è occupato da «Ask Claude» della pagina, la riga resta
   * `pending` (T10 m1); `asking`: il campo ha testo, la riga chiede;
   * `placed`: il testo è nel campo.
   */
  stage: "idle" | "wanted" | "busy" | "asking" | "placed";
  /** Il testo del campo prima di Claude, e quello dopo (per «Undo»). */
  before?: string;
  after?: string;
  /** Dopo «Undo» o una modifica: com'è andata (nessuna seconda scrittura). */
  outcome?: "undone" | "changed_after";
}

const drafts = new Map<string, Map<string, DraftEntry>>();
const draftsOf = (personId: string) => {
  let m = drafts.get(personId);
  if (!m) drafts.set(personId, (m = new Map()));
  return m;
};

const quiet = (p: Promise<unknown>) => void p.catch(() => {});

/** Il testo nel campo, il segno, la memoria per «Undo»; poi `placed`. */
function place(
  entry: DraftEntry,
  eventId: string,
  field: FillableField,
  how: "replace" | "below",
) {
  const before = field.get();
  // Prima la memoria, poi il campo: il campo avvisa subito chi ascolta, e il
  // confronto con il testo di Claude deve già trovarlo.
  entry.before = before;
  entry.after = placeDraft(before, entry.text, how);
  entry.stage = "placed";
  field.put(entry.text, how, entry.sources);
  changed();
  quiet(entry.settle({ id: entry.conversationId, eventId, status: "placed" }));
}

/**
 * Nel campo c'è ancora la bozza di Claude, non toccata né inviata né
 * salvata: il testo è quello messo e il segno vale ancora (I1). Dopo «Save»
 * il testo può essere identico, ma è della persona: «Undo» non c'è più.
 */
const stillDraft = (field: FillableField, entry: DraftEntry) =>
  field.get() === entry.after && field.isDraft();

/** Prova a mettere la bozza: nel campo vuoto la mette, con del testo chiede. */
function offer(entry: DraftEntry, eventId: string): boolean {
  const field = fillableFor(entry.ref);
  if (!field) return false;
  // «Ask Claude» della pagina sta scrivendo: la bozza aspetta che finisca, senza
  // scrivergli sotto né chiudersi `waiting` (T10 m1). La riprova il prossimo render.
  if (field.busy?.()) {
    if (entry.stage !== "busy") {
      entry.stage = "busy";
      changed();
    }
    return true;
  }
  const wanted = entry.stage === "wanted";
  if (field.get().trim() === "") {
    place(entry, eventId, field, "replace");
    // «Put it in the field» porta alla pagina e il fuoco al campo (shape §6, I2).
    if (wanted) field.focus?.();
  } else {
    entry.stage = "asking";
    changed();
  }
  return true;
}

function startDraft(
  me: string,
  conversationId: string,
  event: DraftEvent,
  settle: Settle,
  stale: boolean,
) {
  const entry: DraftEntry = {
    conversationId,
    ref: event.field!,
    text: event.text,
    sources: event.sources ?? [],
    settle,
    stage: "idle",
  };
  draftsOf(me).set(event.id, entry);
  if (stale || !offer(entry, event.id)) {
    quiet(settle({ id: conversationId, eventId: event.id, status: "waiting" }));
  }
}

/**
 * La scelta della riga che chiede: «Add below» o «Replace». Il campo deve
 * essere ancora dichiarato; se la pagina nel frattempo è cambiata la bozza
 * aspetta (`waiting`). Un secondo clic non scrive.
 */
export function answerDraft(eventId: string, how: "replace" | "below"): void {
  const entry = drafts.get(getSessionPersonId())?.get(eventId);
  if (!entry || entry.stage !== "asking") return;
  const field = fillableFor(entry.ref);
  if (field) {
    place(entry, eventId, field, how);
    return;
  }
  entry.stage = "idle";
  changed();
  quiet(entry.settle({ id: entry.conversationId, eventId, status: "waiting" }));
}

/**
 * «Put it in the field»: la bozza aspetta il suo campo; chi chiama porta
 * alla pagina. Se il campo c'è già la mette (o chiede) subito.
 */
export function wantDraft(conversationId: string, event: DraftEvent, settle: Settle): void {
  if (!event.field) return;
  const mine = draftsOf(getSessionPersonId());
  const entry: DraftEntry = mine.get(event.id) ?? {
    conversationId,
    ref: event.field,
    text: event.text,
    sources: event.sources ?? [],
    settle,
    stage: "idle",
  };
  if (entry.stage === "placed" || entry.stage === "asking") return;
  entry.settle = settle;
  entry.stage = "wanted";
  mine.set(event.id, entry);
  changed();
  offer(entry, event.id);
}

/**
 * «Undo» della riga: rimette il testo di prima solo se il campo è aperto e
 * ha ancora il testo di Claude (`changed_after` altrimenti). Senza memoria
 * (un ricaricamento, un clic già fatto) o senza la pagina del campo:
 * `not_undoable`, e niente cambia. Chiudere l'evento tocca a chi chiama.
 */
export function undoDraft(eventId: string): "undone" | "changed_after" | "not_undoable" {
  const entry = drafts.get(getSessionPersonId())?.get(eventId);
  if (!entry || entry.stage !== "placed" || entry.outcome) return "not_undoable";
  const field = fillableFor(entry.ref);
  if (!field) return "not_undoable";
  entry.outcome = stillDraft(field, entry) ? "undone" : "changed_after";
  if (entry.outcome === "undone") field.restore(entry.before ?? "");
  changed();
  return entry.outcome;
}

/**
 * Il campo dichiarato o cambiato (ogni render della pagina che lo dichiara):
 * una bozza che lo aspettava ci entra; una bozza messa il cui testo non c'è
 * più (una modifica, l'invio, Esc) si chiude `changed_after` — «Undo» non
 * cancella mai le modifiche della persona.
 */
subscribeFillable(() => {
  const mine = drafts.get(getSessionPersonId());
  if (!mine) return;
  for (const [eventId, entry] of mine) {
    if (entry.stage === "wanted" || entry.stage === "busy") {
      offer(entry, eventId);
      continue;
    }
    if (entry.stage !== "placed" || entry.outcome) continue;
    const field = fillableFor(entry.ref);
    if (!field || stillDraft(field, entry)) continue;
    entry.outcome = "changed_after";
    changed();
    quiet(entry.settle({ id: entry.conversationId, eventId, status: "changed_after" }));
  }
});

/**
 * Cosa può dire la riga di una bozza a chi l'ha chiesta: aspetta il campo,
 * chiede, «Undo» (il campo è aperto), com'è andato il clic, o niente memoria
 * (`gone`). Per gli altri lettori: sempre `gone`.
 */
export interface DraftView {
  stage: DraftEntry["stage"] | "gone";
  outcome?: "undone" | "changed_after";
  /** Il campo della bozza è dichiarato adesso (la sua pagina è aperta). */
  fieldOpen: boolean;
}

export function useDraftView(eventId: string, ref: FieldRef | null): DraftView {
  const me = useSessionPersonId();
  useSyncExternalStore(subscribe, () => version);
  const fieldOpen = useSyncExternalStore(subscribeFillable, () =>
    ref ? fillableFor(ref) !== null : false,
  );
  const entry = drafts.get(me)?.get(eventId);
  if (!entry) return { stage: "gone", fieldOpen };
  return { stage: entry.stage, ...(entry.outcome ? { outcome: entry.outcome } : {}), fieldOpen };
}

/** «Show»: il fuoco nel campo della bozza, se la sua pagina è aperta. */
export function focusDraftField(ref: FieldRef): boolean {
  const field = fillableFor(ref);
  if (!field?.focus) return false;
  field.focus();
  return true;
}
