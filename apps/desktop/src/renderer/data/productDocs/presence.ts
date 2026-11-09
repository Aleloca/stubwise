import { anchorIdsOf, anchorText, isTextBlock } from "../../domain/productDocs/blocks";
import { insertText } from "../../domain/productDocs/richText";
import { sectionOf, sectionRange } from "../../domain/productDocs/sections";
import { visiblePeopleFor } from "../access/whoCan";
import { docsAccess } from "../docs/reads";
import { PEOPLE } from "../seed/people";
import { PRODUCT_SCRIPTS } from "../seed/productDocs/presence";
import { gate, nextSeq, onStoreReset, state, storeGeneration, streamDelay } from "../store";
import type {
  ProductPage,
  ProductPresence,
  ProductPresenceView,
  ProductScriptStep,
} from "../types";
import { can, viewerFor } from "../viewer";
import { forbidden, invalid, notFound, writer } from "../writer";
import { emitProductPage } from "./events";
import { productPageById } from "./reads";
import { writeProductBlocksAs } from "./writes";

export { onProductPresence, subscribeProductPage } from "./events";

// La presenza nelle pagine di prodotto e i copioni dal vivo (area 11a,
// Task 5). Le regole:
// - una riga per persona e pagina (`state.productPresence`); ogni cambio
//   prende `nextSeq()`, mai l'orologio. `anchorId: null` = c'è ma non scrive;
// - entrare e guardare chiedono di leggere i Docs del progetto (`docsAccess`,
//   R-G5: invisibile, inesistente o col modulo spento sono «not_found»);
//   mettere il cursore in un'ancora chiede `docs.edit`, perché una presenza
//   con l'ancora SCRIVE (`writersNear`);
// - chi guarda riceve gli ALTRI presenti, solo quelli che vede e che leggono
//   ancora i Docs: nessun nome di chi non vede (R-G5);
// - il copione di una pagina parte al primo `joinProductPage` della
//   generazione dello store, una volta. Ogni passo aspetta `streamDelay()`
//   (nessun timer sull'orologio del prototipo) e scrive come la persona
//   finta con `writeProductBlocksAs` (sessione `script:<pagina>:<persona>`,
//   così le sue scritture fanno una revisione). Si ferma senza errori se la
//   generazione cambia (nello stato nuovo non tocca niente), se la pagina non
//   c'è più (la sua eliminazione ha già tolto le presenze e detto `gone`), se
//   la persona finta non legge più i Docs o se un passo non si può fare (la
//   sua presenza si toglie e gli iscritti ricevono `presence`);
// - `type` aggiunge il testo in fondo al contenuto di ADESSO dell'ancora
//   (ruling P40): se nel frattempo qualcuno ci ha scritto, il suo testo
//   resta, e se l'ancora non c'è più il copione si ferma.

/** Le pagine il cui copione è già partito in questa generazione dello store. */
const started = new Set<string>();
/** I copioni che hanno ancora passi da fare (`whenProductIdle`). */
const running = new Set<Promise<void>>();

onStoreReset(() => started.clear());

// --- le righe ------------------------------------------------------------------

const rowOf = (pageId: string, personId: string): ProductPresence | undefined =>
  state.productPresence.find((p) => p.pageId === pageId && p.personId === personId);

/** Mette (o aggiorna) la riga di una persona, con un `seq` nuovo, e lo dice agli iscritti. */
function putPresence(
  pageId: string,
  personId: string,
  at: { anchorId: string | null; offset: number; selection: [number, number] | null },
): void {
  const row = rowOf(pageId, personId);
  const next: ProductPresence = { pageId, personId, ...at, seq: nextSeq() };
  if (row) Object.assign(row, next);
  else state.productPresence.push(next);
  emitProductPage(pageId, "presence");
}

/** Toglie le righe di `personIds` nella pagina; avvisa solo se ce n'era qualcuna. */
function dropPresence(pageId: string, personIds: ReadonlySet<string>): void {
  const before = state.productPresence.length;
  state.productPresence = state.productPresence.filter(
    (p) => !(p.pageId === pageId && personIds.has(p.personId)),
  );
  if (state.productPresence.length !== before) emitProductPage(pageId, "presence");
}

/** La pagina in cui `me` è presente: esiste e ne legge i Docs. */
function readablePage(me: string, pageId: string): ProductPage {
  const page = productPageById(pageId);
  if (!page) throw notFound();
  const access = docsAccess(me, page.projectId);
  if (access === "none") throw notFound();
  if (access === "forbidden") throw forbidden();
  return page;
}

/** Il colore della presenza di una persona: lo stesso ovunque e a ogni ripristino. */
function presenceColor(personId: string): ProductPresenceView["color"] {
  let h = 0;
  for (const ch of personId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return ((h % 6) + 1) as ProductPresenceView["color"];
}

// --- chi guarda ---------------------------------------------------------------

/** Entra nella pagina (senza scrivere) e, la prima volta nella generazione, avvia il copione. */
export async function joinProductPage(pageId: string): Promise<void> {
  const me = await writer("productDocs.joinProductPage");
  readablePage(me, pageId);
  if (!rowOf(pageId, me)) putPresence(pageId, me, { anchorId: null, offset: 0, selection: null });
  startScript(pageId);
}

/** Esce dalla pagina, per chi ha già passato il cancello (il hook, al cambio di persona). */
export function leaveProductPageAs(me: string, pageId: string): void {
  dropPresence(pageId, new Set([me]));
}

/**
 * Dove scrive chi guarda (`null` = c'è ma non scrive). Con l'ancora chiede
 * `docs.edit`; l'ancora deve esserci adesso, e offset e selezione stanno
 * dentro la sua frase.
 */
export async function setProductPresence(
  pageId: string,
  at: { anchorId: string; offset: number; selection?: [number, number] | null } | null,
): Promise<void> {
  const me = await writer("productDocs.setProductPresence");
  const page = readablePage(me, pageId);
  if (at === null) {
    putPresence(pageId, me, { anchorId: null, offset: 0, selection: null });
    return;
  }
  if (!can(viewerFor(me), "docs.edit", page.projectId)) throw forbidden();
  const text = anchorText(page.blocks, at.anchorId);
  if (text === null) throw invalid("anchor");
  const within = (n: number) => Number.isInteger(n) && n >= 0 && n <= text.length;
  if (!within(at.offset)) throw invalid("offset");
  const selection = at.selection ?? null;
  if (selection && !(within(selection[0]) && within(selection[1]) && selection[0] <= selection[1]))
    throw invalid("selection");
  putPresence(pageId, me, { anchorId: at.anchorId, offset: at.offset, selection });
}

/** Gli altri presenti, come li vede chi guarda: nell'ordine in cui si sono mossi l'ultima volta. */
export async function getProductPresence(pageId: string): Promise<ProductPresenceView[]> {
  const me = await gate("productDocs.getProductPresence");
  const page = productPageById(pageId);
  if (!page) return [];
  const access = docsAccess(me, page.projectId);
  if (access === "forbidden") throw forbidden();
  if (access === "none") return [];
  // Oggi chi legge i Docs di un progetto è un membro attivo, quindi chi
  // guarda lo vede già: `seen` è difesa in profondità (R-G5), non l'unico filtro.
  const seen = visiblePeopleFor(me);
  return state.productPresence
    .filter(
      (p) =>
        p.pageId === pageId &&
        p.personId !== me &&
        seen.has(p.personId) &&
        docsAccess(p.personId, page.projectId) === "read",
    )
    .sort((a, b) => a.seq - b.seq)
    .flatMap((p) => {
      const person = PEOPLE.find((x) => x.id === p.personId);
      if (!person) return [];
      return [
        {
          ...p,
          selection: p.selection ? ([...p.selection] as [number, number]) : null,
          name: person.name,
          initials: person.initials,
          color: presenceColor(p.personId),
        },
      ];
    });
}

/**
 * IL SEGNALE DEL 11b: chi scrive adesso nella sezione dell'ancora (decisione
 * 4: un titolo e tutto ciò che gli sta sotto fino al prossimo titolo di
 * livello uguale o più alto). Conta anche chi guarda: anche la sua presenza
 * è qualcuno che scrive lì. Una presenza senza ancora non scrive; chi non
 * legge più i Docs non conta. Un'ancora che non c'è: nessuno. Sono id di
 * persone per il livello dati (il 11b decide se aspettare), mai nomi da
 * mostrare.
 */
export function writersNear(pageId: string, anchorId: string): string[] {
  const page = productPageById(pageId);
  if (!page || !page.blocks.some((b) => anchorIdsOf(b).includes(anchorId))) return [];
  const section = new Set(sectionRange(page.blocks, sectionOf(page.blocks, anchorId)));
  return state.productPresence
    .filter(
      (p) =>
        p.pageId === pageId &&
        p.anchorId !== null &&
        section.has(p.anchorId) &&
        docsAccess(p.personId, page.projectId) === "read",
    )
    .sort((a, b) => a.seq - b.seq)
    .map((p) => p.personId);
}

/** Si risolve quando nessun copione ha più passi in corso (test). */
export async function whenProductIdle(): Promise<void> {
  while (running.size > 0) await Promise.all([...running]);
}

// --- i copioni ----------------------------------------------------------------

/** L'attesa fra due passi; con latenza 0 basta un microtask. */
function pause(): Promise<void> {
  const ms = streamDelay();
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function startScript(pageId: string): void {
  const steps = PRODUCT_SCRIPTS[pageId];
  if (!steps || started.has(pageId)) return;
  started.add(pageId);
  const run = play(pageId, steps, storeGeneration()).finally(() => running.delete(run));
  running.add(run);
}

/** Un passo, come la persona finta; lancia se non si può fare (l'ancora non c'è più…). */
function stepOn(page: ProductPage, step: ProductScriptStep): void {
  const sessionId = `script:${page.id}:${step.personId}`;
  switch (step.step) {
    case "enter": {
      const text = step.anchorId === null ? "" : anchorText(page.blocks, step.anchorId);
      if (text === null) throw invalid("anchor");
      putPresence(page.id, step.personId, {
        anchorId: step.anchorId,
        offset: text.length,
        selection: null,
      });
      return;
    }
    case "insert":
      writeProductBlocksAs(
        step.personId,
        page.id,
        [
          {
            op: "insert",
            afterId: step.afterId,
            block: { id: step.blockId, type: "paragraph", content: { text: "", marks: [] } },
          },
        ],
        { sessionId },
      );
      putPresence(page.id, step.personId, { anchorId: step.blockId, offset: 0, selection: null });
      return;
    case "type": {
      const block = page.blocks.find((b) => b.id === step.anchorId);
      if (!block || !isTextBlock(block)) throw invalid("anchor");
      const content = insertText(block.content, block.content.text.length, step.text);
      writeProductBlocksAs(step.personId, page.id, [{ op: "set", block: { ...block, content } }], {
        sessionId,
      });
      putPresence(page.id, step.personId, {
        anchorId: step.anchorId,
        offset: content.text.length,
        selection: null,
      });
      return;
    }
    case "leave":
      dropPresence(page.id, new Set([step.personId]));
      return;
  }
}

async function play(
  pageId: string,
  steps: readonly ProductScriptStep[],
  at: number,
): Promise<void> {
  const cast = new Set(steps.map((s) => s.personId));
  for (const step of steps) {
    await pause();
    // Uno stato nuovo non è il suo: non tocca niente, nemmeno le presenze.
    if (at !== storeGeneration()) return;
    // La pagina eliminata ha già tolto le presenze e detto `gone`.
    const page = productPageById(pageId);
    if (!page) return;
    // Chi del copione non legge più i Docs esce; se tocca a lui, il copione finisce.
    const lost = new Set([...cast].filter((id) => docsAccess(id, page.projectId) !== "read"));
    dropPresence(pageId, lost);
    if (lost.has(step.personId)) return;
    try {
      stepOn(page, step);
    } catch {
      // Un passo che non si può più fare (ancora tolta, `docs.edit` perso):
      // il copione si ferma, e la persona finta se ne va.
      dropPresence(pageId, new Set([step.personId]));
      return;
    }
  }
}
