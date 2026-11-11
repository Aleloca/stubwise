import { docPageCodes, docPages, projects, repositories, type Db } from "@stubwise/db";
import { DOC_CODE_RE, docCode, type DocCodeResolution } from "@stubwise/shared";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { projectIdsWithPermission } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";

/**
 * I codici `<PRJ>-D<n>` delle pagine Docs (area 5, fetta 1; tabella
 * `doc_page_codes`, 0142). Il codice è di (repository, slug): lo dà il trigger
 * a ogni pagina nuova, e le letture lo aggiungono dopo la loro query, in UNA
 * query per elenco (`docCodesFor`).
 */

type Viewer = Pick<SessionUser, "id" | "instancePermissions">;

const keyOf = (repositoryId: string, slug: string): string => `${repositoryId}:${slug}`;

/** I codici di (repository, slug), come `PRJ-D12`; una coppia senza codice non c'è nella mappa. */
export async function docCodesFor(db: Db, refs: readonly { repositoryId: string; slug: string }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (refs.length === 0) return out;
  const repositoryIds = [...new Set(refs.map((r) => r.repositoryId))];
  const slugs = [...new Set(refs.map((r) => r.slug))];
  const rows = await db
    .select({ repositoryId: docPageCodes.repositoryId, slug: docPageCodes.slug, number: docPageCodes.number, projectCode: projects.code })
    .from(docPageCodes)
    .innerJoin(projects, eq(projects.id, docPageCodes.projectId))
    .where(and(inArray(docPageCodes.repositoryId, repositoryIds), inArray(docPageCodes.slug, slugs)));
  for (const r of rows) out.set(keyOf(r.repositoryId, r.slug), docCode(r.projectCode, r.number));
  return out;
}

/** Aggiunge `code` a righe che hanno repository e slug. */
export async function withDocCodes<T extends { repositoryId: string; slug: string }>(db: Db, rows: readonly T[]): Promise<(T & { code: string | null })[]> {
  const codes = await docCodesFor(db, rows);
  return rows.map((r) => ({ ...r, code: codes.get(keyOf(r.repositoryId, r.slug)) ?? null }));
}

/** Come {@link withDocCodes}, per righe di un repository solo (albero, pagina, highlights). */
export async function withDocCodesIn<T extends { slug: string }>(db: Db, repositoryId: string, rows: readonly T[]): Promise<(T & { code: string | null })[]> {
  const codes = await docCodesFor(db, rows.map((r) => ({ repositoryId, slug: r.slug })));
  return rows.map((r) => ({ ...r, code: codes.get(keyOf(repositoryId, r.slug)) ?? null }));
}

/**
 * Dove sta la pagina di un codice, per chi guarda: solo con `docs.view` nel
 * progetto del codice. Un progetto che non legge e un codice che non c'è danno
 * entrambi null (404, R-G5). `available`: la pagina visibile di quella coppia
 * c'è ancora (generazione corrente o manuale).
 */
export async function resolveDocCode(db: Db, viewer: Viewer, code: string): Promise<DocCodeResolution | null> {
  // Senza distinzione di maiuscole, come la ricerca (i codici di progetto sono maiuscoli).
  const match = DOC_CODE_RE.exec(code.trim().toUpperCase());
  if (!match) return null;
  const [, projectCode, number] = match;
  const [row] = await db
    .select({
      projectId: docPageCodes.projectId,
      repositoryId: docPageCodes.repositoryId,
      repositorySlug: repositories.slug,
      currentGeneration: repositories.currentDocGenerationId,
      slug: docPageCodes.slug,
    })
    .from(docPageCodes)
    .innerJoin(projects, eq(projects.id, docPageCodes.projectId))
    .innerJoin(repositories, eq(repositories.id, docPageCodes.repositoryId))
    .where(and(eq(projects.code, projectCode!), eq(docPageCodes.number, Number(number))));
  if (!row) return null;
  const readable = await projectIdsWithPermission(db, viewer, "docs.view");
  if (readable !== "all" && !readable.includes(row.projectId)) return null;
  const [page] = await db
    .select({ id: docPages.id })
    .from(docPages)
    .where(
      and(
        eq(docPages.repositoryId, row.repositoryId),
        eq(docPages.slug, row.slug),
        row.currentGeneration ? or(eq(docPages.generationId, row.currentGeneration), isNull(docPages.generationId)) : isNull(docPages.generationId),
      ),
    )
    .limit(1);
  return {
    code: `${projectCode}-D${number}`,
    projectId: row.projectId,
    repositoryId: row.repositoryId,
    repositorySlug: row.repositorySlug,
    slug: row.slug,
    available: page !== undefined,
  };
}

/** Il codice D esatto in `q` (per la ricerca: un codice va in cima), o null. */
export function exactDocCode(q: string): string | null {
  const trimmed = q.trim().toUpperCase();
  return DOC_CODE_RE.test(trimmed) ? trimmed : null;
}

