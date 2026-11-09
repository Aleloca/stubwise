import { PRODUCT_SOURCE_FACTS } from "../seed/productDocs/facts";
import { state } from "../store";
import type { MailMessage, ProductFact, ProductSourceRef } from "../types";
import { applyProductSource } from "./claude";

// Dove arriva una fonte della doc di prodotto (11b, Task 5). I punti
// d'arrivo chiamano `noteProductSource` con la fonte e i progetti a cui
// appartiene; i fatti li sa il seme (`PRODUCT_SOURCE_FACTS`, nessun modello),
// e cosa farne lo decide il motore (`applyProductSource`). I punti:
// - un'email (o l'email di Gemini di una riunione) classificata in un
//   progetto (`advanceClassification`, `data/mail/writes.ts`), o attribuita a
//   mano (`chooseProjectFor`, `reassignMailProposal`, `data/mail/proposals.ts`);
// - una decisione registrata (`recordDecisionAs`, `data/api-mutations.ts`:
//   a mano o da una proposta della posta). Le voci scritte dalle risposte
//   alle domande di Claude e dalle revisioni dei piani NON sono fonti: non
//   passano da lì;
// - una task che passa a uno stato chiuso (`commitTaskPatch`, dove parte
//   `task_closed`);
// - il merge di una PR che fa nascere un rilascio (`mergePr`,
//   `data/releases/writes.ts`).
// Una fonte già passata non riscrive niente (`productSourcesSeen` del
// motore): un'email riproposta, una task riaperta e richiusa, un'email
// spostata e riportata nello stesso progetto.

/**
 * Le chiavi dei fatti di una fonte: `<kind>:<id>`, e per le fonti che
 * nascono all'arrivo (il loro id non c'è prima) quella del seme: il titolo
 * della decisione, la PR del rilascio.
 */
function factKeys(ref: ProductSourceRef): string[] {
  if (ref.kind === "first_version") return [];
  const keys = [`${ref.kind}:${ref.id}`];
  if (ref.kind === "decision") {
    const d = state.decisionLog.find((x) => x.id === ref.id);
    if (d) keys.push(`decision:${d.title}`);
  }
  if (ref.kind === "release") {
    const r = state.releases.find((x) => x.id === ref.id);
    if (r) keys.push(`release:${r.pr.repo}#${r.pr.number}`);
  }
  return keys;
}

/** I fatti che una fonte dice alla doc (seme); nessuno = la fonte non la riguarda. */
export function productFactsOf(ref: ProductSourceRef): readonly ProductFact[] {
  for (const key of factKeys(ref)) {
    const facts = PRODUCT_SOURCE_FACTS[key];
    if (facts) return facts;
  }
  return [];
}

const projectOfPage = (pageId: string): string | undefined =>
  state.productPages.find((p) => p.id === pageId)?.projectId;

/** Le fonti arrivate dentro un gruppo di azioni ancora aperto (`holdProductSources`). */
let held: { ref: ProductSourceRef; projectIds: readonly string[] }[] | null = null;

/**
 * Trattiene le fonti che arrivano finché un gruppo di azioni «tutto o
 * niente» (`applyActions`) non è riuscito: una decisione registrata o una
 * task chiusa da un gruppo che poi fallisce torna indietro col ripristino,
 * e la doc non deve averla vista. `release` le porta al motore, `discard` le
 * dimentica. Come `holdAutomationSignals`: solo il più esterno rilascia.
 */
export function holdProductSources(): { release(): void; discard(): void } {
  const outer = held === null;
  if (outer) held = [];
  const from = held!.length;
  return {
    release() {
      if (!outer || held === null) return;
      const arrived = held;
      held = null;
      for (const a of arrived) noteProductSource(a.ref, a.projectIds);
    },
    discard() {
      if (held === null) return;
      held.length = from;
      if (outer) held = null;
    },
  };
}

/**
 * Una fonte è arrivata nei progetti `projectIds`: i suoi fatti sulle pagine
 * di ciascuno vanno al motore. Un progetto senza spazio Prodotto (nessuna
 * pagina dei fatti) o una fonte senza fatti: niente. Non lancia mai: chi la
 * chiama è una scrittura che è già riuscita.
 */
export function noteProductSource(ref: ProductSourceRef, projectIds: readonly string[]): void {
  if (held !== null) {
    held.push({ ref, projectIds: [...projectIds] });
    return;
  }
  const facts = productFactsOf(ref);
  if (facts.length === 0) return;
  for (const projectId of new Set(projectIds)) {
    const mine = facts.filter((f) => projectOfPage(f.pageId) === projectId);
    if (mine.length === 0) continue;
    try {
      applyProductSource(ref, projectId, mine);
    } catch (error) {
      console.error("noteProductSource: the product doc could not be updated", error);
    }
  }
}

/**
 * Un messaggio della posta come fonte: l'email di Gemini è la riunione, ma
 * solo col documento letto (prima non c'è niente da dire alla doc); ogni
 * altro messaggio è un'email. `null` = non ancora una fonte.
 */
export function productSourceOfMessage(m: MailMessage): ProductSourceRef | null {
  if (m.kind !== "transcript") return { kind: "email", id: m.id };
  const t = state.meetingTranscripts.find((x) => x.messageId === m.id);
  return t?.doc === "ready" ? { kind: "meeting", id: m.id } : null;
}

/** Un messaggio della posta è arrivato (o è stato attribuito) nei progetti `projectIds`. */
export function noteMailSource(m: MailMessage, projectIds: readonly string[]): void {
  const ref = productSourceOfMessage(m);
  if (ref && projectIds.length > 0) noteProductSource(ref, projectIds);
}
