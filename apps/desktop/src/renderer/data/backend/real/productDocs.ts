import { ApiError } from "@stubwise/api-client";
import {
  PRODUCT_BLOCK_TYPES,
  PRODUCT_IMAGE_REF_PREFIX,
  buildProductTree,
  productImageRefSchema,
  productBlockSchema,
  type ProductPageView as ServerPageView,
  type ProductRevisionView as ServerRevisionView,
} from "@stubwise/shared";
import type * as Fake from "../../api";
import i18n from "../../../i18n";
import type {
  ProductBlock,
  ProductBlockChange,
  ProductPage,
  ProductPageView,
  ProductRevisionView,
} from "../../types";
import { appClient } from "./client";
import { authedDataUrl } from "./transport";

// Lo spazio Product nella build app (area 11, F1 di 72; R11-1): lo spazio, la
// pagina per codice, crea, rinomina, sposta, elimina, la scrittura a
// operazioni, la cronologia in lettura, Segui e le immagini, sulle rotte di
// `client.productDocs`. Le forme sono quelle del prototipo:
// - lo spazio dà le pagine IN FILA: l'albero lo fa `buildProductTree`;
// - i blocchi arrivano come record, letti uno per uno con
//   `productBlockSchema`; un tipo che questo renderer non conosce si salta
//   (la pagina resta);
// - la scrittura vuole `baseSeq` (l'ultima revisione vista): si ricorda per
//   pagina dalla lettura e dai salvataggi. Un 409 `stale` porta le revisioni
//   mancanti di un altro: se ne prende l'ultima e si riprova una volta (le
//   operazioni nominano i blocchi per id, e la pagina si rilegge dopo);
// - un'immagine è `product-image:<id>`, aperta dalla rotta dell'immagine.
// Commenti, ricerca ed esportazione, dal vivo e Claude restano delle fette
// dopo (F2–F6): qui non ci sono.

const KNOWN_TYPES = new Set<string>(PRODUCT_BLOCK_TYPES);
/** Una pagina della cronologia sul server, e quante se ne leggono al più (5000 revisioni). */
const REVISION_PAGE = 100;
const REVISION_ROUNDS_MAX = 50;

/** Un errore nella forma del prototipo (`forbidden`, `invalid: …`, `not_found`). */
const fail = (message: string) => new Error(message);

function mapError(error: unknown): never {
  if (error instanceof ApiError) {
    if (error.status === 403) throw fail("forbidden");
    if (error.status === 404) throw fail("not_found");
    // Un 409 dell'albero (`has_children`, `cycle`, `too_deep`, `too_many_pages`)
    // non cambia riprovando; `stale` sì (lo riprova il salvataggio, poi la fila).
    if (error.status === 409 && error.code !== "stale")
      throw fail(`invalid: ${error.code ?? "conflict"}`);
    if (error.status === 422 || error.status === 400 || error.status === 413)
      throw fail(`invalid: ${error.code ?? "input"}`);
  }
  throw error;
}

/** I blocchi letti: il noto, validato; un tipo futuro (o un record rotto) si salta. */
export function blocksOf(raw: readonly unknown[]): ProductBlock[] {
  return raw.flatMap((b) => {
    const parsed = productBlockSchema.safeParse(b);
    return parsed.success && KNOWN_TYPES.has(parsed.data.type) ? [parsed.data as ProductBlock] : [];
  });
}

/** L'ultima revisione vista per pagina (`baseSeq` della scrittura) e il codice di ogni pagina letta. */
const seqOf = new Map<string, number>();
const codeOf = new Map<string, string>();

/** Solo nei test, e al cambio di persona. */
export function forgetProductDocs(): void {
  seqOf.clear();
  codeOf.clear();
}

function pageOf(v: ServerPageView): ProductPage {
  return {
    id: v.id,
    code: v.code,
    projectId: v.projectId,
    parentId: v.parentId,
    order: v.order,
    title: v.title,
    blocks: blocksOf(v.blocks),
    createdById: v.createdById ?? "",
    createdAt: v.createdAt,
    updatedById: v.updatedById ?? "",
    updatedAt: v.updatedAt,
  };
}

async function readPage(code: string): Promise<ProductPageView | null> {
  let v: ServerPageView;
  try {
    v = (await appClient().productDocs.page(code)) as ServerPageView;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    return mapError(error);
  }
  // Mai indietro: una lettura arrivata dopo un salvataggio non riporta `baseSeq` a prima.
  seqOf.set(v.id, Math.max(seqOf.get(v.id) ?? 0, v.seq));
  codeOf.set(v.id, v.code);
  return {
    ...pageOf(v),
    breadcrumbs: v.breadcrumbs,
    permissions: {
      edit: v.permissions.edit,
      delete: v.permissions.delete,
      // Il server spegne l'eliminazione a chi potrebbe eliminare solo per le sottopagine.
      deleteBlocked: v.permissions.edit && !v.permissions.delete ? "has_children" : null,
    },
    following: v.following,
    decisions: v.decisions,
    // I commenti arrivano con F2: nessun filo.
    openComments: 0,
  };
}

/** Il codice di una pagina già letta, o la rilettura dallo spazio non c'è: la pagina si rilegge per codice. */
const codeFor = (pageId: string): string => {
  const code = codeOf.get(pageId);
  if (!code) throw fail("not_found");
  return code;
};

const reread = async (pageId: string): Promise<ProductPage> => {
  const page = await readPage(codeFor(pageId));
  if (!page) throw fail("not_found");
  return page;
};

function revisionOf(r: ServerRevisionView): ProductRevisionView {
  return {
    id: r.id,
    pageId: r.pageId,
    seq: r.seq,
    lastSeq: r.lastSeq,
    at: r.updatedAt,
    actorId: r.actorId ?? "",
    ...(r.sessionId ? { sessionId: r.sessionId } : {}),
    kind: r.kind as ProductRevisionView["kind"],
    changes: r.changes.flatMap((c): ProductBlockChange[] => {
      const x = c as {
        blockId?: unknown;
        before?: unknown;
        after?: unknown;
        anchors?: unknown;
        mergedFrom?: unknown;
      };
      if (typeof x.blockId !== "string") return [];
      const one = (b: unknown) => (b == null ? null : (blocksOf([b])[0] ?? null));
      return [
        {
          blockId: x.blockId,
          before: one(x.before),
          after: one(x.after),
          anchors: Array.isArray(x.anchors)
            ? x.anchors.filter((a): a is string => typeof a === "string")
            : [],
          ...(x.mergedFrom ? { mergedFrom: x.mergedFrom as ProductBlockChange["mergedFrom"] } : {}),
        },
      ];
    }),
    ...(r.title ? { title: r.title } : {}),
    ...(r.parent ? { parent: r.parent } : {}),
    // Chi ha scritto, se chi guarda lo vede (R-G5); altrimenti «Someone».
    actorName: r.actorName ?? i18n.t("productDocs.history.someone"),
  };
}

type ProductDocs = typeof Fake.productDocs;

export const liveProductDocs: Partial<ProductDocs> = {
  async getProductSpace(projectId) {
    let v;
    try {
      v = await appClient().productDocs.space(projectId);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      return mapError(error);
    }
    for (const p of v.pages) codeOf.set(p.id, p.code);
    return {
      projectId: v.projectId,
      projectCode: v.projectCode,
      tree: buildProductTree(v.pages),
      pageCount: v.pageCount,
      recent: v.recent,
      permissions: v.permissions,
    };
  },

  getProductPage: (code) => readPage(code),

  async createProductPage(projectId, input) {
    let created: { id: string; code: string };
    try {
      created = await appClient().productDocs.create(projectId, {
        title: input.title,
        ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
        ...(input.index !== undefined ? { index: input.index } : {}),
      });
    } catch (error) {
      return mapError(error);
    }
    codeOf.set(created.id, created.code);
    return reread(created.id);
  },

  async renameProductPage(pageId, title) {
    try {
      await appClient().productDocs.update(pageId, { title });
    } catch (error) {
      return mapError(error);
    }
    return reread(pageId);
  },

  async moveProductPage(pageId, to) {
    try {
      await appClient().productDocs.update(pageId, {
        move: { parentId: to.parentId, index: to.index },
      });
    } catch (error) {
      return mapError(error);
    }
    return reread(pageId);
  },

  async deleteProductPage(pageId) {
    try {
      await appClient().productDocs.remove(pageId);
    } catch (error) {
      return mapError(error);
    }
    seqOf.delete(pageId);
  },

  async saveProductBlocks(pageId, ops, opts) {
    const client = appClient().productDocs;
    const body = (baseSeq: number) => ({
      sessionId: opts.sessionId,
      baseSeq,
      ops,
      ...(opts.undoOf ? { undoOf: opts.undoOf } : {}),
    });
    let saved: { seq: number; revisionId: string | null };
    try {
      saved = await client.save(pageId, body(seqOf.get(pageId) ?? 0));
    } catch (error) {
      const newer = staleRevisions(error);
      if (!newer) return mapError(error);
      // Le revisioni di un altro arrivate nel frattempo: le si prende come viste e si riprova una volta.
      const seq = Math.max(seqOf.get(pageId) ?? 0, ...newer.map((r) => r.lastSeq));
      seqOf.set(pageId, seq);
      try {
        saved = await client.save(pageId, body(seq));
      } catch (again) {
        return mapError(again);
      }
    }
    seqOf.set(pageId, saved.seq);
    return { ...(await reread(pageId)), revisionId: saved.revisionId };
  },

  async listProductRevisions(pageId) {
    try {
      // A pagine di 100, dalla più recente: `before` è il `lastSeq` più vecchio
      // già letto. Il prototipo dà la cronologia intera; il tetto ferma un giro
      // che non finisse.
      const all: ServerRevisionView[] = [];
      let before: number | undefined;
      for (let round = 0; round < REVISION_ROUNDS_MAX; round++) {
        const rows = (await appClient().productDocs.revisions(
          pageId,
          before,
        )) as ServerRevisionView[];
        all.push(...rows);
        if (rows.length < REVISION_PAGE) break;
        before = Math.min(...rows.map((r) => r.lastSeq));
      }
      return all.map(revisionOf);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return [];
      return mapError(error);
    }
  },

  async followProductPage(pageId) {
    try {
      await appClient().productDocs.follow(pageId, true);
    } catch (error) {
      mapError(error);
    }
  },

  // Il file l'ha già controllato l'editor (tipo e misura); il server lo
  // ricontrolla e dà il riferimento del blocco. Il `data:` URL letto non serve.
  async storeProductImage(pageId, file) {
    try {
      return (await appClient().productDocs.uploadImage(pageId, file, file.name)).ref;
    } catch (error) {
      return mapError(error);
    }
  },

  // Solo un riferimento del server si carica: dalla rotta dell'immagine
  // (302 verso un URL firmato breve), come data URL perché sul desktop il
  // token sta nel main e la CSP ammette solo `data:` (`authedDataUrl`).
  async productImageSrc(pageId, src) {
    if (!productImageRefSchema.safeParse(src).success) return null;
    return authedDataUrl(
      appClient().productDocs.imagePath(pageId, src.slice(PRODUCT_IMAGE_REF_PREFIX.length)),
    );
  },

  async unfollowProductPage(pageId) {
    try {
      await appClient().productDocs.follow(pageId, false);
    } catch (error) {
      mapError(error);
    }
  },
};

/**
 * La card Product della Home dei Docs (R11-1): dallo spazio, il numero di
 * pagine, l'ultima modifica e se chi guarda scrive. Senza spazio per chi
 * guarda (404) o senza `docs.view` (403) la card non c'è; un altro errore
 * la lascia fuori senza rompere la Home.
 */
export async function productHomeOf(
  projectId: string,
): Promise<{ pageCount: number; updatedAt: string | null; canEdit: boolean } | null> {
  try {
    const v = await appClient().productDocs.space(projectId);
    return {
      pageCount: v.pageCount,
      updatedAt:
        v.pages
          .map((p) => p.updatedAt)
          .sort()
          .at(-1) ?? null,
      canEdit: v.permissions.edit,
    };
  } catch {
    return null;
  }
}

/** Le revisioni di un 409 `stale` (`ApiError.details.revisions`), o `null` per ogni altro errore. */
function staleRevisions(error: unknown): { lastSeq: number }[] | null {
  if (!(error instanceof ApiError) || error.status !== 409 || error.code !== "stale") return null;
  const revisions = (error.details as { revisions?: unknown } | undefined)?.revisions;
  return Array.isArray(revisions)
    ? revisions.filter(
        (r): r is { lastSeq: number } => typeof (r as { lastSeq?: unknown })?.lastSeq === "number",
      )
    : [];
}
