import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { claudeChatToolTokens } from "./schema.js";

/**
 * Il token di UN turno di una conversazione libera con Claude (chat, fetta 1):
 * lo EMETTE il worker (mai una rotta HTTP), lo VERIFICA il server. Una sola
 * definizione di prefisso e hash per entrambi. Solo l'hash a riposo; il token
 * in chiaro vive nella memoria del ponte del turno, mai nei log, nel prompt o
 * negli eventi.
 */
export const CHAT_TOOL_TOKEN_PREFIX = "stw_chat_";

/** Hash sha256 (hex): come i PAT, nessun segreto in chiaro a riposo. */
export function hashChatToolToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Un token nuovo per il turno di `sessionId`, dell'autore `userId`, che scade fra `ttlMs`. */
export async function issueChatToolToken(
  db: Db,
  input: { sessionId: string; userId: string; ttlMs: number },
): Promise<string> {
  const token = `${CHAT_TOOL_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  await db.insert(claudeChatToolTokens).values({
    tokenHash: hashChatToolToken(token),
    sessionId: input.sessionId,
    userId: input.userId,
    expiresAt: new Date(Date.now() + input.ttlMs),
  });
  return token;
}

/** Revoca (fine turno). Idempotente. */
export async function revokeChatToolToken(db: Db, token: string): Promise<void> {
  await db
    .update(claudeChatToolTokens)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(claudeChatToolTokens.tokenHash, hashChatToolToken(token)), isNull(claudeChatToolTokens.revokedAt)));
}

/** Igiene: via i token scaduti o revocati (la verifica li rifiuta comunque). */
export async function purgeChatToolTokens(db: Db): Promise<void> {
  await db
    .delete(claudeChatToolTokens)
    .where(or(lt(claudeChatToolTokens.expiresAt, sql`now()`), sql`${claudeChatToolTokens.revokedAt} is not null`));
}
