import { docsAccess } from "../docs/reads";
import { PEOPLE } from "../seed/people";
import { now, state } from "../store";
import { can, viewerFor } from "../viewer";
import { forbidden, notFound, writer } from "../writer";
import { productPageById } from "./reads";

// Chi segue una pagina di prodotto (area 11a). Segue solo chi la crea e chi
// preme «Follow»; commentare o essere menzionati non fa seguire (maintainer,
// 5 nov 2026). Seguire chiede la sola lettura. Chi segue e non legge più la
// pagina (permesso perso, modulo spento, progetto non più visibile) esce
// dagli elenchi a lettura, senza che la sua riga si riscriva.

/** La pagina su cui si agisce: chi agisce la legge (altrimenti non esiste). */
function readablePage(me: string, pageId: string) {
  const page = productPageById(pageId);
  if (!page) throw notFound();
  const access = docsAccess(me, page.projectId);
  if (access === "none") throw notFound();
  if (access === "forbidden") throw forbidden();
  return page;
}

/** Segue la pagina (una riga per persona: seguire di nuovo non cambia nulla). */
export function followAs(me: string, pageId: string): void {
  readablePage(me, pageId);
  if (state.productFollows.some((f) => f.pageId === pageId && f.personId === me)) return;
  state.productFollows.push({ pageId, personId: me, since: now() });
}

export async function followProductPage(pageId: string): Promise<void> {
  followAs(await writer("productDocs.followProductPage"), pageId);
}

export async function unfollowProductPage(pageId: string): Promise<void> {
  const me = await writer("productDocs.unfollowProductPage");
  readablePage(me, pageId);
  state.productFollows = state.productFollows.filter(
    (f) => !(f.pageId === pageId && f.personId === me),
  );
}

/** Chi segue la pagina e la legge ADESSO (un permesso perso toglie, senza riscrivere). */
export function followersOf(pageId: string): string[] {
  const page = productPageById(pageId);
  if (!page) return [];
  return state.productFollows
    .filter((f) => f.pageId === pageId && docsAccess(f.personId, page.projectId) === "read")
    .map((f) => f.personId);
}

/**
 * Chi riceve gli avvisi della pagina (11b): chi la segue; se nessuno, chi ha
 * `docs.edit` nel progetto e la legge. Mai Claude.
 */
export function productDocRecipients(pageId: string): string[] {
  const page = productPageById(pageId);
  if (!page) return [];
  const followers = followersOf(pageId).filter((id) => !isClaude(id));
  if (followers.length > 0) return followers;
  return PEOPLE.filter(
    (p) =>
      !p.isClaude &&
      docsAccess(p.id, page.projectId) === "read" &&
      can(viewerFor(p.id), "docs.edit", page.projectId),
  ).map((p) => p.id);
}

const isClaude = (personId: string) => PEOPLE.some((p) => p.id === personId && p.isClaude);
