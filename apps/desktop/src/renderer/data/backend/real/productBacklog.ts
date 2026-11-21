import { ApiError } from "@stubwise/api-client";
import type * as Fake from "../../api";
import type { ProductDocOrigin, ProposalNote, ProposedAction, RequestStatus } from "../../types";
import { appClient } from "./client";
import { lastReadProductPage } from "./productDocs";

// Dalla doc al backlog nella build app (area 11, F6; R11-6), sulle forme di
// 72 (a2e2bd051). Le voci da proporre e le già proposte le dà il server
// (`backlogCandidates`); la scheda B la compone il renderer, come il
// prototipo (`proposeBacklogFromPageAs`): una `createRequest` per voce, con
// l'origine della pagina. La conferma passa dalla rotta delle richieste, che
// rifiuta una frase già proposta (409 `already_proposed`). «From this page»
// è `linkedRequests`. Dietro `product-claude-actions`, spento.

type ProductDocs = typeof Fake.productDocs;

/** Il progetto della pagina: dall'ultima lettura, o dallo spazio. */
async function projectOf(pageId: string): Promise<{ id: string; code: string }> {
  const page = lastReadProductPage(pageId);
  if (!page) throw new Error("not_found");
  const space = await appClient().productDocs.space(page.projectId);
  return { id: page.projectId, code: space.projectCode };
}

export const liveProductBacklog: Partial<ProductDocs> = {
  async proposeBacklogFromPage(pageId, fromAnchorId) {
    let out: Awaited<ReturnType<ReturnType<typeof appClient>["productDocs"]["backlogCandidates"]>>;
    try {
      out = await appClient().productDocs.backlogCandidates(pageId, fromAnchorId);
    } catch (error) {
      if (error instanceof ApiError && error.code === "invalid_anchor")
        throw new Error("invalid: anchor");
      if (error instanceof ApiError && error.status === 403) throw new Error("forbidden");
      if (error instanceof ApiError && error.status === 404) throw new Error("not_found");
      throw error;
    }
    const project = await projectOf(pageId);
    const actions: ProposedAction[] = out.candidates.map((c) => {
      const origin: ProductDocOrigin = { kind: "product_doc", pageId, anchorId: c.anchorId };
      return {
        fn: "createRequest",
        args: { projectId: project.id, title: c.title, description: c.description, origin },
        summary: `Open a request in ${project.code}: “${c.title}”`,
        summaryText: {
          key: "claude.answers.request.summary",
          params: { code: project.code, title: c.title },
        },
        why: { key: "claude.answers.productDocs.backlog.why", params: { sentence: c.sentence } },
      };
    });
    const { codes, hidden } = out.alreadyProposed;
    const notes: ProposalNote[] =
      codes.length + hidden > 0 ? [{ kind: "already_proposed", codes: [...codes], hidden }] : [];
    return { actions, notes };
  },

  // «Una richiesta è in preparazione…» nella build app la dice la scheda
  // aperta nel filo (decisione del maintainer, strada 1): nessuna proposta
  // del riquadro la tiene aperta, quindi qui non ce n'è nessuna.
  async listProductRequestsPreparing() {
    return [];
  },

  async listProductLinkedRequests(pageId) {
    try {
      const rows = await appClient().productDocs.linkedRequests(pageId);
      return rows.map((r) => ({
        id: r.id,
        code: r.code,
        title: r.title,
        status: r.status as RequestStatus,
        taskCodes: [...r.taskCodes],
      }));
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 403)) return [];
      throw error;
    }
  },
};
