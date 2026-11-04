import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { useConversation, useSessionPersonId, useSettlePageEvent } from "../../data/queries";
import { onStoreReset } from "../../data/store";
import type { ConversationEvent, PageAction } from "../../data/types";
import i18n, { setLanguage, type Language } from "../../i18n";
import { useTheme } from "../../theme/ThemeProvider";
import type { ThemePreference } from "../../theme/theme";

// Le azioni della pagina (area 10b, Task 9; shape `claude-scenarios.md`
// §3.10): lingua, tema, il filtro della pagina sotto. Non sono dati di
// Stubwise ma la pagina di chi chiede, quindi le esegue il riquadro — una
// volta, solo per la persona della sessione, solo nelle sue conversazioni
// (il «vedi come»: un altro lettore della pubblica non le esegue mai) — e le
// chiude con `settlePageEvent`. Il valore di prima sta solo qui, in memoria
// per persona: «Undo» lo rimette solo se c'è ancora il valore di Claude, e
// dopo un ricaricamento non c'è più. Nessun toast (maintainer).

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
  memory.clear();
  changed();
};
onStoreReset(forget);

/** Solo per i test: come dopo un ricaricamento, il valore di prima non c'è più. */
export const __forgetPageEventsForTest = (): void => {
  memory.clear();
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

/**
 * Esegue i `pageAction` `pending` della conversazione: solo se è di chi
 * guarda, una volta per evento (anche dopo altri render), poi li chiude
 * `done` (o `failed` se la pagina non cambia). I `draft` li aggiunge il
 * Task 10 (P22).
 */
export function usePageEventRunner(conversationId: string | null): void {
  const me = useSessionPersonId();
  const router = useRouter();
  const theme = useTheme();
  const settle = useSettlePageEvent().mutateAsync;
  const detail = useConversation(conversationId ?? "").data;

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
    detail.events.forEach((event, index) => {
      if (event.type !== "pageAction" || event.status !== "pending" || mine.has(event.id)) return;
      mine.add(event.id);
      if (isStale(detail.events, index)) {
        void settle({ id: conversationId, eventId: event.id, status: "failed" }).catch(() => {});
      } else void run(event);
    });

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

export function usePageUndoView(eventId: string): PageUndoView {
  const me = useSessionPersonId();
  useSyncExternalStore(subscribe, () => version);
  const entry = memory.get(me)?.get(eventId);
  if (!entry) return "gone";
  return entry.outcome ?? "available";
}
