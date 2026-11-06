import { anchorText, plainTextOf } from "../../domain/productDocs/blocks";
import { visiblePeopleFor } from "../access/whoCan";
import { docsAccess } from "../docs/reads";
import { canSeeMessage } from "../mail/visibility";
import { CLAUDE_ID, PEOPLE } from "../seed/people";
import i18n from "../../i18n";
import { now, state } from "../store";
import type {
  FirstVersionPlan,
  FirstVersionSource,
  ProductBacklogDraft,
  ProductPanelPage,
  ProductQuestionRequestDraft,
  ConversationEvent,
  ProductSourceRef,
  ProductUpdateChange,
  ProductUpdatePreview,
  ProductWeekAnswer,
  ProductWeekChange,
  ProposedAction,
  Utterance,
} from "../types";
import { can, viewerFor } from "../viewer";
import { proposeBacklogFromPageAs } from "./backlog";
import { planProductSource } from "./claude";
import { firstVersionSourcesFor, productFirstVersionOf } from "./firstVersion";
import { productQuestionRequestDraft } from "./questions";
import { productPageById, productPagesOf, readableProductPages } from "./reads";
import { productFactsOf, productSourceOfMessage } from "./sourceEvents";
import { sourceViewOf } from "./sources";

// Le letture del riquadro di Claude sulla doc di prodotto (11b, Task 8),
// sincrone e a nome di chi chiede (`readsAs` le espone al motore di
// intenti). Il motore non sa niente di permessi né di visibilità: qui una
// pagina che chi chiede non legge non c'è, e un'email o una riunione che
// non può aprire si legge come una che non c'è (R-G5, decisione 1). Nessuna
// scrive: le scritture le fa il catalogo (`catalogProduct.ts`).

const DAY_MS = 24 * 60 * 60 * 1000;

const canEdit = (me: string, projectId: string): boolean =>
  docsAccess(me, projectId) === "read" && can(viewerFor(me), "docs.edit", projectId);

const nameOf = (personId: string): string | null =>
  PEOPLE.find((p) => p.id === personId)?.name ?? null;

const projectCodeOf = (projectId: string): string => state.projectsById.get(projectId)?.code ?? "";

/** La pagina se chi chiede la legge; altrimenti niente, come una che non c'è. */
function readablePage(me: string, pageId: string) {
  const page = productPageById(pageId);
  return page && docsAccess(me, page.projectId) === "read" ? page : null;
}

/** Le pagine che chi chiede legge (di un progetto, o di tutti), con `canEdit`. */
export function productPanelPagesFor(me: string, projectId: string | null): ProductPanelPage[] {
  return readableProductPages(me)
    .filter((p) => projectId === null || p.projectId === projectId)
    .map((p) => ({
      ...structuredClone(p),
      projectCode: projectCodeOf(p.projectId),
      canEdit: canEdit(me, p.projectId),
    }));
}

/**
 * Le fonti della conversazione della Posta che chi chiede ha aperta: i suoi
 * messaggi che vede, dal più recente, come fonte (`email`, o `meeting` per
 * l'email di Gemini col documento pronto) che sa aprire.
 */
function sourcesOfThread(me: string, threadId: string, projectId: string): Extract<ProductSourceRef, { id: string }>[] {
  return state.mailMessages
    .filter((m) => m.threadId === threadId && canSeeMessage(me, m))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .flatMap((m) => {
      const ref = productSourceOfMessage(m);
      if (!ref || ref.kind === "first_version") return [];
      const view = sourceViewOf(me, ref, projectId);
      return view.gone || view.link === null ? [] : [ref];
    });
}

/** La frase di un blocco come testo semplice (una cella: la sua). */
const textOf = (blocks: Parameters<typeof anchorText>[0], anchorId: string | null): string | null =>
  anchorId === null ? null : anchorText(blocks, anchorId);

/**
 * «Aggiorna la pagina da questa email o riunione»: cosa cambierebbe adesso,
 * senza scrivere (`planProductSource`, le regole del motore). La fonte è la
 * conversazione della Posta aperta (`threadId`), la più recente fra le sue
 * email che dicono qualcosa alla pagina.
 */
export function productUpdatePreviewFor(
  me: string,
  pageId: string,
  threadId: string | null,
): ProductUpdatePreview {
  const page = readablePage(me, pageId);
  if (!page) return { ok: false, reason: "not_found" };
  if (!canEdit(me, page.projectId)) return { ok: false, reason: "forbidden" };
  const refs = threadId === null ? [] : sourcesOfThread(me, threadId, page.projectId);
  if (refs.length === 0) return { ok: false, reason: "no_source" };
  const ref = refs.find((r) => productFactsOf(r).some((f) => f.pageId === page.id));
  if (!ref) return { ok: false, reason: "no_facts" };
  const plan = planProductSource(ref, page.id, productFactsOf(ref), me);
  const changes = plan.flatMap((p): ProductUpdateChange[] => {
    if (p.kind !== "edit") return [];
    const { fact, op } = p;
    if (op.op === "insert") {
      const kind = fact.change.kind === "link_task" ? "link_task" : "insert";
      return [{ kind, before: null, after: plainTextOf([op.block]) }];
    }
    if (op.op !== "set") return [];
    return [
      {
        kind: fact.change.kind === "link_task" ? "link_task" : "replace",
        before: textOf(page.blocks, fact.anchorId),
        after: textOf([op.block], fact.anchorId) ?? plainTextOf([op.block]),
      },
    ];
  });
  return {
    ok: true,
    source: { kind: ref.kind as "email" | "meeting", id: ref.id },
    changes,
    questions: plan.filter((p) => p.kind === "question").length,
    waiting: plan.filter((p) => p.kind === "wait").length,
  };
}

const plainOf = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[“”«»"']/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * «Proponi le voci di backlog» da una pagina o dalla sezione di un suo
 * titolo (`section`: il testo del titolo, senza maiuscole). Le voci e la
 * nota le dà `proposeBacklogFromPageAs`.
 */
export function productBacklogDraftFor(
  me: string,
  pageId: string,
  section: string | null,
): ProductBacklogDraft {
  const page = readablePage(me, pageId);
  if (!page) return { ok: false, reason: "not_found" };
  if (!canEdit(me, page.projectId)) return { ok: false, reason: "forbidden" };
  let anchor: string | undefined;
  if (section !== null) {
    const heading = page.blocks.find(
      (b) => b.type === "heading" && plainOf(b.content.text) === plainOf(section),
    );
    if (!heading) return { ok: false, reason: "no_section" };
    anchor = heading.id;
  }
  return { ok: true, ...proposeBacklogFromPageAs(me, page.id, anchor) };
}

/**
 * «Apri una richiesta» da una domanda di Claude (P21): la scheda di
 * `productQuestionRequestDraft`. Una domanda di una pagina che chi chiede
 * non legge si legge come una che non c'è.
 */
export function productQuestionRequestFor(me: string, commentId: string): ProductQuestionRequestDraft {
  const comment = state.productComments.find(
    (c) => c.id === commentId && c.question !== undefined && c.replyToId === null,
  );
  const page = comment ? readablePage(me, comment.pageId) : null;
  if (!comment || !page) return { ok: false, reason: "not_found" };
  try {
    const actions = productQuestionRequestDraft(me, commentId);
    return { ok: true, actions, pageCode: page.code, pageTitle: page.title };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "forbidden") {
      return { ok: false, reason: "forbidden", projectCode: projectCodeOf(page.projectId) };
    }
    if (message === "already_answered") {
      const { byId, option } = error as Error & { byId: string | null; option: "apply" | "keep" | "request" };
      return { ok: false, reason: "already_answered", byName: byId === null ? null : nameOf(byId), option };
    }
    if (message === "invalid: option") return { ok: false, reason: "no_request" };
    return { ok: false, reason: "not_found" };
  }
}

/**
 * «Scrivi la prima versione»: tutte le fonti del progetto che chi chiede
 * vede (email, riunioni con la trascrizione, file del Drive), come le
 * elenca la finestra della pagina. I rifiuti nell'ordine di `startFirstVersionAs`.
 */
export function firstVersionPlanFor(me: string, projectId: string): FirstVersionPlan {
  const access = docsAccess(me, projectId);
  if (access === "none") return { ok: false, reason: "not_found" };
  if (!canEdit(me, projectId)) return { ok: false, reason: "forbidden" };
  if (productPagesOf(projectId).length > 0 || productFirstVersionOf(me, projectId)?.status === "writing") {
    return { ok: false, reason: "space_not_empty" };
  }
  const found = firstVersionSourcesFor(me, projectId);
  const sources: FirstVersionSource[] = [
    ...found.emails.map((e): FirstVersionSource => ({ kind: "email", id: e.id })),
    ...found.meetings
      .filter((m) => m.transcript)
      .map((m): FirstVersionSource => ({ kind: "meeting", id: m.id })),
    ...found.files.map((f): FirstVersionSource => ({ kind: "drive", fileId: f.id })),
  ];
  return sources.length === 0 ? { ok: false, reason: "no_sources" } : { ok: true, sources };
}

/** Una fonte una volta sola (la stessa riga del registro della pagina). */
const refKey = (ref: ProductSourceRef): string =>
  ref.kind === "first_version" ? `first_version:${ref.ids.join(",")}` : `${ref.kind}:${ref.id}`;

/**
 * «Cosa è cambiato nella doc questa settimana»: le pagine che chi chiede
 * legge con revisioni negli ultimi sette giorni (`now()`), dalla più
 * recente, con chi ha scritto e le fonti come riferimenti. Nomi e frasi
 * delle fonti li compone la lettura dell'evento, per chi legge
 * (`presentProductClaudeEvent`): il testo salvato non le ha mai.
 */
export function productWeekChangesFor(me: string, projectId: string | null): ProductWeekChange[] {
  const since = Date.parse(now()) - 7 * DAY_MS;
  const out: { row: ProductWeekChange; last: number }[] = [];
  for (const page of readableProductPages(me)) {
    if (projectId !== null && page.projectId !== projectId) continue;
    const revisions = state.productRevisions.filter(
      (r) => r.pageId === page.id && Date.parse(r.at) >= since,
    );
    if (revisions.length === 0) continue;
    const sources = new Map<string, ProductSourceRef>();
    for (const r of revisions) if (r.source) sources.set(refKey(r.source), r.source);
    out.push({
      row: {
        pageId: page.id,
        code: page.code,
        title: page.title,
        projectCode: projectCodeOf(page.projectId),
        changes: revisions.length,
        byIds: [...new Set(revisions.map((r) => r.actorId))],
        sourceRefs: [...sources.values()],
      },
      last: Math.max(...revisions.map((r) => r.lastSeq)),
    });
  }
  return out.sort((a, b) => b.last - a.last).map((x) => x.row);
}

// --- la lettura per chi legge (fix round 1: decisione 1, R-G5, I1) -----------------
//
// Una conversazione libera può essere pubblica: chi la legge non è per forza
// chi ha chiesto, né un destinatario dell'email. Quindi le frasi di
// un'email e il suo oggetto non stanno MAI nel testo salvato di Claude:
// stanno nel dato (l'azione proposta, l'evento della risposta) e ogni
// lettura li ricompone per chi legge, con `sourceViewOf(chi legge)`. Chi non
// può aprire l'email legge «da un'email di <titolare> · <data>» e quante
// frasi, mai le frasi; una pagina che non legge non c'è. Il dato esce tolto.

const K = "claude.answers.productDocs";
const tr = (key: string, params?: Record<string, unknown>): string => i18n.t(key, params);

/** Una riga del blocco che cambierebbe, nella lingua di adesso. */
function changeLine(c: ProductUpdateChange): string {
  const clip = (s: string | null) => (s ?? "").trim();
  if (c.kind === "replace" && c.before !== null)
    return tr(`${K}.update.change.replace`, { before: clip(c.before), after: clip(c.after) });
  if (c.kind === "link_task") return tr(`${K}.update.change.linkTask`, { after: clip(c.after) });
  return tr(`${K}.update.change.insert`, { after: clip(c.after) });
}

/** Il «perché» della riga della scheda di `updateProductPage`, per chi legge; `null` = nessuno. */
function updateWhyFor(me: string, action: ProposedAction): Utterance | null {
  const preview = action.productPreview;
  const page = typeof action.args.pageId === "string" ? readablePage(me, action.args.pageId) : null;
  const source = action.args.source as Extract<ProductSourceRef, { id: string }> | undefined;
  if (!preview || !page || !source || typeof source.id !== "string") return null;
  const view = sourceViewOf(me, source, page.projectId);
  const label = tr(view.label.key, view.label.params);
  if (view.link !== null && !view.gone) {
    return {
      key: `${K}.update.why.open`,
      params: { source: label, sentences: preview.changes.map(changeLine).join(" · ") },
    };
  }
  return { key: `${K}.update.why.hidden`, params: { source: label, count: preview.changes.length } };
}

/** La risposta della settimana per chi legge: le sue pagine, le persone che vede, le fonti come le legge. */
function weekTextFor(me: string, week: ProductWeekAnswer): string {
  const people = visiblePeopleFor(me);
  const lines = week.rows.flatMap((row) => {
    const page = readablePage(me, row.pageId);
    if (!page) return [];
    const names = row.byIds
      .filter((id) => id === CLAUDE_ID || people.has(id))
      .map(nameOf)
      .filter((n): n is string => n !== null);
    const sources = [
      ...new Set(
        row.sourceRefs.map((ref) => {
          const view = sourceViewOf(me, ref, page.projectId);
          return tr(view.label.key, view.label.params);
        }),
      ),
    ];
    return [
      [
        `**${page.code}** ${page.title}`,
        tr(`${K}.changes.count`, { count: row.changes }),
        ...(names.length > 0 ? [tr(`${K}.changes.by`, { names: names.join(", ") })] : []),
        ...sources,
      ].join(" · "),
    ];
  });
  const code = week.projectCode;
  if (lines.length === 0) return code ? tr(`${K}.changes.none`, { code }) : tr(`${K}.changes.noneAll`);
  const shown = lines.slice(0, 8).map((l) => `- ${l}`);
  if (lines.length > 8) shown.push(`- ${tr("claude.answers.more", { count: lines.length - 8 })}`);
  const lead = code ? tr(`${K}.changes.lead`, { code }) : tr(`${K}.changes.leadAll`);
  return `${lead}\n\n${shown.join("\n")}`;
}

/**
 * La lettura di un evento di Claude con la doc di prodotto, per chi legge
 * (`presentEventFor`): ricompone il testo della settimana e il «perché»
 * dell'aggiornamento, e toglie il dato. Lavora sulla copia della lettura.
 */
export function presentProductClaudeEvent(me: string, event: ConversationEvent): void {
  if (event.type === "assistant" && event.productWeek) {
    event.text = weekTextFor(me, event.productWeek);
    delete event.productWeek;
    return;
  }
  if (event.type !== "proposal" && event.type !== "executed") return;
  if (!event.actions.some((a) => a.productPreview)) return;
  event.actions = event.actions.map((a) => {
    if (!a.productPreview) return a;
    const why = a.fn === "updateProductPage" ? updateWhyFor(me, a) : null;
    const copy = { ...a };
    delete copy.productPreview;
    if (why) copy.why = why;
    else delete copy.why;
    return copy;
  });
}
