import { backlogItemRevisions, backlogItems, type Db } from "@stubwise/db";
import type { BacklogItemStatus, BacklogSuggested, UpdateBacklogItemInput } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import type { DbOrTx, Tx } from "./dispatch.js";

/**
 * Regole UNICHE di scrittura di design, piano e metadati di una voce di
 * backlog (design 2026-10-14 §4.3). Le usano le rotte del server
 * (`apps/server/src/routes/backlog.ts`) e il ponte dei tool della sessione di
 * refinement nel worker: mai due copie. Con `revision` il valore PRECEDENTE
 * finisce in `backlog_item_revisions`, nella stessa transazione.
 */

export type BacklogItemRevisionSource = { agentSessionId: string };
export type BacklogItemMetadataPatch = Omit<UpdateBacklogItemInput, "status">;
type ItemUpdate = Partial<typeof backlogItems.$inferInsert>;

/**
 * Sempre in transazione: su un `Db` è una transazione nuova, su una `Tx` (il
 * ponte del worker scrive dentro la sua) drizzle apre un SAVEPOINT. Un solo
 * percorso di codice per i due chiamanti.
 */
function inTx<T>(db: DbOrTx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return (db as Db).transaction(fn);
}

/**
 * Chiavi AZIONABILI di `suggested`: i metadati promuovibili sui campi reali.
 * `reason` è la motivazione dei suggerimenti, non un metadato: da sola non
 * tiene vivo l'oggetto (né dà nulla da accettare).
 */
const ACTIONABLE_SUGGESTED_KEYS = ["effort", "risk", "riskNote", "urgency"] as const;

/** True se `suggested` contiene almeno un metadato azionabile. */
export function hasActionableSuggested(
  suggested: BacklogSuggested | null | undefined,
): suggested is BacklogSuggested {
  return suggested != null && ACTIONABLE_SUGGESTED_KEYS.some((k) => suggested[k] !== undefined);
}

async function lockItem(tx: DbOrTx, itemId: string) {
  const [item] = await tx.select().from(backlogItems).where(eq(backlogItems.id, itemId)).for("update");
  return item;
}

async function saveRevision(
  tx: DbOrTx,
  itemId: string,
  field: "document" | "implementation_plan" | "metadata",
  previous: Record<string, unknown>,
  revision: BacklogItemRevisionSource | undefined,
): Promise<void> {
  if (revision === undefined) return;
  await tx.insert(backlogItemRevisions).values({ itemId, field, previous, agentSessionId: revision.agentSessionId });
}

export async function setBacklogItemDesign(
  db: DbOrTx,
  itemId: string,
  markdown: string,
  revision?: BacklogItemRevisionSource,
): Promise<"ok" | "not_found"> {
  return inTx(db, async (tx) => {
    const item = await lockItem(tx, itemId);
    if (!item) return "not_found" as const;
    await saveRevision(tx, itemId, "document", { document: item.document, originContent: item.originContent }, revision);
    // Preserva l'origine UNA SOLA VOLTA: se già impostata resta com'è.
    await tx
      .update(backlogItems)
      .set({ document: markdown, originContent: item.originContent ?? item.document })
      .where(eq(backlogItems.id, itemId));
    return "ok" as const;
  });
}

export async function removeBacklogItemDesign(
  db: DbOrTx,
  itemId: string,
): Promise<"ok" | "not_found" | "no_design"> {
  return inTx(db, async (tx) => {
    const item = await lockItem(tx, itemId);
    if (!item) return "not_found" as const;
    // Nessun design attivo: niente da rimuovere.
    if (item.originContent === null) return "no_design" as const;
    await tx
      .update(backlogItems)
      .set({ document: item.originContent, originContent: null })
      .where(eq(backlogItems.id, itemId));
    return "ok" as const;
  });
}

export async function setBacklogItemPlan(
  db: DbOrTx,
  itemId: string,
  markdown: string | null,
  revision?: BacklogItemRevisionSource,
): Promise<"ok" | "not_found"> {
  return inTx(db, async (tx) => {
    const item = await lockItem(tx, itemId);
    if (!item) return "not_found" as const;
    await saveRevision(tx, itemId, "implementation_plan", { implementationPlan: item.implementationPlan }, revision);
    await tx.update(backlogItems).set({ implementationPlan: markdown }).where(eq(backlogItems.id, itemId));
    return "ok" as const;
  });
}

const METADATA_FIELDS = ["title", "effort", "risk", "riskNote", "urgency"] as const;
const SUGGESTED_FIELDS = ["effort", "risk", "riskNote", "urgency"] as const;

export async function updateBacklogItemMetadata(
  db: DbOrTx,
  itemId: string,
  patch: BacklogItemMetadataPatch,
  opts: {
    status?: BacklogItemStatus;
    revision?: BacklogItemRevisionSource;
    onArchive?: (tx: Tx) => Promise<void>;
  } = {},
): Promise<"ok" | "not_found"> {
  return inTx(db, async (tx) => {
    const item = await lockItem(tx, itemId);
    if (!item) return "not_found" as const;
    const updates: ItemUpdate = {};
    const previous: Record<string, unknown> = {};
    for (const field of METADATA_FIELDS) {
      if (patch[field] === undefined) continue;
      (updates as Record<string, unknown>)[field] = patch[field];
      previous[field] = item[field];
    }
    if (opts.status !== undefined) updates.status = opts.status;
    // Azzera in `suggested` i metadati appena decisi (mappa 1:1). Senza più
    // metadati azionabili l'oggetto diventa null.
    if (item.suggested && SUGGESTED_FIELDS.some((f) => patch[f] !== undefined)) {
      const next: BacklogSuggested = { ...item.suggested };
      for (const f of SUGGESTED_FIELDS) if (patch[f] !== undefined) delete next[f];
      updates.suggested = hasActionableSuggested(next) ? next : null;
    }
    if (Object.keys(previous).length > 0) await saveRevision(tx, itemId, "metadata", previous, opts.revision);
    if (Object.keys(updates).length > 0) {
      await tx.update(backlogItems).set(updates).where(eq(backlogItems.id, itemId));
    }
    if (opts.status === "archived") await opts.onArchive?.(tx);
    return "ok" as const;
  });
}

/** Gli stati in cui una voce è in sola lettura per descrizione, metadati e proposte (app nuova, fetta 4). */
const READ_ONLY_STATUSES: readonly BacklogItemStatus[] = ["converted", "archived"];

/**
 * La DESCRIZIONE di una richiesta (integrazione area 2, fetta 4,
 * `updateRequest` del prototipo): il testo della richiesta. Se un design ha
 * sostituito il corpo (`origin_content` valorizzato), la descrizione è il
 * corpo ORIGINALE e il design resta com'è; altrimenti è il corpo. Con
 * `readOnlyClosed` una voce trasformata o archiviata risponde `read_only`.
 */
export async function setBacklogItemDescription(
  db: DbOrTx,
  itemId: string,
  description: string,
  opts: { readOnlyClosed?: boolean } = {},
): Promise<"ok" | "not_found" | "read_only"> {
  return inTx(db, async (tx) => {
    const item = await lockItem(tx, itemId);
    if (!item) return "not_found" as const;
    if (opts.readOnlyClosed && READ_ONLY_STATUSES.includes(item.status)) return "read_only" as const;
    await tx
      .update(backlogItems)
      .set(item.originContent !== null ? { originContent: description } : { document: description })
      .where(eq(backlogItems.id, itemId));
    return "ok" as const;
  });
}

/**
 * Accetta le proposte dell'intake: i metadati suggeriti diventano quelli della
 * voce e `suggested` si azzera. `no_suggested` senza metadati azionabili (un
 * `reason` orfano non conta). Con `readOnlyClosed` una voce trasformata o
 * archiviata risponde `read_only`.
 */
export async function acceptBacklogItemSuggested(
  db: DbOrTx,
  itemId: string,
  opts: { readOnlyClosed?: boolean } = {},
): Promise<"ok" | "not_found" | "no_suggested" | "read_only"> {
  return inTx(db, async (tx) => {
    const item = await lockItem(tx, itemId);
    if (!item) return "not_found" as const;
    if (opts.readOnlyClosed && READ_ONLY_STATUSES.includes(item.status)) return "read_only" as const;
    if (!hasActionableSuggested(item.suggested)) return "no_suggested" as const;
    const s = item.suggested;
    const updates: ItemUpdate = { suggested: null };
    if (s.effort !== undefined) updates.effort = s.effort;
    if (s.risk !== undefined) updates.risk = s.risk;
    if (s.riskNote !== undefined) updates.riskNote = s.riskNote;
    if (s.urgency !== undefined) updates.urgency = s.urgency;
    await tx.update(backlogItems).set(updates).where(eq(backlogItems.id, itemId));
    return "ok" as const;
  });
}

/** Scarta le proposte dell'intake senza applicarle. `no_suggested` se non ce ne sono. */
export async function dismissBacklogItemSuggested(
  db: DbOrTx,
  itemId: string,
  opts: { readOnlyClosed?: boolean } = {},
): Promise<"ok" | "not_found" | "no_suggested" | "read_only"> {
  return inTx(db, async (tx) => {
    const item = await lockItem(tx, itemId);
    if (!item) return "not_found" as const;
    if (opts.readOnlyClosed && READ_ONLY_STATUSES.includes(item.status)) return "read_only" as const;
    if (!item.suggested) return "no_suggested" as const;
    await tx.update(backlogItems).set({ suggested: null }).where(eq(backlogItems.id, itemId));
    return "ok" as const;
  });
}
