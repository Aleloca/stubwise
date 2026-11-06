import type {
  ProductPanelPage,
  ProductUpdateChange,
  ProductWeekChange,
  ProposedAction,
} from "../../../data/types";
import { bulleted, labelled, resulted, summarized, type Answer } from "../answers";
import type { IntentContext, T } from "../context";
import { findProject, normalize, stripCourtesy } from "../parse";
import { byClass } from "./change";
import { noteLine } from "./archive";

// La doc di prodotto nel riquadro di Claude (11b, Task 8; spec «Claude nel
// riquadro»). Cinque gesti e le due frasi che la pagina manda al riquadro
// (P21):
// - «scrivi la prima versione» (A con «Undo»): `writeFirstVersion` con tutte
//   le fonti del progetto che chi chiede vede;
// - «aggiorna <pagina> da questa email/riunione» (B: avvisa chi segue):
//   `updateProductPage`, dalla conversazione della Posta aperta nel chip.
//   Un'email che chi chiede non può aprire si legge come una che non c'è;
// - «proponi le voci di backlog da <pagina>[ sezione]» (la scheda in blocco
//   di `createRequest`);
// - «disegna questa schermata in <pagina>» (A con «Undo»): `drawWireframe`
//   in fondo alla pagina;
// - «cosa è cambiato nella doc questa settimana» (una lettura);
// - «apri una richiesta dalla domanda <id>» (la scheda B della domanda).
// Il motore è puro: legge da `ctx.read` (come chi chiede), propone, e la
// classe la dice il livello dati (`byClass`). Il testo che una modifica
// scrive è quello del fatto, parola per parola: qui non si inventa niente.

const K = "claude.answers.productDocs";

/** «open a request from question pc-…» / «apri una richiesta dalla domanda pc-…» (P21). */
const QUESTION_REQUEST =
  /^(?:open a request from (?:claude'?s )?question|apri una richiesta dalla domanda(?: di claude)?)\s+\S/;
const QUESTION_ID = /\b(?:question|domanda)\s+([A-Za-z0-9_-]+)/;
const FIRST_VERSION =
  /^(?:write|draft|scrivi|scrivimi|scrivere|fai|prepara)\b.*\b(?:first version|prima versione)\b/;
const UPDATE =
  /^(?:update|aggiorna|aggiornare)\b.*\b(?:from|da|dalla|dall'|con)\s*(?:this|the|questa|quest'|la|l')?\s*(?:e-?mail|mail|meeting|riunione)\b/;
const BACKLOG = /^(?:propose|suggest|proponi|proporre|suggerisci)\b.*\bbacklog\b/;
const DRAW =
  /^(?:draw|sketch|disegna|disegnami|disegnare|abbozza)\b.*\b(?:screen|sketch|wireframe|schermata|bozza)\b/;
const CHANGED = /\b(?:changed|cambiat[oaie]|cambiamenti|changes)\b/;
const THIS_WEEK = /\b(?:this week|last 7 days|past week|questa settimana|ultimi 7 giorni|ultima settimana)\b/;
const DOCS = /\b(?:docs?|documentation|documentazione)\b/;
/** La sezione nominata fra virgolette: «…from the section “Phase 2” of ACQ-D11». */
const SECTION = /\b(?:section|sezione)\s+[“"«‘']([^”"»’']+)[”"»’']/i;

type Gesture = "question" | "firstVersion" | "update" | "backlog" | "draw" | "changes";

function gestureOf(text: string): Gesture | null {
  const plain = normalize(text);
  const { command } = stripCourtesy(plain);
  if (QUESTION_REQUEST.test(command)) return "question";
  if (FIRST_VERSION.test(command)) return "firstVersion";
  if (UPDATE.test(command)) return "update";
  if (BACKLOG.test(command)) return "backlog";
  if (DRAW.test(command)) return "draw";
  if (CHANGED.test(plain) && THIS_WEEK.test(plain) && DOCS.test(plain)) return "changes";
  return null;
}

/** Una delle frasi della doc di prodotto (prima di ogni altro intento: sono comandi precisi). */
export const isProductDocRequest = (text: string): boolean => gestureOf(text) !== null;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * La pagina nominata: il codice (`ACQ-D5`), o il titolo intero fra le
 * pagine che chi chiede legge — col progetto del contesto prima, e il
 * titolo più lungo se più d'uno. `null` = nessuna.
 */
function pageIn(
  text: string,
  pages: readonly ProductPanelPage[],
  contextProjectId: string | null,
): ProductPanelPage | null {
  const upper = text.toUpperCase();
  const byCode = pages.find((p) => new RegExp(`\\b${escape(p.code)}\\b`).test(upper));
  if (byCode) return byCode;
  const plain = normalize(text);
  const titled = pages
    .filter((p) =>
      new RegExp(`(^|[^\\p{L}\\p{N}])${escape(normalize(p.title))}($|[^\\p{L}\\p{N}])`, "u").test(plain),
    )
    .sort(
      (a, b) =>
        Number(b.projectId === contextProjectId) - Number(a.projectId === contextProjectId) ||
        b.title.length - a.title.length,
    );
  return titled[0] ?? null;
}

const say = (text: string, extra: Partial<Answer> = {}): Answer => ({ actions: [], text, ...extra });

/** «… è di chi ha Modifica Docs in ACQ · Who?» (il «Who?» di `editDocs`, come le note delle schede). */
const forbidden = (t: T, projectCode: string) =>
  t(`${K}.forbidden`, {
    code: projectCode,
    who: `[${t("claude.answers.refused.who")}](who:editDocs/${projectCode})`,
  });

const docRef = (page: { id: string }) => ({ kind: "doc" as const, id: page.id });

const quote = (s: string | null) => (s === null ? "" : s.trim());

export async function productDoc(text: string, ctx: IntentContext): Promise<Answer> {
  switch (gestureOf(text)) {
    case "question":
      return questionRequest(text, ctx);
    case "firstVersion":
      return firstVersion(text, ctx);
    case "update":
      return update(text, ctx);
    case "backlog":
      return backlog(text, ctx);
    case "draw":
      return draw(text, ctx);
    case "changes":
    default:
      return changes(text, ctx);
  }
}

/** La pagina del testo, o la risposta da dare se non c'è. */
async function pageOf(text: string, ctx: IntentContext): Promise<ProductPanelPage | Answer> {
  const pages = await ctx.read.listProductPages(null);
  return pageIn(text, pages, ctx.contextProjectId) ?? say(ctx.t(`${K}.whichPage`));
}

const isAnswer = (x: ProductPanelPage | Answer): x is Answer => "actions" in x && "text" in x;

// --- «apri una richiesta dalla domanda» (P21) ------------------------------------

async function questionRequest(text: string, ctx: IntentContext): Promise<Answer> {
  const { t } = ctx;
  const id = QUESTION_ID.exec(text)?.[1] ?? "";
  const draft = await ctx.read.productQuestionRequest(id);
  if (!draft.ok) {
    switch (draft.reason) {
      case "forbidden":
        return say(forbidden(t, draft.projectCode));
      case "already_answered":
        return say(
          draft.byName
            ? t(`${K}.question.answeredBy`, { name: draft.byName, answer: t(`${K}.answer.${draft.option}`) })
            : t(`${K}.question.answered`, { answer: t(`${K}.answer.${draft.option}`) }),
        );
      case "no_request":
        return say(t(`${K}.question.noRequest`));
      default:
        // Una domanda di una pagina che chi chiede non legge è una che non c'è.
        return say(t(`${K}.question.notFound`));
    }
  }
  const lead = t(`${K}.question.proposed`, { code: draft.pageCode, title: draft.pageTitle });
  const answer = await byClass(ctx, draft.actions[0]!, lead, lead);
  return {
    actions: [],
    ...answer,
    text: [answer.text, lead, t(`${K}.question.closes`)].filter((l, i, all) => all.indexOf(l) === i).join("\n\n"),
  };
}

// --- «scrivi la prima versione» -----------------------------------------------------

async function firstVersion(text: string, ctx: IntentContext): Promise<Answer> {
  const { t, read } = ctx;
  const { project, named } = findProject(text, await read.listProjects(), ctx.contextProjectId);
  if (!project) {
    return say(
      named ? t("claude.answers.status.projectNotFound", { code: named }) : t(`${K}.whichProject`),
    );
  }
  const plan = await read.firstVersionPlan(project.id);
  if (!plan.ok) {
    switch (plan.reason) {
      case "forbidden":
        return say(forbidden(t, project.code));
      case "space_not_empty":
        return say(t(`${K}.firstVersion.spaceNotEmpty`, { code: project.code }));
      case "no_sources":
        return say(t(`${K}.firstVersion.noSources`, { code: project.code }));
      default:
        return say(t("claude.answers.howto.noDocs", { code: project.code }));
    }
  }
  const count = plan.sources.length;
  const action: ProposedAction = {
    fn: "writeFirstVersion",
    args: { projectId: project.id, sources: plan.sources },
    ...summarized(t, `${K}.firstVersion.summary`, { code: project.code }),
  };
  const read_ = {
    tool: "list_sources",
    ...labelled(t, `${K}.actions.readSources`, { code: project.code }),
    ...resulted(t, `${K}.actions.sources`, { count }),
  };
  const answer = await byClass(
    ctx,
    action,
    t(`${K}.firstVersion.done`, { code: project.code, count }),
    t(`${K}.firstVersion.proposed`, { code: project.code, count }),
  );
  return { actions: [read_], ...answer };
}

// --- «aggiorna la pagina da questa email o riunione» ----------------------------------

function changeLine(t: T, c: ProductUpdateChange): string {
  if (c.kind === "replace" && c.before !== null)
    return t(`${K}.update.change.replace`, { before: quote(c.before), after: quote(c.after) });
  if (c.kind === "link_task") return t(`${K}.update.change.linkTask`, { after: quote(c.after) });
  return t(`${K}.update.change.insert`, { after: quote(c.after) });
}

async function update(text: string, ctx: IntentContext): Promise<Answer> {
  const { t } = ctx;
  const page = await pageOf(text, ctx);
  if (isAnswer(page)) return page;
  if (!page.canEdit) return say(forbidden(t, page.projectCode));
  // «Questa email»: la conversazione della Posta che chi chiede ha aperta.
  const threadId = ctx.context?.kind === "mail" ? ctx.context.threadId : null;
  const preview = await ctx.read.productUpdatePreview(page.id, threadId);
  const named = { code: page.code, title: page.title };
  if (!preview.ok) {
    switch (preview.reason) {
      case "forbidden":
        return say(forbidden(t, page.projectCode));
      case "no_facts":
        return say(t(`${K}.update.noFacts`, named), { refs: [docRef(page)] });
      case "not_found":
        return say(t(`${K}.whichPage`));
      default:
        // Nessuna email aperta, una che non c'è e una che chi chiede non può
        // aprire: la stessa frase, senza nominarla (R-G5).
        return say(t(`${K}.update.noSource`));
    }
  }
  if (preview.changes.length === 0 && preview.questions === 0 && preview.waiting === 0) {
    return say(t(`${K}.update.nothing`, named), { refs: [docRef(page)] });
  }
  const action: ProposedAction = {
    fn: "updateProductPage",
    args: { pageId: page.id, source: preview.source },
    ...summarized(t, `${K}.update.summary.${preview.source.kind}`, named),
  };
  const answer = await byClass(
    ctx,
    action,
    t(`${K}.update.done`, named),
    t(`${K}.update.proposed`, named),
  );
  // I blocchi, parola per parola, e cosa resta una domanda o aspetta.
  const lines = [
    answer.text,
    ...(answer.proposal ? [t(`${K}.update.lead`, named)] : []),
    ...(preview.changes.length > 0
      ? [bulleted(t, preview.changes.map((c) => changeLine(t, c)), 8)]
      : []),
    ...(preview.questions > 0 ? [t(`${K}.update.questions`, { count: preview.questions })] : []),
    ...(preview.waiting > 0 ? [t(`${K}.update.waiting`, { count: preview.waiting })] : []),
  ];
  return { actions: [], ...answer, text: lines.join("\n\n"), refs: [docRef(page)] };
}

// --- «proponi le voci di backlog» ---------------------------------------------------

async function backlog(text: string, ctx: IntentContext): Promise<Answer> {
  const { t } = ctx;
  const page = await pageOf(text, ctx);
  if (isAnswer(page)) return page;
  if (!page.canEdit) return say(forbidden(t, page.projectCode));
  const section = SECTION.exec(text)?.[1]?.trim() ?? null;
  const draft = await ctx.read.productBacklogDraft(page.id, section);
  const named = { code: page.code, title: page.title, section: section ?? "" };
  if (!draft.ok) {
    if (draft.reason === "no_section") return say(t(`${K}.backlog.noSection`, named));
    if (draft.reason === "forbidden") return say(forbidden(t, page.projectCode));
    return say(t(`${K}.whichPage`));
  }
  const where = section === null ? "page" : "section";
  if (draft.actions.length === 0) {
    const note = draft.notes.find((n) => n.kind === "already_proposed");
    if (!note || note.kind !== "already_proposed") {
      return say(t(`${K}.backlog.noItems.${where}`), { refs: [docRef(page)] });
    }
    const head =
      note.codes.length > 0
        ? t(`${K}.backlog.allProposed.${where}`, { codes: note.codes.map((c) => `**${c}**`).join(", ") })
        : noteLine(t, note);
    const more =
      note.codes.length > 0 && note.hidden > 0
        ? ` ${t(`${K}.backlog.alreadyProposedMore`, { count: note.hidden })}`
        : "";
    return say(`${head}${more}`, { refs: [docRef(page)] });
  }
  return {
    actions: [],
    text: t(`${K}.backlog.proposed.${where}`, { ...named, count: draft.actions.length }),
    proposal: draft.actions,
    ...(draft.notes.length > 0 ? { notes: draft.notes } : {}),
    refs: [docRef(page)],
  };
}

// --- «disegna questa schermata» --------------------------------------------------------

async function draw(text: string, ctx: IntentContext): Promise<Answer> {
  const { t } = ctx;
  const page = await pageOf(text, ctx);
  if (isAnswer(page)) return page;
  if (!page.canEdit) return say(forbidden(t, page.projectCode));
  const named = { code: page.code, title: page.title };
  // In fondo alla pagina: dopo l'ultimo blocco (`null` = una pagina vuota, in cima).
  const action: ProposedAction = {
    fn: "drawWireframe",
    args: { pageId: page.id, afterId: page.blocks.at(-1)?.id ?? null },
    ...summarized(t, `${K}.draw.summary`, named),
  };
  const answer = await byClass(ctx, action, t(`${K}.draw.done`, named), t(`${K}.draw.proposed`, named));
  return { actions: [], ...answer, refs: [docRef(page)] };
}

// --- «cosa è cambiato nella doc questa settimana» -------------------------------------

function weekLine(t: T, row: ProductWeekChange): string {
  const parts = [
    `**${row.code}** ${row.title}`,
    t(`${K}.changes.count`, { count: row.changes }),
    ...(row.byNames.length > 0 ? [t(`${K}.changes.by`, { names: row.byNames.join(", ") })] : []),
    ...row.sources.map((s) => t(s.label.key, s.label.params)),
  ];
  return parts.join(" · ");
}

async function changes(text: string, ctx: IntentContext): Promise<Answer> {
  const { t, read } = ctx;
  const { project, named } = findProject(text, await read.listProjects(), ctx.contextProjectId);
  if (named && !project) return say(t("claude.answers.status.projectNotFound", { code: named }));
  const rows = await read.productChangesThisWeek(project?.id ?? null);
  const action = {
    tool: "list_product_revisions",
    ...(project
      ? labelled(t, `${K}.actions.readChanges`, { code: project.code })
      : labelled(t, `${K}.actions.readAllChanges`)),
    ...resulted(t, "claude.answers.actions.pages", { count: rows.length }),
  };
  if (rows.length === 0) {
    return {
      actions: [action],
      text: project
        ? t(`${K}.changes.none`, { code: project.code })
        : t(`${K}.changes.noneAll`),
    };
  }
  return {
    actions: [action],
    text: [
      project ? t(`${K}.changes.lead`, { code: project.code }) : t(`${K}.changes.leadAll`),
      bulleted(t, rows.map((r) => weekLine(t, r)), 8),
    ].join("\n\n"),
    refs: rows.map((r) => docRef({ id: r.pageId })),
  };
}
