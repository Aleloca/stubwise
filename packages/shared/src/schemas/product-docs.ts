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

// --- Area 11, F5: Claude dalle fonti e le domande --------------------------------

/** La fonte di una modifica di Claude. `first_version` (F6) ne ha più d'una. */
export const productSourceRefSchema = z.union([
  z.object({ kind: z.enum(["email", "meeting", "decision", "task", "release"]), id: z.uuid() }).strict(),
  z.object({ kind: z.literal("first_version"), ids: z.array(z.uuid()).max(50) }).strict(),
]);
export type ProductSourceRef = z.infer<typeof productSourceRefSchema>;

export const productAnswerChoiceSchema = z.enum(["apply", "keep", "request"]);
export type ProductAnswerChoice = z.infer<typeof productAnswerChoiceSchema>;

/**
 * Un fatto che una fonte dice alla doc di prodotto, come lo restituisce il
 * modello (F5): STRUTTURATO, mai testo libero da incollare. Lo valida questo
 * schema; uno che non passa si scarta (e si conta). `clarity` dice se è detto
 * chiaro o è un «forse»; solo uno chiaro, che non contraddice una persona, entra
 * da sé (`decideFact`). Dal prototipo (`ProductFact`, `data/model.ts`).
 */
export const productFactSchema = z
  .object({
    id: z.string().min(1).max(100),
    pageId: z.uuid(),
    /** Il blocco (o la cella) che il fatto riguarda; `null` = in cima alla pagina. */
    anchorId: id.nullable(),
    change: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("replace"), text: richTextSchema }).strict(),
      z.object({ kind: z.literal("insert_after"), block: productBlockWriteSchema }).strict(),
      z.object({ kind: z.literal("link_task"), taskCode: z.string().min(1).max(40) }).strict(),
      z.object({ kind: z.literal("diverges"), built: z.string().min(1).max(2000) }).strict(),
    ]),
    clarity: z.enum(["clear", "vague"]),
    /** Il contrasto GIÀ presente quando il fatto arriva, con un testo che nessuna persona ha toccato. */
    contradicts: z.boolean().optional(),
    /** Il testo che il fatto si aspetta di trovare nel blocco: lo scrittore lo ricontrolla prima di scrivere. */
    before: richTextSchema.optional(),
    options: z
      .object({
        apply: richTextSchema.optional(),
        request: z.object({ title: z.string().min(1).max(200), description: z.string().max(5000) }).strict().optional(),
      })
      .strict()
      .optional(),
    /** La risposta che Claude consiglia; senza, `recommendedOf`. */
    recommended: productAnswerChoiceSchema.optional(),
  })
  .strict();
export type ProductFact = z.infer<typeof productFactSchema>;

export const productQuestionReasonSchema = z.enum(["vague", "contradicts_person", "contradicts", "diverges", "no_permission"]);
export type ProductQuestionReason = z.infer<typeof productQuestionReasonSchema>;

export type ProductFactDecision = { kind: "edit" } | { kind: "question"; reason: ProductQuestionReason } | { kind: "none" };

/**
 * La parte di DOMANDA di un commento di Claude (`product_comments.question`):
 * le risposte già scritte. Il testo della domanda non sta nel corpo: lo compone
 * chi la mostra, nella sua lingua, da questi valori. La risposta sta a parte
 * (`product_comments.answer`, una sola).
 */
export const productQuestionSchema = z.object({
  sourceRef: productSourceRefSchema,
  factId: z.string(),
  reason: productQuestionReasonSchema,
  /** Chi la domanda nomina: chi ha scritto la frase (`contradicts_person`) o il titolare senza `docs.edit` (`no_permission`). */
  forId: z.uuid().nullable(),
  /** La frase del fatto, parola per parola («Update it»); null = nessuna strada. */
  apply: richTextSchema.nullable(),
  /** Solo `diverges`: cosa è stato fatto. */
  built: z.string().nullable(),
  request: z.object({ title: z.string(), description: z.string() }).nullable(),
  /** Un fatto `insert_after` senza `options.apply`: «Update it» inserisce una copia del blocco dopo `afterId`. */
  insert: z.object({ block: productBlockWriteSchema, afterId: id.nullable() }).optional(),
  recommended: productAnswerChoiceSchema,
  /**
   * Il `rev_seq` della pagina quando la domanda è nata: una revisione dopo che
   * tocca l'ancora spegne «Update it» (`changed_after`). Opzionale per le
   * domande scritte prima (si ripiega sulla data del commento).
   */
  seq: z.number().int().optional(),
});
export type ProductQuestion = z.infer<typeof productQuestionSchema>;

/** La risposta a una domanda di Claude, una sola (`product_comments.answer`). */
export const productQuestionAnswerSchema = z.object({
  byId: z.uuid(),
  option: productAnswerChoiceSchema,
  at: z.string(),
  /** La revisione di «Update it». */
  revisionId: z.uuid().nullable(),
  requestId: z.uuid().nullable().default(null),
  /**
   * «Open a request»: il job d'intake della richiesta (la richiesta nasce
   * asincrona, e l'intake può fonderla in una che c'è già). La voce e il suo
   * codice si DERIVANO a lettura dal risultato del job.
   */
  requestJobId: z.uuid().nullable().default(null),
});
export type ProductQuestionAnswer = z.infer<typeof productQuestionAnswerSchema>;

// --- Area 11, F5, Task 4: le letture di Claude dalle fonti -----------------------

/**
 * Una fonte come la legge chi guarda (il prototipo: `ProductSourceView`): i
 * PEZZI, la frase la compone il client. `canOpen` falso (un'email o una
 * riunione della casella di un altro, admin compreso: N-2 = a) → `id`,
 * `title` e `thread` sono null: resta «da un'email di <ownerName> · <at>».
 */
export const productSourceViewSchema = z.object({
  /** F6: `drive` (un file del Drive) e `text` (le note incollate) sono le fonti di una prima versione. */
  kind: z.enum(["email", "meeting", "decision", "task", "release", "first_version", "drive", "text"]),
  canOpen: z.boolean(),
  id: z.uuid().nullable(),
  title: z.string().nullable(),
  /** Il codice di una task o di un rilascio (anche invisibile). */
  code: z.string().nullable(),
  ownerId: z.uuid().nullable(),
  ownerName: z.string().nullable(),
  at: z.string().nullable(),
  /** La fonte non c'è più (email potata, riunione tolta). */
  gone: z.boolean(),
  /** La conversazione della Posta (`/api/me/mail/threads/:threadId?account=`): solo con `canOpen`. */
  thread: z.object({ threadId: z.string(), accountId: z.uuid() }).nullable().default(null),
});
export type ProductSourceView = z.infer<typeof productSourceViewSchema>;

/**
 * Se chi guarda può annullare una modifica di Claude, e se no perché. Un
 * oggetto solo (non un'unione: `readerSchema` la attraversa): con `enabled`
 * vero gli altri campi sono null.
 */
export const productUndoViewSchema = z.object({
  enabled: z.boolean(),
  reason: z.enum(["changed_after", "no_permission", "already_undone"]).nullable().default(null),
  byId: z.uuid().nullable().default(null),
  byName: z.string().nullable().default(null),
});
export type ProductUndoView = z.infer<typeof productUndoViewSchema>;

/** `GET /api/product-pages/:id/marks`: i segni aperti di Claude, uno per ancora. */
export const productMarkViewSchema = z.object({
  id: z.uuid(),
  anchorId: z.string(),
  /** Il blocco che contiene l'ancora (la tabella, per una cella). */
  blockId: z.string(),
  /** Per una cella: 1 = la prima riga, la prima colonna (P45). */
  cell: z.object({ row: z.number().int(), col: z.number().int() }).nullable().default(null),
  revisionId: z.uuid(),
  /** Quante ancore ha cambiato la stessa revisione. */
  groupAnchors: z.number().int(),
  actorId: z.uuid().nullable(),
  onBehalfOfId: z.uuid().nullable(),
  onBehalfOfName: z.string().nullable(),
  at: z.string(),
  source: productSourceViewSchema,
  canAccept: z.boolean(),
  undo: productUndoViewSchema,
});
export type ProductMarkView = z.infer<typeof productMarkViewSchema>;

/** I campi in più di una revisione di Claude o di un «Undo» (additivi su `productRevisionViewSchema`). */
export const productRevisionClaudeFields = {
  via: z.enum(["claude"]).nullable().default(null),
  onBehalfOfId: z.uuid().nullable().default(null),
  onBehalfOfName: z.string().nullable().default(null),
  source: productSourceViewSchema.nullable().default(null),
  /** Solo `claude`: «Undo all». */
  undo: productUndoViewSchema.nullable().default(null),
  /** Solo `claude`: lo stato di «Undo» per ogni ancora cambiata. */
  undoByAnchor: z.record(z.string(), productUndoViewSchema).default({}),
  /** Solo `claude`: quante ancore sono state annullate («1 di 3 annullate»). */
  undoneCount: z.object({ done: z.number().int(), count: z.number().int() }).nullable().default(null),
  undoneById: z.uuid().nullable().default(null),
  undoneByName: z.string().nullable().default(null),
  /** Solo `undo`: la revisione di Claude annullata. */
  undoOf: z.uuid().nullable().default(null),
  /** Una modifica scritta da «Update it» su una domanda di Claude: il commento della domanda. */
  answerOf: z.uuid().nullable().default(null),
};

/**
 * Una frase come la LEGGE un client: i segni larghi (come i blocchi di
 * `productPageViewSchema`), perché `readerSchema` non attraversa l'unione
 * stretta di `richTextSchema` (il guardiano di `reader.test.ts`). La forma
 * vera la tiene chi scrive.
 */
export const richTextViewSchema = z.object({ text: z.string(), marks: z.array(z.record(z.string(), z.unknown())) });
export type RichTextView = z.infer<typeof richTextViewSchema>;

/** La parte di DOMANDA di un commento di Claude, come la legge chi guarda. */
export const productQuestionViewSchema = z.object({
  reason: productQuestionReasonSchema,
  forId: z.uuid().nullable(),
  forName: z.string().nullable(),
  /** Il codice della task di una divergenza. */
  taskCode: z.string().nullable(),
  source: productSourceViewSchema,
  applyMode: z.enum(["replace", "insert"]),
  /** La frase dell'ancora com'è adesso; null se non c'è più, e sempre per `insert`. */
  current: richTextViewSchema.nullable(),
  apply: richTextViewSchema.nullable(),
  built: z.string().nullable(),
  request: z.object({ title: z.string(), description: z.string() }).nullable(),
  recommended: productAnswerChoiceSchema.nullable(),
  /** Le risposte che hanno una strada, il consiglio per primo. */
  options: z.array(productAnswerChoiceSchema),
  canAnswer: z.boolean(),
  /** «Update it» spento: la frase è cambiata dopo la domanda. */
  applyBlocked: z.object({ byId: z.uuid().nullable(), byName: z.string().nullable() }).nullable(),
  answer: z
    .object({
      byId: z.uuid().nullable(),
      byName: z.string().nullable(),
      option: productAnswerChoiceSchema,
      at: z.string(),
      revisionId: z.uuid().nullable(),
      requestId: z.uuid().nullable(),
      requestCode: z.string().nullable(),
    })
    .nullable(),
});
export type ProductQuestionView = z.infer<typeof productQuestionViewSchema>;

/**
 * Area 11, F5: quello che una card `product_doc.updated` o `.question` dice,
 * DERIVATO a lettura per chi la riceve (il prototipo: `ProductCardView`): la
 * fonte nella sua forma (N-2 = a), le frasi cambiate, «per conto di» e chi ha
 * annullato (se chi legge li vede, R-G5), il primo segno ancora a vista (dove
 * porta la card; null = alla cronologia della revisione), e per una domanda
 * il motivo e la risposta di adesso. I testi li compone il client.
 */
export const productDocClaudeCardSchema = z.object({
  revisionId: z.uuid().nullable(),
  sources: z.array(productSourceViewSchema),
  /** Quante frasi (ancore) ha cambiato la revisione; 0 per una domanda. */
  changes: z.number().int(),
  onBehalfOfName: z.string().nullable(),
  /** Tutte le frasi annullate: chi ha annullato per ultimo. */
  undoneByName: z.string().nullable(),
  markAnchorId: z.string().nullable(),
  /** La card arriva dopo un'attesa della coda (budget o pausa); oggi sempre null (registro dei rimandi). */
  waited: z.enum(["budget", "paused"]).nullable().default(null),
  question: z
    .object({
      reason: productQuestionReasonSchema,
      forName: z.string().nullable(),
      taskCode: z.string().nullable(),
      answer: productAnswerChoiceSchema.nullable(),
      answeredByName: z.string().nullable(),
      canRequest: z.boolean(),
    })
    .nullable()
    .default(null),
});
export type ProductDocClaudeCard = z.infer<typeof productDocClaudeCardSchema>;

/** `POST /api/product-comments/:id/answer`. */
export const answerProductQuestionSchema = z.object({ option: productAnswerChoiceSchema }).strict();
export type AnswerProductQuestionInput = z.infer<typeof answerProductQuestionSchema>;

/** `GET /api/me/product-questions`: le domande aperte a cui chi guarda può rispondere. */
export const productOpenQuestionSchema = z.object({
  commentId: z.uuid(),
  pageId: z.uuid(),
  pageCode: z.string(),
  pageTitle: z.string(),
  projectId: z.uuid(),
  projectCode: z.string(),
  anchorId: z.string(),
  question: productQuestionViewSchema,
  createdAt: z.string(),
});
export type ProductOpenQuestion = z.infer<typeof productOpenQuestionSchema>;

/** Il lavoro di Claude fermo, per la riga «riprende quando…» (pagina e spazio). */
export const productClaudeHeldSchema = z.object({ reason: z.enum(["budget", "limit", "section_busy", "paused"]), count: z.number().int() }).nullable().default(null);
export type ProductClaudeHeld = z.infer<typeof productClaudeHeldSchema>;

// --- Area 11, F6: prima versione, bozze di schermata, dalla doc al backlog ----------

/**
 * Una fonte della prima versione come la manda chi la chiede (il prototipo:
 * `FirstVersionSource`). Il server la rilegge con la visibilità di chi chiede
 * (un'email solo della sua casella, un file del Drive solo se lo vede); una
 * che non vede è 422 `invalid_source`, come una che non c'è. Il testo
 * incollato entra come fonte NON fidata e non resta salvato.
 */
export const firstVersionSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("email"), id: z.uuid() }).strict(),
  z.object({ kind: z.literal("meeting"), id: z.uuid() }).strict(),
  z.object({ kind: z.literal("drive"), fileId: z.uuid() }).strict(),
  z.object({ kind: z.literal("text"), text: z.string().max(50_000) }).strict(),
]);
export type FirstVersionSource = z.infer<typeof firstVersionSourceSchema>;

/** `POST /api/projects/:projectId/product/first-version`. */
export const startFirstVersionSchema = z.object({ sources: z.array(firstVersionSourceSchema).min(1).max(30) }).strict();
export type StartFirstVersionInput = z.infer<typeof startFirstVersionSchema>;

/**
 * `GET /api/projects/:projectId/product/first-version/sources`: le fonti fra
 * cui chi chiede sceglie, solo ciò che VEDE nel progetto (vuote per chi non
 * legge i Docs). `meetings[].id` è il messaggio della riunione.
 */
export const productFirstVersionSourcesSchema = z.object({
  emails: z.array(z.object({ id: z.uuid(), fromName: z.string(), subject: z.string(), at: z.string() })),
  meetings: z.array(z.object({ id: z.uuid(), title: z.string(), at: z.string(), transcript: z.boolean() })),
  files: z.array(z.object({ id: z.uuid(), code: z.string(), name: z.string(), type: z.string() })),
});
export type ProductFirstVersionSources = z.infer<typeof productFirstVersionSourcesSchema>;

/**
 * «Undo the first version» per chi guarda: lo stato di «Undo» delle modifiche
 * di Claude più la pagina toccata per prima e COME (una modifica, un commento,
 * una risposta, una pagina nuova nello spazio).
 */
export const productFirstVersionUndoSchema = productUndoViewSchema.extend({
  pageId: z.uuid().nullable().default(null),
  pageTitle: z.string().nullable().default(null),
  touch: z.enum(["edit", "comment", "answer", "page"]).nullable().default(null),
});
export type ProductFirstVersionUndo = z.infer<typeof productFirstVersionUndoSchema>;

/**
 * `GET /api/projects/:projectId/product/first-version`: l'ultima prima
 * versione dello spazio come la legge chi guarda, o `null` (nessuna, o chi
 * non legge i Docs). Mentre `status` è `writing` il client la rilegge (ogni
 * 2 s): le pagine nuove arrivano anche nello spazio. `interrupted`: si è
 * fermata prima della fine («Stop», una pagina tolta, `docs.edit` perso, il
 * budget).
 */
export const productFirstVersionViewSchema = z.object({
  projectId: z.uuid(),
  groupId: z.uuid(),
  byId: z.uuid().nullable(),
  /** Chi l'ha chiesta, se chi guarda la vede (R-G5). */
  byName: z.string().nullable(),
  status: z.enum(["writing", "done", "undone"]),
  pagesDone: z.number().int(),
  pagesTotal: z.number().int(),
  interrupted: z.boolean(),
  sources: z.array(productSourceViewSchema),
  pages: z.array(
    z.object({
      title: z.string(),
      depth: z.number().int(),
      pageId: z.uuid().nullable(),
      code: z.string().nullable(),
      state: z.enum(["written", "writing", "waiting"]),
    }),
  ),
  acceptedPageIds: z.array(z.uuid()),
  /** Le pagine scritte che hanno ancora la riga «First version written by Claude…». */
  bannerPageIds: z.array(z.uuid()),
  undo: productFirstVersionUndoSchema,
  permissions: z.object({ edit: z.boolean(), stop: z.boolean().default(false) }),
});
export type ProductFirstVersionView = z.infer<typeof productFirstVersionViewSchema>;

/**
 * Una bozza di schermata (`product_wireframes`), come la legge la pagina. Lo
 * SVG lo disegna il modello e il server lo RIPULISCE prima di salvarlo
 * (`sanitizeWireframeSvg`, allowlist chiusa): il client lo mostra così com'è.
 * `drawing` = il modello ci sta lavorando (il blocco mostra l'attesa); una
 * variante nuova («Redraw») si aggiunge in fondo, e il blocco ne nomina una
 * per indice (`variant`).
 */
export const productWireframeViewSchema = z.object({
  id: z.uuid(),
  status: z.enum(["drawing", "ready", "failed"]),
  variants: z.array(z.object({ svg: z.string() })),
  /** Solo con `failed`: perché (`budget`, `limit`, `invalid_svg`, `no_answer`). */
  error: z.string().nullable().default(null),
});
export type ProductWireframeView = z.infer<typeof productWireframeViewSchema>;

/**
 * `POST /api/product-pages/:id/wireframes` («Draw this screen», o «/» →
 * «Screen sketch» al posto di un paragrafo vuoto): il blocco nasce subito,
 * col disegno in arrivo.
 */
export const drawWireframeSchema = z.union([
  z.object({ afterId: z.string().min(1).max(100).nullable() }).strict(),
  z.object({ replaceId: z.string().min(1).max(100) }).strict(),
]);
export type DrawWireframeInput = z.infer<typeof drawWireframeSchema>;

/** `POST /api/product-pages/:id/wireframes/:blockId/redraw`: `fromVariant` = la variante che chi preme vedeva (il doppio clic). */
export const redrawWireframeSchema = z.object({ fromVariant: z.number().int().min(0).optional() }).strict();
/** `POST /api/product-pages/:id/wireframes/:blockId/pick`: una variante già disegnata. */
export const pickWireframeSchema = z.object({ variant: z.number().int().min(0) }).strict();
/** `POST /api/product-pages/:id/wireframes/:blockId/replace-image`: un'immagine già caricata nella pagina. */
export const replaceWireframeWithImageSchema = z.object({ src: productImageRefSchema, alt: z.string().max(2000).default("") }).strict();

/**
 * `GET /api/product-pages/:id/backlog-candidates?fromAnchorId=`: le voci di
 * backlog che chi guarda può proporre dalla pagina (o dalla sezione di un
 * titolo), DETERMINISTICHE (le frasi della pagina, il prototipo
 * `backlogCandidatesOf`): la scheda B la compone il client, una
 * `createRequest` per voce con `origin` (pagina e ancora). Le frasi già
 * proposte non tornano: `alreadyProposed` coi codici che chi guarda vede e il
 * numero degli altri.
 */
export const productBacklogCandidatesSchema = z.object({
  candidates: z.array(z.object({ anchorId: z.string(), title: z.string(), description: z.string(), sentence: z.string() })),
  alreadyProposed: z.object({ codes: z.array(z.string()), hidden: z.number().int() }),
});
export type ProductBacklogCandidates = z.infer<typeof productBacklogCandidatesSchema>;

/**
 * La pagina da cui nasce una richiesta (o la richiesta d'origine di una
 * task), DERIVATA a lettura: il titolo di adesso; `null` se non nasce dalla
 * doc o se chi guarda non legge la pagina. Mai la frase dell'ancora.
 */
export const productOriginSchema = z.object({ pageId: z.uuid(), code: z.string(), title: z.string() });
export type ProductOrigin = z.infer<typeof productOriginSchema>;

/** `GET /api/product-pages/:id/requests` («From this page»): le richieste nate dalla pagina che chi guarda vede. */
export const productLinkedRequestSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  title: z.string(),
  status: z.string(),
  /** Le task nate dalla richiesta che esistono ancora. */
  taskCodes: z.array(z.string()),
});
export type ProductLinkedRequest = z.infer<typeof productLinkedRequestSchema>;

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
  /** F5: il lavoro di Claude fermo nel progetto (riga «riprende quando…» in cima all'indice). Additivo. */
  claudeHeld: productClaudeHeldSchema,
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
  /**
   * Perché «Elimina» è spenta, deciso dal server (richiesta di 94): manca
   * `docs.edit` (`permission`, il primo motivo), o la pagina ha sottopagine
   * (`children`); `null` quando si può eliminare. Additivo.
   */
  deleteBlockedBy: z.enum(["children", "permission"]).nullable().default(null),
  /**
   * I fili aperti (richiesta di 94, come il prototipo): le radici non risolte
   * della pagina, con l'ancora viva o no; un commento eliminato non conta. Per
   * il numero accanto a «Comments» e l'apertura della colonna, senza leggere i
   * commenti a ogni lettura della pagina. Additivo.
   */
  openComments: z.number().int().default(0),
  /** F5: il lavoro di Claude fermo che tocca questa pagina. Additivo. */
  claudeHeld: productClaudeHeldSchema,
  /** F6: le bozze di schermata della pagina (il blocco `wireframe` le nomina per `wireframeId`). Additivo. */
  wireframes: z.array(productWireframeViewSchema).default([]),
});
export type ProductPageView = z.infer<typeof productPageViewSchema>;

/** Una revisione come la legge chi guarda (F1: in lettura; l'«Undo» arriva con F5). */
export const productRevisionViewSchema = z.object({
  id: z.uuid(),
  pageId: z.uuid(),
  sessionId: z.string().nullable(),
  seq: z.number().int(),
  lastSeq: z.number().int(),
  /** F5: anche `undo` (un «Undo» di un segno di Claude) e `claude` (una modifica di Claude da una fonte). Additivo: `readerSchema` apre l'enum. */
  kind: z.enum(["create", "edit", "rename", "move", "undo", "claude", "first_version"]),
  actorId: z.uuid().nullable(),
  /** Il nome di chi ha scritto, se chi guarda lo vede (R-G5). */
  actorName: z.string().nullable(),
  changes: z.array(z.record(z.string(), z.unknown())),
  /** `rename`: il titolo prima e dopo; `move`: il genitore prima e dopo. */
  title: z.object({ before: z.string(), after: z.string() }).nullable().default(null),
  parent: z.object({ beforeId: z.uuid().nullable(), afterId: z.uuid().nullable() }).nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
  ...productRevisionClaudeFields,
});
export type ProductRevisionView = z.infer<typeof productRevisionViewSchema>;

// --- Area 11, F2: i commenti --------------------------------------------------

/**
 * `POST /api/product-pages/:id/comments`: una radice (ancora e frase) o una
 * risposta (`replyToId`: prende ancora e frase della radice, e quelle date si
 * ignorano). Le menzioni le trova il server nel testo (`@Nome`).
 */
export const addProductCommentSchema = z
  .object({
    anchorId: id,
    quote: z.string().max(2000),
    body: z.string().min(1).max(10_000),
    replyToId: z.uuid().optional(),
  })
  .strict();
export type AddProductCommentInput = z.infer<typeof addProductCommentSchema>;

/** Un commento come lo legge chi guarda; il nome di chi ha scritto solo se lo vede (R-G5). */
export const productCommentViewSchema = z.object({
  id: z.uuid(),
  pageId: z.uuid(),
  anchorId: z.string(),
  quote: z.string(),
  authorId: z.uuid().nullable(),
  authorName: z.string().nullable(),
  body: z.string(),
  createdAt: z.string(),
  replyToId: z.uuid().nullable(),
  /** Solo la radice. */
  resolved: z.object({ byId: z.uuid().nullable(), byName: z.string().nullable(), at: z.string() }).nullable(),
  /** Le persone menzionate che chi guarda vede. */
  mentionIds: z.array(z.uuid()).default([]),
  /** F5: la parte di domanda di un commento di Claude; null per i commenti delle persone. Additivo. */
  question: productQuestionViewSchema.nullable().default(null),
});
export type ProductCommentView = z.infer<typeof productCommentViewSchema>;

export const productCommentThreadSchema = z.object({
  root: productCommentViewSchema,
  replies: z.array(productCommentViewSchema),
  /** L'ancora non c'è più nei blocchi di adesso: «Frase eliminata». DERIVATO a lettura. */
  anchorGone: z.boolean(),
});
export type ProductCommentThread = z.infer<typeof productCommentThreadSchema>;

/** `GET /api/product-pages/:id/comments`. */
export const productCommentsSchema = z.object({
  open: z.array(productCommentThreadSchema),
  resolved: z.array(productCommentThreadSchema),
});
export type ProductCommentsView = z.infer<typeof productCommentsSchema>;

/** `GET /api/projects/:projectId/product/mention-candidates`. */
export const productMentionCandidatesSchema = z.array(z.object({ id: z.uuid(), name: z.string() }));

// --- Area 11, F3: la ricerca -------------------------------------------------

/** Un risultato della ricerca nelle pagine di prodotto (⌘K «In Product»), come `ProductSearchHit` del prototipo. */
export const productSearchHitSchema = z.object({
  page: productPageRefSchema,
  projectCode: z.string(),
  /** La frase che ha corrisposto: testo semplice, una riga, mai segni né indirizzi. */
  passage: z.string(),
});
export type ProductSearchHit = z.infer<typeof productSearchHitSchema>;

/** `GET /api/projects/:projectId/product/search`: le pagine dello spazio, al più 20, e se ce ne sono altre. */
export const productSearchResultsSchema = z.object({ items: z.array(productSearchHitSchema), hasMore: z.boolean() });
export type ProductSearchResults = z.infer<typeof productSearchResultsSchema>;

// --- Area 11, F3: l'esportazione ------------------------------------------------

/** La tetto delle pagine di un'esportazione dello spazio (oltre: 413 col numero). */
export const PRODUCT_EXPORT_PAGES_MAX = 200;

/**
 * Una pagina da esportare (D-4 = a: il file lo compone il client). I blocchi
 * come record (`productBlockSchema` per leggerli), MAI i commenti; le decisioni
 * e i file del Drive citati come li vede chi esporta (`null` = non li vede); le
 * immagini (`product-image:<id>`) si leggono dalla rotta coi byte.
 */
export const productExportPageSchema = z.object({
  page: z.object({ id: z.uuid(), code: z.string(), title: z.string(), projectCode: z.string(), updatedAt: z.string() }),
  blocks: z.array(z.record(z.string(), z.unknown())),
  decisions: z.record(z.string(), productDecisionRefSchema).default({}),
  files: z.record(z.string(), z.object({ name: z.string() }).nullable()).default({}),
});
export type ProductExportPage = z.infer<typeof productExportPageSchema>;

/** Lo spazio intero, in ordine d'albero; `depth` 0 = una radice. */
export const productExportSpaceSchema = z.object({
  projectCode: z.string(),
  pages: z.array(productExportPageSchema.extend({ depth: z.number().int().min(0) })),
});
export type ProductExportSpace = z.infer<typeof productExportSpaceSchema>;

/** Il 413 di uno spazio troppo grande: quante pagine ha, e il tetto. */
export const productExportTooLargeSchema = z.object({ code: z.literal("too_many_pages"), message: z.string(), count: z.number().int(), max: z.number().int() });

// --- Area 11, F4: la scrittura dal vivo ----------------------------------------

/** Dove una persona ha il cursore: un'ancora (blocco o cella) e la posizione nel suo testo. */
export const productCursorSchema = z.object({ blockId: id, offset: z.number().int().min(0) });
export type ProductCursor = z.infer<typeof productCursorSchema>;

/**
 * Una persona presente nella pagina, come la vede chi guarda: solo le persone
 * che vede (R-G5) e che leggono ancora i Docs del progetto; il nome lo deriva
 * il server, il colore lo sceglie il client dall'id (come il prototipo).
 */
export const productPresenceSchema = z.object({
  userId: z.uuid(),
  name: z.string(),
  /** Dove scrive; null = c'è ma non scrive. */
  cursor: productCursorSchema.nullable(),
  /** La sezione in cui scrive (`sectionKeyOf`, `top` = in cima), o null. */
  sectionId: z.string().nullable(),
});
export type ProductPresence = z.infer<typeof productPresenceSchema>;

/** Una sezione presa: chi la tiene (il nome solo se chi guarda lo vede, R-G5) e fino a quando. */
export const productSectionHoldSchema = z.object({
  sectionId: z.string(),
  by: z.object({ id: z.uuid(), name: z.string().nullable() }),
  expiresAt: z.string(),
});
export type ProductSectionHold = z.infer<typeof productSectionHoldSchema>;

/** Il 409 di `POST /api/product-pages/:id/ops` quando un'operazione tocca una sezione presa da un ALTRO: niente è cambiato. */
export const productSectionBusySchema = z.object({
  code: z.literal("section_busy"),
  message: z.string(),
  sectionId: z.string(),
  by: z.object({ id: z.uuid(), name: z.string().nullable() }),
});
export type ProductSectionBusy = z.infer<typeof productSectionBusySchema>;

/** `POST /api/product-pages/:id/live/presence`: il battito (ogni 5 s, scade a 15 s). Con `sectionId` serve `docs.edit` e rinnova la presa. */
export const productPresenceBeatSchema = z
  .object({
    /** La sessione (una scheda) che batte: due schede della stessa persona sono due presenze (review di F4, M4). Facoltativa. */
    sessionId: z.string().min(1).max(100).optional(),
    cursor: productCursorSchema.nullable().optional(),
    sectionId: z.string().min(1).max(100).nullable().optional(),
  })
  .strict();
export type ProductPresenceBeat = z.infer<typeof productPresenceBeatSchema>;

/** La risposta del battito: la presa chiesta, se è di chi chiede, o chi la tiene. */
export const productPresenceBeatResultSchema = z.object({
  hold: productSectionHoldSchema.nullable(),
  busy: productSectionHoldSchema.nullable().default(null),
});
export type ProductPresenceBeatResult = z.infer<typeof productPresenceBeatResultSchema>;

/**
 * I frame dello stream `GET /api/product-pages/:id/live` (SSE, `data: {json}`,
 * `: ping` ogni 25 s). Il primo è sempre `state`; alla ripresa ne arriva uno
 * nuovo, e il client confronta il `seq` col suo (più avanti: rilegge la pagina).
 * - `revision`: una scrittura salvata, con le operazioni (`ops`, per applicarle
 *   senza rileggere se il client è al `seq` di prima) o, per una rinomina o uno
 *   spostamento, il titolo e il genitore nuovi;
 * - `presence`: tutta la presenza, di nuovo;
 * - `cursor`: un cursore che si è mosso;
 * - `hold` / `release`: una sezione presa o lasciata;
 * - `gone`: la pagina non c'è più, o chi guarda non la legge più: lo stream si chiude.
 */
export const productLiveStateSchema = z.object({
  type: z.literal("state"),
  seq: z.number().int(),
  presence: z.array(productPresenceSchema),
  holds: z.array(productSectionHoldSchema),
});
export const productLiveRevisionSchema = z.object({
  type: z.literal("revision"),
  seq: z.number().int(),
  kind: z.enum(["create", "edit", "rename", "move", "undo", "claude", "first_version"]),
  actorId: z.uuid().nullable(),
  sessionId: z.string().nullable(),
  ops: z.array(z.record(z.string(), z.unknown())).default([]),
  title: z.string().nullable().default(null),
  parentId: z.uuid().nullable().default(null),
});
export const productLivePresenceSchema = z.object({ type: z.literal("presence"), presence: z.array(productPresenceSchema) });
export const productLiveCursorSchema = z.object({ type: z.literal("cursor"), userId: z.uuid(), cursor: productCursorSchema.nullable() });
export const productLiveHoldSchema = z.object({ type: z.literal("hold"), hold: productSectionHoldSchema });
export const productLiveReleaseSchema = z.object({ type: z.literal("release"), sectionId: z.string() });
export const productLiveGoneSchema = z.object({ type: z.literal("gone") });
/** F6: una bozza di schermata della pagina è cambiata (disegnata, una variante nuova, fallita): il client rilegge la pagina. */
export const productLiveWireframeSchema = z.object({ type: z.literal("wireframe"), wireframeId: z.uuid(), status: z.enum(["drawing", "ready", "failed"]) });
