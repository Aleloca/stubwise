import { backlogJobs, productComments, productPages, users, type Db } from "@stubwise/db";
import { productQuestionAnswerSchema, productQuestionSchema, type ProductAnswerChoice, type ProductDocOrigin, type ProductQuestion, type ProductQuestionAnswer } from "@stubwise/shared";
import { and, eq, inArray } from "drizzle-orm";
import { projectPermissionsFor } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { personName } from "./people.js";
import { visiblePersonIds } from "./people-visibility.js";
import { ProductDocsError } from "./product-docs.js";

/**
 * Area 11, F5, Task 4 — la parte LEGGERA delle domande di Claude: leggere la
 * domanda e la risposta di un commento, chiuderla, e l'origine `product_doc`
 * di una richiesta («Open a request»). Sta a parte da `product-questions.ts`
 * perché la usa anche il catalogo delle azioni di Claude (`createRequest`), che
 * non deve raggiungere le scritture della pagina né lo storage
 * (`claude-actions-effects.test.ts`, sul sorgente).
 */

type Viewer = Pick<SessionUser, "id" | "instancePermissions">;
type CommentRow = typeof productComments.$inferSelect;

/** 409: la domanda ha già una risposta (`already_answered`), o la frase è cambiata dopo (`changed_after`). */
export class ProductQuestionConflictError extends ProductDocsError {
  constructor(
    readonly reason: "already_answered" | "changed_after",
    readonly by: { id: string | null; name: string | null },
    readonly option: ProductAnswerChoice | null = null,
  ) {
    super(409, reason, reason === "already_answered" ? "The question already has an answer" : "The sentence changed after the question");
  }
}

export const questionOf = (row: Pick<CommentRow, "question">): ProductQuestion | null => {
  const parsed = row.question ? productQuestionSchema.safeParse(row.question) : null;
  return parsed?.success ? parsed.data : null;
};

/**
 * I job d'intake FALLITI fra le risposte «Open a request» dei commenti: una
 * domanda chiusa da una richiesta che non è nata torna aperta (DERIVATO a
 * lettura, revisione di F5: nessun processo la riscrive).
 */
export async function failedIntakeJobs(db: Pick<Db, "select">, rows: readonly Pick<CommentRow, "answer">[]): Promise<ReadonlySet<string>> {
  const ids = rows.flatMap((r) => {
    const a = answerOf(r);
    return a?.requestJobId ? [a.requestJobId] : [];
  });
  if (ids.length === 0) return new Set();
  const failed = await db.select({ id: backlogJobs.id }).from(backlogJobs).where(and(inArray(backlogJobs.id, ids), eq(backlogJobs.status, "failed")));
  return new Set(failed.map((j) => j.id));
}

/** La risposta che conta: null se non c'è, o se la richiesta che la chiudeva non è nata (intake fallito). */
export const effectiveAnswer = (row: Pick<CommentRow, "answer">, failed: ReadonlySet<string>): ProductQuestionAnswer | null => {
  const a = answerOf(row);
  return a && !(a.requestJobId && failed.has(a.requestJobId)) ? a : null;
};

export const answerOf = (row: Pick<CommentRow, "answer">): ProductQuestionAnswer | null => {
  const parsed = row.answer ? productQuestionAnswerSchema.safeParse(row.answer) : null;
  return parsed?.success ? parsed.data : null;
};

/** I nomi delle persone che chi guarda vede (R-G5). */
export async function namesFor(db: Db, viewer: Viewer, ids: readonly (string | null)[]): Promise<(id: string | null) => string | null> {
  const wanted = [...new Set(ids.filter((x): x is string => x !== null))];
  if (wanted.length === 0) return () => null;
  const people = await visiblePersonIds(db, viewer);
  const rows = await db.select({ id: users.id, email: users.email, displayName: users.displayName, isAgent: users.isAgent }).from(users).where(inArray(users.id, wanted));
  const names = new Map(rows.map((u) => [u.id, { name: personName(u), agent: u.isAgent }]));
  return (id) => {
    const u = id ? names.get(id) : undefined;
    // Claude si nomina sempre; una persona solo se chi guarda la vede.
    return u && (u.agent || people === "all" || people.includes(id!)) ? u.name : null;
  };
}

/** Chiude la domanda con la risposta (e il filo fra i risolti), nella transazione di chi risponde. */
export async function close(tx: Db, viewer: Viewer, commentId: string, answer: Pick<ProductQuestionAnswer, "option" | "revisionId" | "requestJobId">): Promise<void> {
  const full: ProductQuestionAnswer = { byId: viewer.id, at: new Date().toISOString(), requestId: null, ...answer };
  await tx
    .update(productComments)
    .set({ answer: full as unknown as Record<string, unknown>, resolvedAt: new Date(), resolvedBy: viewer.id })
    .where(eq(productComments.id, commentId));
}

/**
 * L'origine `product_doc` di una richiesta nuova (il prototipo:
 * `checkProductDocOrigin`), nella transazione della richiesta e PRIMA che
 * nasca: la pagina c'è, è del progetto della richiesta e chi chiede ne legge
 * i Docs (altrimenti 422 `invalid_origin`, senza dire perché); la domanda è
 * una radice di Claude di quella pagina, ha una richiesta da proporre, è
 * aperta (409 `already_answered` con chi) e chi chiede può rispondere
 * (`docs.edit`, 403). Blocca pagina e commento: due conferme della stessa
 * scheda non fanno due richieste.
 */
export async function checkProductDocOrigin(tx: Db, viewer: Viewer, projectId: string, origin: ProductDocOrigin): Promise<void> {
  const invalidOrigin = () => new ProductDocsError(422, "invalid_origin", "The request's origin is not valid");
  const [page] = await tx.select({ id: productPages.id, projectId: productPages.projectId }).from(productPages).where(eq(productPages.id, origin.pageId)).for("no key update");
  const perms = page ? await projectPermissionsFor(tx, viewer, page.projectId) : null;
  if (!page || page.projectId !== projectId || !perms?.has("docs.view")) throw invalidOrigin();
  // F6, Task 3: la voce proposta dalla pagina, senza domanda. Fino ad allora l'origine vuole la domanda.
  if (origin.questionId === undefined) throw invalidOrigin();
  const [comment] = await tx.select().from(productComments).where(eq(productComments.id, origin.questionId)).for("update");
  const q = comment && comment.pageId === page.id && comment.replyToId === null && comment.deletedAt === null ? questionOf(comment) : null;
  if (!comment || !q) throw invalidOrigin();
  if (!perms.has("docs.edit")) throw new ProductDocsError(403, "forbidden", "Forbidden");
  const prior = effectiveAnswer(comment, await failedIntakeJobs(tx, [comment]));
  if (prior) throw new ProductQuestionConflictError("already_answered", { id: prior.byId, name: (await namesFor(tx, viewer, [prior.byId]))(prior.byId) }, prior.option);
  if (q.request === null) throw invalidOrigin();
}

/** Chiude con «Open a request» la domanda dell'origine (già controllata), nella transazione del job d'intake. */
export async function closeQuestionWithRequest(tx: Db, viewer: Viewer, origin: ProductDocOrigin, requestJobId: string): Promise<void> {
  if (origin.questionId === undefined) return;
  await close(tx, viewer, origin.questionId, { option: "request", revisionId: null, requestJobId });
}

