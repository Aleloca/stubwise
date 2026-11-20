import type { Db } from "@stubwise/db";
import { sql } from "drizzle-orm";

/**
 * Area 11, F4: le NOTIFY del canale dal vivo delle pagine di prodotto, e la
 * durata di una presa. Un modulo a sé (nessun import dei servizi) perché lo
 * usano sia chi scrive (`product-docs-ops.ts`, `product-docs.ts`, e il worker in
 * F5) sia il canale (`product-live.ts`).
 */

export const PRODUCT_LIVE_NOTIFY = "product_page_events";

/** Quanto dura una presa: tre battiti persi (il battito è ogni 5 s). */
export const PRODUCT_HOLD_TTL_MS = 15_000;

export interface ProductRevisionEvent {
  pageId: string;
  seq: number;
  kind: "create" | "edit" | "rename" | "move";
  actorId: string | null;
  sessionId: string | null;
  ops?: unknown[];
  title?: string | null;
  parentId?: string | null;
}

/**
 * La NOTIFY di una revisione, DENTRO la transazione che la scrive: Postgres la
 * consegna solo al commit, e un rollback la toglie. Il payload è piccolo
 * (niente operazioni: il limite di una NOTIFY è 8000 byte).
 */
export async function notifyProductRevision(tx: Pick<Db, "execute">, event: Omit<ProductRevisionEvent, "ops">): Promise<void> {
  await tx.execute(sql`select pg_notify(${PRODUCT_LIVE_NOTIFY}, ${JSON.stringify({ type: "revision", ...event })})`);
}

/** La NOTIFY di una pagina tolta (anch'essa nella transazione dell'eliminazione). */
export async function notifyProductGone(tx: Pick<Db, "execute">, pageId: string): Promise<void> {
  await tx.execute(sql`select pg_notify(${PRODUCT_LIVE_NOTIFY}, ${JSON.stringify({ type: "gone", pageId })})`);
}

