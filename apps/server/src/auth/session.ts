import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "@stubwise/db";
import { personalAccessTokens, sessions, users } from "@stubwise/db";
import type { Language } from "@stubwise/shared";
import { apiError } from "../errors.js";

/** Prefisso dei Personal Access Token (vedi generatePat in routes/shared.ts). */
const PAT_PREFIX = "stw_pat_";

export const SESSION_COOKIE = "stubwise_session";

/** Durata della sessione: 30 giorni. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Utente autenticato attaccato alla request dai preHandler. Mai il passwordHash. */
export interface SessionUser {
  id: string;
  email: string;
  role: "admin" | "member";
  language: Language;
  /** Avatar Slack derivato al link (URL), o null se l'utente non è linkato. */
  avatarUrl: string | null;
  /** Slack user id linkato a questo utente, o null se non linkato. */
  slackUserId: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Popolato da requireAuth/requireAdmin; assente sulle route pubbliche. */
    user?: SessionUser;
  }
}

/**
 * Crea una sessione opaca: l'id è entropia pura (32 byte, base64url), non
 * contiene claim. Il client lo riceve in un cookie firmato; il server lo
 * risolve in utente con una lookup su `sessions`.
 */
export async function createSession(db: Db, userId: string): Promise<{ id: string }> {
  const id = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({
    id,
    userId,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return { id };
}

export async function deleteSession(db: Db, sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

/**
 * Risolve un id di sessione nell'utente. Le sessioni scadute vengono
 * eliminate pigramente qui: niente cron di pulizia, la riga sparisce al
 * primo uso dopo la scadenza.
 */
export async function findSessionUser(db: Db, sessionId: string): Promise<SessionUser | null> {
  const [row] = await db
    .select({
      sessionId: sessions.id,
      expiresAt: sessions.expiresAt,
      id: users.id,
      email: users.email,
      role: users.role,
      language: users.language,
      avatarUrl: users.slackAvatarUrl,
      slackUserId: users.slackUserId,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.id, sessionId));

  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) {
    await deleteSession(db, sessionId);
    return null;
  }
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    language: row.language,
    avatarUrl: row.avatarUrl,
    slackUserId: row.slackUserId,
  };
}

/**
 * Estrae e verifica il cookie di sessione, restituendo l'id se la firma è
 * valida. Cookie assente o manomesso → null.
 */
export function sessionIdFromRequest(request: FastifyRequest): string | null {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;
  return unsigned.value;
}

/**
 * Risolve un utente da `Authorization: Bearer stw_pat_...` (Personal Access
 * Token, autenticazione machine-to-machine per il server MCP). Ritorna null se
 * l'header è assente, non è un Bearer, non ha il prefisso PAT, non corrisponde
 * ad alcun token o è scaduto. La verifica è una lookup sull'hash sha256 del
 * token nella colonna unique `token_hash` (stesso schema delle server key in
 * monitor.ts: nessun confronto in tempo variabile a riposo). Aggiorna
 * `lastUsedAt` best-effort (un errore di update non fa fallire l'auth). Il
 * SessionUser prodotto è identico a quello di findSessionUser: il PAT eredita
 * i permessi dell'utente.
 */
export async function findPatUser(
  db: Db,
  authorization: string | undefined,
): Promise<SessionUser | null> {
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/.exec(authorization);
  const token = match?.[1];
  if (!token || !token.startsWith(PAT_PREFIX)) return null;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const [row] = await db
    .select({
      patId: personalAccessTokens.id,
      expiresAt: personalAccessTokens.expiresAt,
      id: users.id,
      email: users.email,
      role: users.role,
      language: users.language,
      avatarUrl: users.slackAvatarUrl,
      slackUserId: users.slackUserId,
    })
    .from(personalAccessTokens)
    .innerJoin(users, eq(personalAccessTokens.userId, users.id))
    .where(eq(personalAccessTokens.tokenHash, tokenHash));
  if (!row) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
  await db
    .update(personalAccessTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(personalAccessTokens.id, row.patId))
    .catch(() => undefined);
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    language: row.language,
    avatarUrl: row.avatarUrl,
    slackUserId: row.slackUserId,
  };
}

/**
 * preHandler riusabile: richiede una sessione valida e attacca `request.user`.
 * Da usare nelle route con `preHandler: requireAuth`. Accetta sia il cookie di
 * sessione (browser) sia un Bearer Personal Access Token (m2m): il PAT è
 * provato per primo, così ogni route già protetta lo accetta senza modifiche.
 */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const patUser = await findPatUser(request.server.db, request.headers.authorization);
  if (patUser) {
    request.user = patUser;
    return;
  }
  const sessionId = sessionIdFromRequest(request);
  const user = sessionId ? await findSessionUser(request.server.db, sessionId) : null;
  if (!user) {
    await apiError(reply, 401, "unauthorized", "Authentication required");
    return;
  }
  request.user = user;
}

/** preHandler riusabile: come requireAuth, ma solo per gli admin. */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAuth(request, reply);
  if (reply.sent) return;
  if (request.user?.role !== "admin") {
    await apiError(reply, 403, "forbidden", "Administrators only");
  }
}
