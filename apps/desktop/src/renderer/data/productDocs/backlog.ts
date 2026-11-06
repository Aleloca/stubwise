import { backlogCandidatesOf } from "../../domain/productDocs/backlog";
import { docsAccess } from "../docs/reads";
import { gate, state, visibleProjectIds } from "../store";
import type {
  ProductDocOrigin,
  ProductLinkedRequest,
  ProductOrigin,
  ProjectRequest,
  ProposalNote,
  ProposedAction,
  Task,
} from "../types";
import { invalid } from "../writer";
import { productPageById } from "./reads";
import { editablePage } from "./writes";

// Dalla doc al backlog (11b, Task 7; spec «Dalla doc al backlog», shape
// product-claude-backlog.md §3.1–3.4). Le regole:
// - le voci le propone chi ha `docs.edit` nel progetto (`editablePage`); il
//   permesso del backlog lo controlla la scheda alla conferma, come oggi
//   (`createRequest` del catalogo);
// - ogni voce è un `createRequest` con `origin.product_doc` (pagina e
//   ancora): titolo e descrizione sono la frase della pagina
//   (`backlogCandidatesOf`), mai un'urgenza o una stima che la pagina non
//   dice (anti-obiettivo «decisioni inventate»), e mai il codice o il titolo
//   della pagina: la descrizione si salva, e la legge anche chi la pagina
//   non la vede (R-G5);
// - una frase già proposta (una richiesta con la stessa pagina e la stessa
//   ancora) non torna: diventa la nota `already_proposed`, coi codici che
//   chi chiede vede e il numero degli altri;
// - il legame è con la PAGINA (spec): «Dalla doc: <pagina>» si deriva in
//   lettura (`productOriginOf`, P38) e c'è solo se chi guarda legge la
//   pagina (R-G5: altrimenti la riga non c'è, nessun codice tenue).

const originOf = (r: ProjectRequest): ProductDocOrigin | null =>
  r.origin?.kind === "product_doc" ? r.origin : null;

/** Le richieste nate da una pagina, nell'ordine di nascita. */
const requestsFromPage = (pageId: string): ProjectRequest[] =>
  state.requests.filter((r) => originOf(r)?.pageId === pageId);

/**
 * Le voci di backlog che `me` può proporre da una pagina, o dalla sola
 * sezione del titolo `fromAnchorId` (`invalid: anchor` se non è un titolo
 * della pagina). Sincrona: per chi ha già passato il cancello (il riquadro
 * di Claude, Task 8). `not_found` / `forbidden` come le scritture della doc.
 */
export function proposeBacklogFromPageAs(
  me: string,
  pageId: string,
  fromAnchorId?: string,
): { actions: ProposedAction[]; notes: ProposalNote[] } {
  const page = editablePage(me, pageId);
  const from = fromAnchorId ?? null;
  if (from !== null && page.blocks.find((b) => b.id === from)?.type !== "heading") throw invalid("anchor");

  const project = state.projectsById.get(page.projectId)!;
  const existing = requestsFromPage(page.id);
  const proposed = new Set(existing.map((r) => originOf(r)!.anchorId));
  const candidates = backlogCandidatesOf(page.blocks, from);

  const actions: ProposedAction[] = candidates
    .filter((c) => !proposed.has(c.anchorId))
    .map((c) => {
      const origin: ProductDocOrigin = { kind: "product_doc", pageId: page.id, anchorId: c.anchorId };
      return {
        fn: "createRequest",
        args: { projectId: page.projectId, title: c.title, description: c.description, origin },
        summary: `Open a request in ${project.code}: “${c.title}”`,
        summaryText: { key: "claude.answers.request.summary", params: { code: project.code, title: c.title } },
        why: { key: "claude.answers.productDocs.backlog.why", params: { sentence: c.sentence } },
      };
    });

  // Le già proposte, nell'ordine della pagina: solo le frasi fra le candidate.
  const order = new Map(candidates.map((c, i) => [c.anchorId, i] as const));
  const already = existing
    .filter((r) => order.has(originOf(r)!.anchorId ?? ""))
    .sort((a, b) => order.get(originOf(a)!.anchorId!)! - order.get(originOf(b)!.anchorId!)!);
  const visible = visibleProjectIds(me);
  const shown = already.filter((r) => visible.has(r.projectId));
  const notes: ProposalNote[] =
    already.length > 0
      ? [{ kind: "already_proposed", codes: shown.map((r) => r.code), hidden: already.length - shown.length }]
      : [];
  return { actions, notes };
}

export async function proposeBacklogFromPage(
  pageId: string,
  fromAnchorId?: string,
): Promise<{ actions: ProposedAction[]; notes: ProposalNote[] }> {
  return proposeBacklogFromPageAs(await gate("productDocs.proposeBacklogFromPage"), pageId, fromAnchorId);
}

/**
 * La pagina da cui nasce una richiesta, o la richiesta d'origine di una
 * task; `null` se non nasce dalla doc, o se `me` non legge la pagina (Docs
 * spenti, pagina eliminata, progetto invisibile). Le pagine non la chiamano:
 * la leggono in `productOrigin` della richiesta (P38).
 */
export function productOriginOf(me: string, item: ProjectRequest | Task): ProductOrigin | null {
  const request =
    "taskIds" in item ? item : item.requestId === null ? undefined : state.requests.find((r) => r.id === item.requestId);
  const origin = request ? originOf(request) : null;
  if (!request || !origin || !visibleProjectIds(me).has(request.projectId)) return null;
  const page = productPageById(origin.pageId);
  if (!page || docsAccess(me, page.projectId) !== "read") return null;
  return { pageId: page.id, code: page.code, title: page.title };
}

/** Le richieste nate dalla pagina che `me` vede; nulla se non legge la pagina. */
export function listProductLinkedRequestsAs(me: string, pageId: string): ProductLinkedRequest[] {
  const page = productPageById(pageId);
  if (!page || docsAccess(me, page.projectId) !== "read") return [];
  const visible = visibleProjectIds(me);
  const deleted = new Set(state.deletedTasks.map((d) => d.id));
  return requestsFromPage(page.id)
    .filter((r) => visible.has(r.projectId))
    .map((r) => ({
      id: r.id,
      code: r.code,
      title: r.title,
      status: r.status,
      taskCodes: r.taskIds.flatMap((id) => {
        const task = deleted.has(id) ? undefined : state.tasksById.get(id);
        return task ? [task.code] : [];
      }),
    }));
}

export async function listProductLinkedRequests(pageId: string): Promise<ProductLinkedRequest[]> {
  return listProductLinkedRequestsAs(await gate("productDocs.listProductLinkedRequests"), pageId);
}
