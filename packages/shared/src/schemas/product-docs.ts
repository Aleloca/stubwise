import { z } from "zod";

/**
 * Area 11, F1 — la documentazione di prodotto: il documento a blocchi, le
 * operazioni con cui si scrive, le viste dello spazio e della pagina. La
 * forma è quella del prototipo (`apps/desktop/src/renderer/data/model.ts`,
 * «Doc di prodotto»), che ne resta la specifica. Una foglia: non importa
 * altri schemi (`load-isolated.test.ts`).
 *
 * I blocchi: un'unione col blocco NOTO rigido per primo e un ripiego aperto
 * (`productBlockSchema`). `readerSchema` non apre una `discriminatedUnion`
 * (vedi `reader.ts`), quindi un tipo di blocco futuro arriva al client come
 * `{ id, type }` col tipo grezzo, e il renderer lo salta: niente pagina persa.
 */

const id = z.string().min(1).max(100);

export const inlineMarkSchema = z.union([
  z.object({ type: z.enum(["bold", "italic"]), start: z.number().int().min(0), end: z.number().int().min(0) }).strict(),
  z.object({ type: z.literal("link"), start: z.number().int().min(0), end: z.number().int().min(0), href: z.string().max(2000) }).strict(),
]);
export type InlineMark = z.infer<typeof inlineMarkSchema>;

export const richTextSchema = z.object({ text: z.string().max(50_000), marks: z.array(inlineMarkSchema).max(500) }).strict();
export type RichText = z.infer<typeof richTextSchema>;

export const productTableCellSchema = z.object({ id, content: richTextSchema }).strict();
export type ProductTableCell = z.infer<typeof productTableCellSchema>;
export const productTableRowSchema = z.object({ id, cells: z.array(productTableCellSchema).max(50) }).strict();
export type ProductTableRow = z.infer<typeof productTableRowSchema>;

/**
 * Il riferimento di un'immagine caricata (F1, D-3 = a): `product-image:<id>`,
 * una riga di `product_page_images` della stessa pagina. Mai un data URL né
 * un indirizzo da caricare: il client la apre dalla rotta dell'immagine.
 */
export const PRODUCT_IMAGE_REF_PREFIX = "product-image:";
// Review di F1 (M6): un uuid VERO dopo il prefisso, o la query del server lancerebbe.
export const productImageRefSchema = z.string().regex(/^product-image:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

export const PRODUCT_BLOCK_TYPES = ["heading", "paragraph", "quote", "code", "bullet", "numbered", "todo", "divider", "table", "image", "drive", "decision", "wireframe"] as const;

const knownProductBlockSchema = z.discriminatedUnion("type", [
  z.object({ id, type: z.literal("heading"), level: z.union([z.literal(1), z.literal(2), z.literal(3)]), content: richTextSchema }).strict(),
  z.object({ id, type: z.literal("paragraph"), content: richTextSchema }).strict(),
  z.object({ id, type: z.literal("quote"), content: richTextSchema }).strict(),
  z.object({ id, type: z.literal("code"), content: richTextSchema, language: z.string().max(40).optional() }).strict(),
  z.object({ id, type: z.literal("bullet"), content: richTextSchema, indent: z.union([z.literal(0), z.literal(1), z.literal(2)]) }).strict(),
  z.object({ id, type: z.literal("numbered"), content: richTextSchema, indent: z.union([z.literal(0), z.literal(1), z.literal(2)]) }).strict(),
  z.object({ id, type: z.literal("todo"), content: richTextSchema, checked: z.boolean() }).strict(),
  z.object({ id, type: z.literal("divider") }).strict(),
  z.object({ id, type: z.literal("table"), rows: z.array(productTableRowSchema).max(200) }).strict(),
  z.object({ id, type: z.literal("image"), src: productImageRefSchema, caption: z.string().max(2000), alt: z.string().max(2000) }).strict(),
  z.object({ id, type: z.literal("drive"), fileId: z.uuid(), code: z.string().max(40) }).strict(),
  z.object({ id, type: z.literal("decision"), decisionId: z.uuid() }).strict(),
  z.object({ id, type: z.literal("wireframe"), wireframeId: z.string().max(100), variant: z.number().int().min(0), kept: z.boolean().optional() }).strict(),
]);

/** Un blocco SCRITTO (le operazioni): solo i tipi noti, rigidi. */
export const productBlockWriteSchema = knownProductBlockSchema;
export type ProductBlock = z.infer<typeof knownProductBlockSchema>;
export type ProductBlockType = ProductBlock["type"];

/** Un blocco LETTO: il noto, o il ripiego per un tipo futuro. */
export const productBlockSchema = z.union([knownProductBlockSchema, z.looseObject({ id: z.string(), type: z.string() })]);

export const productBlockOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set"), block: productBlockWriteSchema }).strict(),
  z.object({ op: z.literal("insert"), afterId: id.nullable(), block: productBlockWriteSchema }).strict(),
  z.object({ op: z.literal("delete"), blockId: id }).strict(),
  z.object({ op: z.literal("move"), blockId: id, afterId: id.nullable() }).strict(),
  z.object({ op: z.literal("merge"), firstId: id, secondId: id }).strict(),
]);
export type ProductBlockOp = z.infer<typeof productBlockOpSchema>;

export interface ProductBlockChange {
  blockId: string;
  before: ProductBlock | null;
  after: ProductBlock | null;
  /** Le ancore (blocco, o celle) il cui testo, i cui segni o la cui presenza sono cambiati. */
  anchors: string[];
  /** Solo per un `merge`: l'ancora assorbita e dove cominciano le sue lettere nel blocco unito. */
  mergedFrom?: { anchorId: string; offset: number };
}

/** Il limite di una chiamata di scrittura e di una pagina (F1, ruling del piano). */
export const PRODUCT_OPS_MAX = 200;
export const PRODUCT_BLOCKS_MAX = 2000;
/** Review di F1 (I3): il corpo salvato di una pagina, in byte del JSON (un `merge` non lo scavalca). */
export const PRODUCT_PAGE_BYTES_MAX = 2_000_000;
/** Review di F1 (M9): la profondità dell'albero (la radice è 1) e le pagine di un progetto. */
export const PRODUCT_TREE_DEPTH_MAX = 20;
export const PRODUCT_PAGES_MAX = 2000;

/** `POST /api/product-pages/:id/ops`. */
export const saveProductBlocksSchema = z
  .object({
    sessionId: z.string().min(1).max(100),
    /** L'ultima revisione che il client ha visto (`seq`); 0 = la pagina appena letta senza revisioni. */
    baseSeq: z.number().int().min(0),
    ops: z.array(productBlockOpSchema).min(1).max(PRODUCT_OPS_MAX),
    /** ⌘Z dell'editor: la revisione che si annulla, e il permesso di rimettere gli id che questa sessione ha tolto. */
    undoOf: z.uuid().optional(),
  })
  .strict();
export type SaveProductBlocksInput = z.infer<typeof saveProductBlocksSchema>;

export const productPageRefSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  projectId: z.uuid(),
  parentId: z.uuid().nullable(),
  order: z.number().int(),
  title: z.string(),
  excerpt: z.string(),
  updatedAt: z.string(),
  updatedById: z.uuid().nullable(),
});
export type ProductPageRef = z.infer<typeof productPageRefSchema>;

/** L'albero (`buildProductTree`): lo costruisce il client dalle pagine dello spazio. */
export interface ProductTreeNode {
  page: ProductPageRef;
  children: ProductTreeNode[];
}

/**
 * `GET /api/projects/:projectId/product`: lo spazio per chi guarda. Le pagine
 * IN FILA (`pages`), non l'albero: `readerSchema` non attraversa uno schema
 * ricorsivo (`z.lazy`), e l'albero lo dà `buildProductTree` di shared, la
 * stessa regola del prototipo.
 */
export const productSpaceSchema = z.object({
  projectId: z.uuid(),
  projectCode: z.string(),
  pages: z.array(productPageRefSchema),
  pageCount: z.number().int(),
  recent: z.array(productPageRefSchema),
  permissions: z.object({ edit: z.boolean() }),
});
export type ProductSpaceView = z.infer<typeof productSpaceSchema>;

/** Una decisione citata in un blocco, come la vede chi guarda; `null` se non ne vede il progetto. */
export const productDecisionRefSchema = z
  .object({ title: z.string(), decidedAt: z.string(), decidedByName: z.string().nullable(), projectCode: z.string().optional() })
  .nullable();

/** `GET /api/product-pages/by-code/:code`. */
export const productPageViewSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  projectId: z.uuid(),
  parentId: z.uuid().nullable(),
  order: z.number().int(),
  title: z.string(),
  /**
   * I blocchi come record: `readerSchema` non apre una `discriminatedUnion`.
   * Il client li legge uno per uno con `productBlockSchema` (il noto o il
   * ripiego per un tipo futuro), come il server li ha salvati.
   */
  blocks: z.array(z.record(z.string(), z.unknown())),
  /** L'ultima revisione della pagina (per `baseSeq`); 0 senza revisioni. */
  seq: z.number().int(),
  createdById: z.uuid().nullable(),
  createdAt: z.string(),
  updatedById: z.uuid().nullable(),
  updatedAt: z.string(),
  breadcrumbs: z.array(productPageRefSchema),
  decisions: z.record(z.string(), productDecisionRefSchema).default({}),
  following: z.boolean().default(false),
  permissions: z.object({ edit: z.boolean(), delete: z.boolean() }),
});
export type ProductPageView = z.infer<typeof productPageViewSchema>;

/** Una revisione come la legge chi guarda (F1: in lettura; l'«Undo» arriva con F5). */
export const productRevisionViewSchema = z.object({
  id: z.uuid(),
  pageId: z.uuid(),
  sessionId: z.string().nullable(),
  seq: z.number().int(),
  lastSeq: z.number().int(),
  kind: z.enum(["create", "edit", "rename", "move"]),
  actorId: z.uuid().nullable(),
  /** Il nome di chi ha scritto, se chi guarda lo vede (R-G5). */
  actorName: z.string().nullable(),
  changes: z.array(z.record(z.string(), z.unknown())),
  /** `rename`: il titolo prima e dopo; `move`: il genitore prima e dopo. */
  title: z.object({ before: z.string(), after: z.string() }).nullable().default(null),
  parent: z.object({ beforeId: z.uuid().nullable(), afterId: z.uuid().nullable() }).nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProductRevisionView = z.infer<typeof productRevisionViewSchema>;
