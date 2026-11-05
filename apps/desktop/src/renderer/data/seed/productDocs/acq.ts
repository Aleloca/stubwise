import { blockChanges } from "../../../domain/productDocs/blocks";
import type {
  AppNotification,
  InlineMark,
  ProductBlock,
  ProductComment,
  ProductFollow,
  ProductPage,
  ProductRevision,
  RichText,
} from "../../types";
import { SEED_MAX_SEQ } from "../claudeActions";
import { daysFromToday } from "../dates";
import signIn from "../../../assets/productDocs/acq-sign-in.png?inline";
import bills from "../../../assets/productDocs/acq-bills.png?inline";

// Lo spazio Prodotto di ACQ (area 11a): nove pagine, tutte scritte da persone.
// Nessuna revisione del seme ha `via`, `source`, `undoOf` o `groupId`: quelle
// sono del 11b. I testi sono frasi coi segni (mai Markdown); i codici citati
// sono task e richieste di ACQ e una task di AUD, che Sara non vede.
//
// Il corpo di una pagina è quello di ADESSO. Una modifica dice com'era il
// blocco prima (`earlier`; `null` = il blocco è stato aggiunto dopo): la
// revisione `create` porta lo stato di allora e ogni `edit` il suo cambio, così
// l'ultima revisione di un blocco riporta sempre lo stato che si legge.

const LAURA = "p-laura";
const MARCO = "p-marco";
const MATTEO = "p-matteo";

// --- i mattoni ---------------------------------------------------------------

type Piece = string | { b: string } | { i: string } | { a: string; href: string };

/** Una frase dai pezzi: il testo si compone, i segni si calcolano. */
function rich(...pieces: Piece[]): RichText {
  let text = "";
  const marks: InlineMark[] = [];
  for (const piece of pieces) {
    if (typeof piece === "string") {
      text += piece;
      continue;
    }
    const start = text.length;
    if ("b" in piece) {
      text += piece.b;
      marks.push({ type: "bold", start, end: text.length });
    } else if ("i" in piece) {
      text += piece.i;
      marks.push({ type: "italic", start, end: text.length });
    } else {
      text += piece.a;
      marks.push({ type: "link", start, end: text.length, href: piece.href });
    }
  }
  return { text, marks };
}

const plainText = (text: string): RichText => ({ text, marks: [] });

/** Gli id dei blocchi di una pagina: `blk-acq-<pagina>-<n>`, mai riusati. */
function ids(page: string): () => string {
  let n = 0;
  return () => `blk-acq-${page}-${++n}`;
}

const para = (id: string, ...pieces: Piece[]): ProductBlock => ({
  id,
  type: "paragraph",
  content: rich(...pieces),
});
const h = (id: string, level: 1 | 2 | 3, text: string): ProductBlock => ({
  id,
  type: "heading",
  level,
  content: plainText(text),
});
const bullet = (id: string, ...pieces: Piece[]): ProductBlock => ({
  id,
  type: "bullet",
  indent: 0,
  content: rich(...pieces),
});
const todo = (id: string, text: string, checked: boolean): ProductBlock => ({
  id,
  type: "todo",
  content: plainText(text),
  checked,
});

// --- le pagine ---------------------------------------------------------------

interface Edit {
  by: string;
  /** Giorni fa. */
  days: number;
  time: string;
  blockId: string;
  /** Il blocco com'era prima; `null` = aggiunto con questa modifica. */
  earlier: ProductBlock | null;
  /**
   * Il blocco l'ha TOLTO questa modifica (non è nel corpo di adesso): prima
   * stava dopo il blocco con questo id. `earlier` è com'era.
   */
  removedAfter?: string;
}

interface Spec {
  id: string;
  title: string;
  parent: string | null;
  days: number;
  time: string;
  blocks: ProductBlock[];
  edits?: Edit[];
}

const PID = {
  overview: "pp-acq-overview",
  features: "pp-acq-features",
  signIn: "pp-acq-sign-in",
  bills: "pp-acq-bills",
  meter: "pp-acq-meter-reading",
  faults: "pp-acq-fault-reports",
  screens: "pp-acq-screens",
  decisions: "pp-acq-client-decisions",
  phases: "pp-acq-phases",
} as const;

/** Gli id che il copione della pagina Meter reading nomina (`presence.ts`). */
export const METER_IDS = {
  pageId: PID.meter,
  rules: "blk-acq-meter-2",
  afterRules: "blk-acq-meter-4",
  /** Il blocco che il copione scrive: NON è nel seme, e non entra in `productBlockIds`. */
  scripted: "blk-acq-meter-script-1",
} as const;

function overview(): Spec {
  const id = ids("overview");
  const intro = id();
  const earlier = para(
    intro,
    "The portal gives the customers of Acquedotto delle Colline one place to pay their bills, send meter readings and report faults.",
  );
  return {
    id: PID.overview,
    title: "Overview",
    parent: null,
    days: 32,
    time: "09:20",
    blocks: [
      para(
        intro,
        "The portal gives the customers of Acquedotto delle Colline one place to ",
        { b: "pay their bills" },
        ", send meter readings and report faults. The ",
        { i: "service charter" },
        " is on ",
        {
          a: "the utility's website",
          href: "https://www.acquedottocolline.example/carta-dei-servizi",
        },
        ".",
      ),
      h(id(), 2, "What the client asked for"),
      para(id(), "The client brief sets the scope and the phases."),
      { id: id(), type: "drive", fileId: "drv-acq-1", code: "ACQ-F1" },
      para(id(), "Paying the larger bills in instalments is the first request still open: ACQ-R1."),
      h(id(), 2, "Who uses it"),
      bullet(id(), "Customers with a household contract"),
      bullet(id(), "Customers with a business contract"),
      bullet(id(), "The support team, who see what the customer sees"),
    ],
    edits: [{ by: LAURA, days: 20, time: "11:05", blockId: intro, earlier }],
  };
}

function features(): Spec {
  const id = ids("features");
  return {
    id: PID.features,
    title: "Features",
    parent: null,
    days: 32,
    time: "09:45",
    blocks: [
      para(id(), "The portal has four areas. Each one has its own page below."),
      bullet(id(), "Sign-in with a Google account"),
      bullet(id(), "Bills, open and paid"),
      bullet(id(), "Meter readings, sent every month"),
      bullet(id(), "Fault reports, with a photo"),
    ],
  };
}

function signInPage(): Spec {
  const first = "blk-acq-signin-2";
  return {
    id: PID.signIn,
    title: "Sign-in",
    parent: PID.features,
    days: 31,
    time: "10:10",
    blocks: [
      h("blk-acq-signin-1", 2, "How customers sign in"),
      para(
        first,
        "Customers sign in with their ",
        { b: "Google account" },
        ". There is no password to reset.",
      ),
      h("blk-acq-signin-3", 2, "What the portal stores"),
      para("blk-acq-signin-4", "Only the name and the email address that Google gives us."),
    ],
    edits: [
      {
        by: MARCO,
        days: 18,
        time: "15:30",
        blockId: first,
        earlier: para(first, "Customers sign in with their Google account or with a password."),
      },
    ],
  };
}

function billsPage(): Spec {
  const id = ids("bills");
  const dates = id();
  const dateRule = "blk-acq-bills-6";
  return {
    id: PID.bills,
    title: "Bills",
    parent: PID.features,
    days: 30,
    time: "14:00",
    blocks: [
      para(
        dates,
        "Each customer sees the bills of every contract, newest first. A bill is open, paid or overdue.",
      ),
      h(id(), 2, "Payment"),
      para(
        id(),
        "Payment goes through the bank gateway. As in ACQ-7, a text message reminds the customer before the due date.",
      ),
      h(id(), 2, "Dates"),
      para(id(), "Bills show the due date in the customer's own time."),
      para(dateRule, "The dates follow the rule of AUD-8: stored in UTC, shown in local time."),
    ],
    edits: [
      {
        by: MATTEO,
        days: 9,
        time: "10:40",
        blockId: dateRule,
        earlier: para(dateRule, "The dates are stored as written on the bill."),
      },
    ],
  };
}

function meterPage(): Spec {
  const cell = (n: string, text: string) => ({
    id: `blk-acq-meter-cell-${n}`,
    content: plainText(text),
  });
  const row = (n: number, a: string, b: string, c: string) => ({
    id: `blk-acq-meter-row-${n}`,
    cells: [cell(`${n}a`, a), cell(`${n}b`, b), cell(`${n}c`, c)],
  });
  const lower = METER_IDS.afterRules;
  return {
    id: PID.meter,
    title: "Meter reading",
    parent: PID.features,
    days: 29,
    time: "09:30",
    blocks: [
      para(
        "blk-acq-meter-1",
        "Customers send the reading of their meter once a month, from the portal or by text message.",
      ),
      h(METER_IDS.rules, 2, "Rules"),
      para("blk-acq-meter-3", "Readings close on the 25th of each month."),
      para(
        lower,
        "A reading lower than the previous one is refused, with a message that says why.",
      ),
      h("blk-acq-meter-5", 3, "Edge cases"),
      bullet("blk-acq-meter-6", "A new meter starts from the reading on its installation sheet."),
      bullet("blk-acq-meter-7", "Two meters on the same contract are read one after the other."),
      {
        id: "blk-acq-meter-table",
        type: "table",
        rows: [
          row(1, "Meter", "Reading", "Closes"),
          row(2, "Household", "Cubic metres", "The 25th"),
          row(3, "Business", "Cubic metres", "The 25th"),
        ],
      },
    ],
    edits: [
      {
        by: MARCO,
        days: 12,
        time: "16:15",
        blockId: lower,
        earlier: para(lower, "A reading lower than the previous one is refused."),
      },
    ],
  };
}

function faultsPage(): Spec {
  const id = ids("faults");
  return {
    id: PID.faults,
    title: "Fault reports",
    parent: PID.features,
    days: 29,
    time: "11:50",
    blocks: [
      h(id(), 2, "Reporting a fault"),
      para(
        id(),
        "A customer describes the fault, picks the address on the map and can attach a photo.",
      ),
      para(
        id(),
        "The report reaches the support team as a conversation, and the customer gets a code to follow it.",
      ),
    ],
  };
}

function screensPage(): Spec {
  const id = ids("screens");
  return {
    id: PID.screens,
    title: "Screens",
    parent: null,
    days: 28,
    time: "10:00",
    blocks: [
      para(id(), "The two main screens, as they look in the first release."),
      h(id(), 2, "Sign-in"),
      {
        id: id(),
        type: "image",
        src: signIn,
        caption: "Sign-in screen: one button, Continue with Google.",
        alt: "A sign-in card with a single button",
      },
      h(id(), 2, "Bills"),
      {
        id: id(),
        type: "image",
        src: bills,
        caption: "Bills screen: three bills, the open one first.",
        alt: "A list of three bills with the amount and the state",
      },
    ],
  };
}

function decisionsPage(): Spec {
  const id = ids("decisions");
  return {
    id: PID.decisions,
    title: "Client decisions",
    parent: null,
    days: 27,
    time: "15:20",
    blocks: [
      para(id(), "What the client decided, and when. The two below shape the whole portal."),
      { id: id(), type: "decision", decisionId: "dl-acq-1" },
      { id: id(), type: "decision", decisionId: "dl-acq-2" },
    ],
  };
}

/** Il passo di Phases che Matteo ha tolto: c'era, e il suo id resta dato. */
const PHASES_REMOVED = "blk-acq-phases-paper";

function phasesPage(): Spec {
  const id = ids("phases");
  const reading = "blk-acq-phases-reading";
  return {
    id: PID.phases,
    title: "Phases",
    parent: null,
    days: 26,
    time: "09:10",
    blocks: [
      para(id(), "The work goes out in three phases. Tick each step when it is live."),
      todo(id(), "Phase 1: sign-in and bills", true),
      todo(reading, "Phase 1: meter readings", true),
      todo(id(), "Phase 2: fault reports", false),
      todo(id(), "Phase 2: instalment plans", false),
      todo(id(), "Phase 3: a dark appearance", false),
    ],
    edits: [
      {
        by: MATTEO,
        days: 5,
        time: "17:25",
        blockId: reading,
        earlier: todo(reading, "Phase 1: meter readings", false),
      },
      // Matteo toglie il passo che Laura aveva commentato: il filo resta,
      // e si legge «Frase eliminata» (Task 4).
      {
        by: MATTEO,
        days: 4,
        time: "11:05",
        blockId: PHASES_REMOVED,
        earlier: todo(PHASES_REMOVED, "Phase 3: paper bills by post", false),
        removedAfter: "blk-acq-phases-5",
      },
    ],
  };
}

const SPECS: Spec[] = [
  overview(),
  features(),
  signInPage(),
  billsPage(),
  meterPage(),
  faultsPage(),
  screensPage(),
  decisionsPage(),
  phasesPage(),
];

const at = (days: number, time: string) => `${daysFromToday(-days)}T${time}:00Z`;

// --- le pagine, le revisioni e chi segue ---------------------------------------

/** Lo stato di una pagina al momento in cui è stata creata. */
function initialBlocks(spec: Spec): ProductBlock[] {
  const added = new Set(spec.edits?.filter((e) => e.earlier === null).map((e) => e.blockId));
  const earlier = new Map(spec.edits?.map((e) => [e.blockId, e.earlier]));
  const blocks = spec.blocks.filter((b) => !added.has(b.id)).map((b) => earlier.get(b.id) ?? b);
  // I blocchi tolti dopo c'erano: tornano al loro posto.
  for (const e of spec.edits ?? []) {
    if (e.removedAfter === undefined || e.earlier === null) continue;
    blocks.splice(blocks.findIndex((b) => b.id === e.removedAfter) + 1, 0, e.earlier);
  }
  return blocks;
}

/** Gli id dei blocchi tolti da una modifica del seme: sono stati dati, e non si riusano. */
export const PRODUCT_REMOVED_BLOCK_IDS: string[] = SPECS.flatMap((s) =>
  (s.edits ?? []).filter((e) => e.removedAfter !== undefined).map((e) => e.blockId),
);

const lastEdit = (spec: Spec): Edit | undefined =>
  [...(spec.edits ?? [])].sort((a, b) => a.days - b.days)[0];

export const PRODUCT_PAGES: ProductPage[] = SPECS.map((spec, i) => {
  const last = lastEdit(spec);
  const siblings = SPECS.filter((s) => s.parent === spec.parent);
  return {
    id: spec.id,
    // I codici seguono l'ultimo `ACQ-D` dei Docs (D2): D3… in ordine d'albero.
    code: `ACQ-D${3 + i}`,
    projectId: "prj-acq",
    parentId: spec.parent,
    order: siblings.indexOf(spec),
    title: spec.title,
    blocks: spec.blocks,
    createdById: LAURA,
    createdAt: at(spec.days, spec.time),
    updatedById: last?.by ?? LAURA,
    updatedAt: last ? at(last.days, last.time) : at(spec.days, spec.time),
  };
});

interface Draft {
  pageId: string;
  at: string;
  actorId: string;
  kind: "create" | "edit";
  changes: ProductRevision["changes"];
}

const drafts: Draft[] = SPECS.flatMap((spec): Draft[] => [
  {
    pageId: spec.id,
    at: at(spec.days, spec.time),
    actorId: LAURA,
    kind: "create",
    changes: blockChanges([], initialBlocks(spec)),
  },
  ...(spec.edits ?? []).map(
    (e): Draft => ({
      pageId: spec.id,
      at: at(e.days, e.time),
      actorId: e.by,
      kind: "edit",
      changes: blockChanges(
        e.earlier ? [e.earlier] : [],
        spec.blocks.filter((b) => b.id === e.blockId),
      ),
    }),
  ),
]);

/**
 * Le revisioni in ordine di tempo. I `seq` partono da dopo quelli delle azioni
 * di Claude (`SEED_MAX_SEQ`): lo store parte dal massimo dei due (P4).
 */
export const PRODUCT_REVISIONS: ProductRevision[] = [...drafts]
  .sort((a, b) => a.at.localeCompare(b.at))
  .map((d, i) => ({
    id: `prev-acq-${i + 1}`,
    pageId: d.pageId,
    seq: SEED_MAX_SEQ + 1 + i,
    lastSeq: SEED_MAX_SEQ + 1 + i,
    at: d.at,
    actorId: d.actorId,
    kind: d.kind,
    changes: d.changes,
  }));

/** Laura segue le pagine create da lei; Marco segue Sign-in. */
export const PRODUCT_FOLLOWS: ProductFollow[] = [
  ...PRODUCT_PAGES.filter((p) => p.createdById === LAURA).map((p) => ({
    pageId: p.id,
    personId: LAURA,
    since: p.createdAt,
  })),
  { pageId: PID.signIn, personId: MARCO, since: at(25, "09:00") },
];

// --- i commenti (Task 4) -------------------------------------------------------

/**
 * Tre fili: su Sign-in uno aperto di Laura che menziona Marco, con la sua
 * risposta; su Bills uno risolto da Laura; su Phases uno sul passo che
 * Matteo ha tolto dopo («Frase eliminata»). I `seq` vengono dopo quelli
 * delle revisioni: lo store parte dal massimo (P4).
 */
const commentSeq = Math.max(...PRODUCT_REVISIONS.map((r) => r.lastSeq));

const SIGN_IN_ROOT = "pc-acq-signin-1";

export const PRODUCT_COMMENTS: ProductComment[] = [
  {
    id: SIGN_IN_ROOT,
    pageId: PID.signIn,
    anchorId: "blk-acq-signin-2",
    quote: "Google account",
    authorId: LAURA,
    body: "@Marco Bellini does this cover customers who use a Google Workspace address?",
    createdAt: at(3, "10:20"),
    replyToId: null,
    resolved: null,
    mentionIds: [MARCO],
  },
  {
    id: "pc-acq-signin-2",
    pageId: PID.signIn,
    anchorId: "blk-acq-signin-2",
    quote: "Google account",
    authorId: MARCO,
    body: "Yes: any Google account works, Workspace included.",
    createdAt: at(2, "09:45"),
    replyToId: SIGN_IN_ROOT,
    resolved: null,
    mentionIds: [],
  },
  {
    id: "pc-acq-bills-1",
    pageId: PID.bills,
    anchorId: "blk-acq-bills-6",
    quote: "stored in UTC, shown in local time",
    authorId: LAURA,
    body: "Matteo, is this the same rule as the reminders?",
    createdAt: at(8, "15:10"),
    replyToId: null,
    resolved: { byId: LAURA, at: at(7, "09:30") },
    mentionIds: [],
  },
  {
    id: "pc-acq-phases-1",
    pageId: PID.phases,
    anchorId: PHASES_REMOVED,
    quote: "Phase 3: paper bills by post",
    authorId: LAURA,
    body: "Is this still in scope? The client has not asked for it again.",
    createdAt: at(6, "12:00"),
    replyToId: null,
    resolved: null,
    mentionIds: [],
  },
].map((c, i) => ({ ...c, seq: commentSeq + 1 + i }));

const signInPageCode = PRODUCT_PAGES.find((p) => p.id === PID.signIn)!.code;

/**
 * La card di Marco per la menzione del seme, nella forma che scrive
 * `addProductComment`: titolo e corpo salvati sono la resa inglese, la
 * card li compone a lettura dai valori stabili (`actorId`,
 * `productComment`).
 */
export const PRODUCT_NOTIFICATIONS: AppNotification[] = [
  {
    id: "n-acq-product-mention-1",
    kind: "product_doc.mention",
    projectId: "prj-acq",
    objectCode: signInPageCode,
    departmentId: null,
    recipientIds: [MARCO],
    // Vuoto: la card compone il titolo in lettura (`composedOf`).
    title: "",
    body: PRODUCT_COMMENTS[0]!.body,
    createdAt: PRODUCT_COMMENTS[0]!.createdAt,
    read: false,
    archived: false,
    snoozedUntil: null,
    link: `#/p/ACQ/docs/product/${signInPageCode}?comment=${SIGN_IN_ROOT}`,
    actorId: LAURA,
    productComment: { pageId: PID.signIn, rootId: SIGN_IN_ROOT },
  },
];
