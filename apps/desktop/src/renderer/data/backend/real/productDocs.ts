import { ApiError } from "@stubwise/api-client";
import {
  PRODUCT_BLOCK_TYPES,
  PRODUCT_IMAGE_REF_PREFIX,
  applyBlockOps,
  buildProductTree,
  productImageRefSchema,
  productBlockSchema,
  type ProductCommentView as ServerCommentView,
  type ProductExportPage,
  type ProductExportSpace,
  type ProductPageView as ServerPageView,
  type ProductRevisionView as ServerRevisionView,
} from "@stubwise/shared";
import type * as Fake from "../../api";
import i18n from "../../../i18n";
import type {
  ProductBlock,
  ProductBlockChange,
  ProductBlockOp,
  ProductCommentThread,
  ProductCommentView,
  ProductPage,
  ProductPageView,
  ProductExportView,
  ProductRevisionView,
  ProductSearchHit,
} from "../../types";
import { appClient } from "./client";
import { citableSearch } from "./globalSearch";
import { liveProductPresence } from "./productLive";
import { authedDataUrl, ipcFetch } from "./transport";

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
/** Le immagini che la rotta dà (mai SVG, che può portare script). */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Un errore nella forma del prototipo (`forbidden`, `invalid: …`, `not_found`). */
const fail = (message: string) => new Error(message);

function mapError(error: unknown): never {
  if (error instanceof ApiError) {
    if (error.status === 403) throw fail("forbidden");
    if (error.status === 404) throw fail("not_found");
    // F4 (bozza del piano): la sezione la tiene un altro che ci scrive. Il
    // blocco resta com'era e la barra dice chi, se chi guarda lo vede.
    if (error.status === 409 && error.code === "section_busy") {
      const by = (error.details as { by?: { name?: unknown } | string } | undefined)?.by;
      const name = typeof by === "string" ? by : typeof by?.name === "string" ? by.name : undefined;
      throw Object.assign(fail("section_busy"), name ? { by: name } : {});
    }
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
/** L'ultima pagina letta: se la rilettura dopo una scrittura riuscita non riesce, si ricostruisce da qui. */
const lastRead = new Map<string, ProductPageView>();

/** Al cambio di persona (`session.ts`) e nei test. */
export function forgetProductDocs(): void {
  seqOf.clear();
  codeOf.clear();
  lastRead.clear();
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
  // Mai indietro (revisione di R11-4, 3): una lettura partita prima di un
  // salvataggio e arrivata dopo ha un `seq` più vecchio; la pagina resta quella
  // già letta, più nuova.
  const known = seqOf.get(v.id) ?? 0;
  const newer = lastRead.get(v.id);
  if (v.seq < known && newer) return newer;
  seqOf.set(v.id, Math.max(known, v.seq));
  codeOf.set(v.id, v.code);
  const page: ProductPageView = {
    ...pageOf(v),
    seq: v.seq,
    breadcrumbs: v.breadcrumbs,
    permissions: {
      edit: v.permissions.edit,
      delete: v.permissions.delete,
      // Il perché dell'eliminazione spenta lo dice il server (`deleteBlockedBy`,
      // M1): «children» è la frase delle sottopagine; senza `docs.edit` il
      // gesto non c'è, e la frase non serve.
      deleteBlocked: v.deleteBlockedBy === "children" ? "has_children" : null,
    },
    following: v.following,
    decisions: v.decisions,
    // Le radici non risolte, con l'ancora viva o no: le conta il server (F2).
    openComments: v.openComments,
  };
  lastRead.set(v.id, page);
  // La sezione del cursore nel battito (F4) si calcola sui blocchi di adesso.
  liveProductPresence.rememberBlocks(v.id, page.blocks, v.seq);
  return page;
}

/** Il codice di una pagina già letta, o la rilettura dallo spazio non c'è: la pagina si rilegge per codice. */
const codeFor = (pageId: string): string => {
  const code = codeOf.get(pageId);
  if (!code) throw fail("not_found");
  return code;
};

const reread = async (pageId: string): Promise<ProductPageView> => {
  const page = await readPage(codeFor(pageId));
  if (!page) throw fail("not_found");
  return page;
};

/**
 * La rilettura dopo una scrittura RIUSCITA (I1 della revisione): se non
 * riesce, la scrittura non sembra fallita — un Retry la rifarebbe (una pagina
 * doppia, operazioni già applicate). Si risponde dall'ultima lettura, cambiata
 * come la scrittura; la cache si rilegge comunque dopo (`useWrite`).
 */
async function rereadOr(
  pageId: string,
  fallback: (last: ProductPageView) => ProductPageView,
): Promise<ProductPageView> {
  try {
    return await reread(pageId);
  } catch {
    const last = lastRead.get(pageId);
    const page = fallback(last ?? ({} as ProductPageView));
    if (!page.id) throw fail("not_found");
    lastRead.set(pageId, page);
    return page;
  }
}

/** Lo spazio oltre il tetto dell'esportazione (413 `too_many_pages`): `too_large`, col numero (`count`) e il tetto. */
function tooLarge(error: ApiError): Error & { pageCount?: number; max?: number } {
  const d = (error.details ?? {}) as { count?: unknown; max?: unknown };
  return Object.assign(fail("too_large"), {
    ...(typeof d.count === "number" ? { pageCount: d.count } : {}),
    ...(typeof d.max === "number" ? { max: d.max } : {}),
  });
}

/** Quante immagini dell'esportazione si leggono insieme (I1 della revisione di R11-3). */
const EXPORT_IMAGE_CONCURRENCY = 4;

/**
 * Il lettore delle immagini di UNA esportazione, come data URL: il PDF del
 * desktop (CSP `img-src 'self' data:`) e il Word vogliono i byte. Si leggono
 * dalla rotta dell'immagine (`authedDataUrl`: dal main sul desktop, col
 * cookie sul web), mai dall'URL firmato dello storage; al più
 * `EXPORT_IMAGE_CONCURRENCY` insieme, e la stessa immagine una volta sola.
 * Un'immagine che non si legge, o che non è PNG/JPEG/GIF/WebP, resta col suo
 * riferimento: l'esportazione la dice «lasciata fuori» (PDF e Word).
 */
function exportImageReader() {
  const seen = new Map<string, Promise<string | null>>();
  const waiting: (() => void)[] = [];
  let active = 0;
  const slot = async () => {
    if (active >= EXPORT_IMAGE_CONCURRENCY) await new Promise<void>((go) => waiting.push(go));
    active++;
  };
  const free = () => {
    active--;
    waiting.shift()?.();
  };
  const read = (pageId: string, imageId: string): Promise<string | null> => {
    let pending = seen.get(imageId);
    if (!pending) {
      pending = (async () => {
        await slot();
        try {
          const data = await authedDataUrl(appClient().productDocs.imagePath(pageId, imageId));
          const type = data ? /^data:([^;,]+)[;,]/.exec(data)?.[1]?.toLowerCase() : undefined;
          return data && type && IMAGE_TYPES.has(type) ? data : null;
        } finally {
          free();
        }
      })();
      seen.set(imageId, pending);
    }
    return pending;
  };
  return (pageId: string, blocks: ProductBlock[]): Promise<ProductBlock[]> =>
    Promise.all(
      blocks.map(async (b) => {
        if (b.type !== "image" || !productImageRefSchema.safeParse(b.src).success) return b;
        const data = await read(pageId, b.src.slice(PRODUCT_IMAGE_REF_PREFIX.length));
        return data ? { ...b, src: data } : b;
      }),
    );
}

/** Un commento del server nella forma del prototipo (un id che manca è vuoto). */
function commentOf(c: ServerCommentView): ProductCommentView {
  return {
    id: c.id,
    pageId: c.pageId,
    anchorId: c.anchorId,
    quote: c.quote,
    authorId: c.authorId ?? "",
    authorName: c.authorName,
    body: c.body,
    createdAt: c.createdAt,
    replyToId: c.replyToId,
    resolved: c.resolved
      ? { byId: c.resolved.byId ?? "", byName: c.resolved.byName, at: c.resolved.at }
      : null,
    mentionIds: [...c.mentionIds],
  };
}

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
    const at = new Date().toISOString();
    return rereadOr(created.id, () => ({
      id: created.id,
      code: created.code,
      projectId,
      parentId: input.parentId ?? null,
      order: input.index ?? 0,
      title: input.title,
      blocks: [],
      createdById: "",
      createdAt: at,
      updatedById: "",
      updatedAt: at,
      breadcrumbs: [],
      permissions: { edit: true, delete: true, deleteBlocked: null },
      following: false,
      decisions: {},
      openComments: 0,
    }));
  },

  async renameProductPage(pageId, title) {
    try {
      await appClient().productDocs.update(pageId, { title });
    } catch (error) {
      return mapError(error);
    }
    return rereadOr(pageId, (last) => ({ ...last, title }));
  },

  async moveProductPage(pageId, to) {
    try {
      await appClient().productDocs.update(pageId, {
        move: { parentId: to.parentId, index: to.index },
      });
    } catch (error) {
      return mapError(error);
    }
    return rereadOr(pageId, (last) => ({ ...last, parentId: to.parentId, order: to.index }));
  },

  async deleteProductPage(pageId) {
    try {
      await appClient().productDocs.remove(pageId);
    } catch (error) {
      return mapError(error);
    }
    seqOf.delete(pageId);
    codeOf.delete(pageId);
    lastRead.delete(pageId);
  },

  async saveProductBlocks(pageId, ops, opts) {
    const client = appClient().productDocs;
    // Le revisioni di questa sessione arrivano anche dallo stream: non si rileggono (F4).
    liveProductPresence.rememberSession(opts.sessionId);
    const body = (baseSeq: number) => ({
      sessionId: opts.sessionId,
      baseSeq,
      ops,
      ...(opts.undoOf ? { undoOf: opts.undoOf } : {}),
    });
    let saved: { seq: number; revisionId: string | null };
    try {
      // La base su cui la scrittura è calcolata (la fila la porta), non l'ultima
      // lettura: una revisione altrui riletta intanto dà `stale` (revisione di R11-4, 2).
      saved = await client.save(pageId, body(opts.baseSeq ?? seqOf.get(pageId) ?? 0));
    } catch (error) {
      if (!isStale(error)) return mapError(error);
      // Le revisioni di un altro arrivate nel frattempo. Mai una sovrascrittura
      // silenziosa (design §F4): si riprova solo se nessuna tocca un blocco che
      // queste operazioni nominano; altrimenti, o senza le revisioni nella
      // risposta, la scrittura si rifiuta e la barra dice che la pagina era
      // cambiata.
      const newer = staleRevisions(error);
      // Le revisioni della stessa sessione (le scritture di prima della fila) non sono un conflitto.
      const others = newer?.filter((r) => r.sessionId !== opts.sessionId) ?? [];
      if (!newer || others.some((r) => r.touched.some((id) => opBlockIds(ops).has(id))))
        throw fail("invalid: stale");
      const seq = Math.max(
        opts.baseSeq ?? 0,
        seqOf.get(pageId) ?? 0,
        ...newer.map((r) => r.lastSeq),
      );
      seqOf.set(pageId, seq);
      try {
        saved = await client.save(pageId, body(seq));
      } catch (again) {
        return mapError(again);
      }
    }
    seqOf.set(pageId, saved.seq);
    // La scrittura è salvata: una rilettura che non riesce non la fa sembrare
    // fallita (un Retry rifarebbe operazioni già applicate). Si ricostruisce
    // dall'ultima lettura con le stesse operazioni.
    try {
      return { ...(await reread(pageId)), revisionId: saved.revisionId };
    } catch {
      const last = lastRead.get(pageId);
      if (!last) throw fail("not_found");
      const page = { ...last, blocks: applyBlockOps(last.blocks, ops).blocks };
      lastRead.set(pageId, page);
      return { ...page, revisionId: saved.revisionId };
    }
  },

  // Una pagina di 100 alla volta, dalla più recente; `before` è il `lastSeq`
  // più vecchio già letto (il pannello chiede la seguente, I2 della revisione).
  async listProductRevisions(pageId, opts = {}) {
    try {
      const rows = (await appClient().productDocs.revisions(
        pageId,
        opts.before,
      )) as ServerRevisionView[];
      // Un `kind` che questo renderer non conosce passa com'è: lo scarta
      // `useProductRevisions`, dopo aver contato la pagina (M6 della revisione).
      return rows.map(revisionOf);
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

  // Solo un riferimento del server si carica, dalla rotta dell'immagine (200
  // coi byte: png, jpeg, gif o webp, cache privata di un'ora). Sul web la
  // rotta va così com'è in `<img src>` (stessa origine, il cookie). Sul
  // desktop il token sta nel main e la CSP ammette solo `data:`: i byte
  // passano da `api:request` e diventano un data URL. Un'immagine che non c'è
  // (403/404) è `null`; ogni altro errore lancia, così la lettura si riprova (M2).
  async productImageSrc(pageId, src) {
    if (!productImageRefSchema.safeParse(src).success) return null;
    const path = appClient().productDocs.imagePath(
      pageId,
      src.slice(PRODUCT_IMAGE_REF_PREFIX.length),
    );
    if (!window.stubwise?.api) return path;
    const res = await ipcFetch(path);
    if (res.status === 404 || res.status === 403) return null;
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!res.ok || !IMAGE_TYPES.has(type)) throw fail("image_failed");
    const bytes = new Uint8Array(await res.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${type};base64,${btoa(binary)}`;
  },

  // --- i commenti (area 11, F2; R11-2) -------------------------------------------
  // Le forme di 72 (ec8c47400): l'ordine dei fili lo dà il server, un nome
  // che chi guarda non vede è `null` (R-G5), le menzioni le trova il server
  // nel testo. Un autore eliminato non ha id: la UI dice «Someone».

  async listProductComments(pageId) {
    try {
      const v = await appClient().productDocs.comments(pageId);
      const thread = (t: (typeof v.open)[number]): ProductCommentThread => ({
        root: commentOf(t.root),
        replies: t.replies.map(commentOf),
        anchorGone: t.anchorGone,
      });
      return { open: v.open.map(thread), resolved: v.resolved.map(thread) };
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return { open: [], resolved: [] };
      return mapError(error);
    }
  },

  async addProductComment(pageId, input) {
    try {
      return commentOf(
        await appClient().productDocs.addComment(pageId, {
          anchorId: input.anchorId,
          quote: input.quote,
          body: input.body,
          ...(input.replyToId ? { replyToId: input.replyToId } : {}),
        }),
      );
    } catch (error) {
      return mapError(error);
    }
  },

  async resolveProductComment(rootId) {
    try {
      await appClient().productDocs.resolveComment(rootId);
    } catch (error) {
      mapError(error);
    }
  },

  async reopenProductComment(rootId) {
    try {
      await appClient().productDocs.reopenComment(rootId);
    } catch (error) {
      mapError(error);
    }
  },

  async productMentionCandidates(projectId, q) {
    try {
      return [...(await appClient().productDocs.mentionCandidates(projectId, q))];
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 403)) return [];
      return mapError(error);
    }
  },

  // --- la ricerca e l'esportazione (area 11, F3; R11-3) ---------------------------
  // Sull'api-client di F3 (72): la risposta la valida lo schema del client
  // INTERA, quindi una riga malformata fa fallire la ricerca (e, nella
  // globale, anche gli altri gruppi): la palette lo dice come ogni errore di
  // ricerca. È la regola dei `readerSchema` (enum aperti, campi no).

  async searchProductPages(q, { projectId } = {}) {
    const text = q.trim();
    // Il server risponde 400 `empty_query`: un testo vuoto non chiede niente.
    if (text === "") return [];
    let items: readonly ProductSearchHit[];
    try {
      if (projectId) {
        // Lo spazio: ibrida (significato, poi testo), al più 20 righe.
        items = (await appClient().productDocs.search(projectId, text)).items;
      } else {
        // Senza progetto: il gruppo `product` della ricerca globale (per testo,
        // la corsia veloce), la STESSA chiamata della palette (`citableSearch`
        // la condivide finché è in volo, review di R11-3, 4). Un server senza
        // il gruppo non ha righe.
        items = (await citableSearch(text)).product.items;
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return [];
      return mapError(error);
    }
    return [...(items as ProductSearchHit[])];
  },

  async getProductExport(projectId, { pageId } = {}) {
    let raw: ProductExportPage | ProductExportSpace;
    try {
      raw =
        pageId !== undefined
          ? await appClient().productDocs.exportPage(pageId)
          : await appClient().productDocs.exportSpace(projectId);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      if (error instanceof ApiError && error.status === 413) throw tooLarge(error);
      return mapError(error);
    }
    const exported = "pages" in raw ? raw.pages : [{ ...raw, depth: 0 }];
    const decisions: ProductExportView["decisions"] = {};
    const files: ProductExportView["files"] = {};
    const withImageData = exportImageReader();
    const pages = await Promise.all(
      exported.map(async (p) => {
        for (const [id, d] of Object.entries(p.decisions))
          decisions[id] = d ? { title: d.title } : null;
        for (const [id, f] of Object.entries(p.files)) files[id] = f ? { name: f.name } : null;
        const page: ProductPage = {
          id: p.page.id,
          code: p.page.code,
          projectId,
          parentId: null,
          order: 0,
          title: p.page.title,
          blocks: await withImageData(p.page.id, blocksOf(p.blocks)),
          createdById: "",
          createdAt: p.page.updatedAt,
          updatedById: "",
          updatedAt: p.page.updatedAt,
        };
        return { page, depth: p.depth };
      }),
    );
    return {
      projectCode: "pages" in raw ? raw.projectCode : raw.page.projectCode,
      pages,
      files,
      decisions,
    };
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
 * (server, rete) non si nasconde: la Home lo dice (I5 della revisione).
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
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) return null;
    throw error;
  }
}

/** Le revisioni di un 409 `stale` (`ApiError.details.revisions`), o `null` per ogni altro errore. */
const isStale = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 409 && error.code === "stale";

/**
 * Le revisioni di un 409 `stale` (`ApiError.details.revisions`), coi blocchi
 * e le ancore che toccano (anche il blocco assorbito da un `merge`); `null`
 * se la risposta non le porta, o ne porta una che non si legge.
 */
function staleRevisions(
  error: unknown,
): { lastSeq: number; sessionId: string | null; touched: string[] }[] | null {
  const revisions = (error as ApiError).details as { revisions?: unknown } | undefined;
  const list = revisions?.revisions;
  if (!Array.isArray(list) || list.length === 0) return null;
  const out: { lastSeq: number; sessionId: string | null; touched: string[] }[] = [];
  for (const r of list as { lastSeq?: unknown; sessionId?: unknown; changes?: unknown }[]) {
    if (typeof r?.lastSeq !== "number" || !Array.isArray(r.changes)) return null;
    const touched = (
      r.changes as { blockId?: unknown; anchors?: unknown; mergedFrom?: { anchorId?: unknown } }[]
    ).flatMap((c) =>
      [c.blockId, ...(Array.isArray(c.anchors) ? c.anchors : []), c.mergedFrom?.anchorId].filter(
        (id): id is string => typeof id === "string",
      ),
    );
    out.push({
      lastSeq: r.lastSeq,
      sessionId: typeof r.sessionId === "string" ? r.sessionId : null,
      touched,
    });
  }
  return out;
}

/** Ogni id che le operazioni nominano: blocchi, celle e righe scritte, i punti d'inserimento. */
function opBlockIds(ops: readonly ProductBlockOp[]): Set<string> {
  const ids = new Set<string>();
  const block = (b: ProductBlock) => {
    ids.add(b.id);
    if (b.type === "table")
      for (const row of b.rows) for (const cell of row.cells) ids.add(cell.id);
  };
  for (const op of ops) {
    if (op.op === "set") block(op.block);
    else if (op.op === "insert") {
      block(op.block);
      if (op.afterId) ids.add(op.afterId);
    } else if (op.op === "delete") ids.add(op.blockId);
    else if (op.op === "move") {
      ids.add(op.blockId);
      if (op.afterId) ids.add(op.afterId);
    } else {
      ids.add(op.firstId);
      ids.add(op.secondId);
    }
  }
  return ids;
}
