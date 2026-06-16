import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "@stubwise/db";
import { sessions, users } from "@stubwise/db";
import type { Language } from "@stubwise/shared";
import { apiError } from "../errors.js";

export const SESSION_COOKIE = "stubwise_session";

/** Durata della sessione: 30 giorni. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Utente autenticato attaccato alla request dai preHandler. Mai il passwordHash. */
export interface SessionUser {
  id: string;
  email: string;
  role: "admin" | "member";
  language: Language;
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
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.id, sessionId));

  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) {
    await deleteSession(db, sessionId);
    return null;
  }
  return { id: row.id, email: row.email, role: row.role, language: row.language };
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
 * preHandler riusabile: richiede una sessione valida e attacca `request.user`.
 * Da usare nelle route con `preHandler: requireAuth`.
 */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
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
