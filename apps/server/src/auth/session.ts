import { randomBytes } from "node:crypto";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "@stubwise/db";
import { personalAccessTokens, roles, sessions, users } from "@stubwise/db";
import {
  effectiveInstancePermissions,
  type InstancePermission,
  type Language,
} from "@stubwise/shared";
import { apiError } from "../errors.js";
import { hashServerKey, PAT_PREFIX } from "../routes/shared.js";

export const SESSION_COOKIE = "stubwise_session";

/**
 * Finestra di debounce dell'update di `lastUsedAt`: si riscrive la colonna solo
 * se è null o più vecchia di questo intervallo. Evita la contesa sulla riga (e
 * l'amplificazione del WAL) quando un client MCP fa fan-out parallelo di
 * richieste con lo stesso PAT.
 */
const LAST_USED_DEBOUNCE_MS = 5 * 60 * 1000;

/** Durata della sessione: 30 giorni. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Utente autenticato attaccato alla request dai preHandler. Mai il passwordHash. */
export interface SessionUser {
  id: string;
  email: string;
  /**
   * DERIVATO dal ruolo d'istanza (`admin` = `instance.full_admin`). Resta solo
   * per i lettori non ancora passati ai permessi: chi decide un accesso nuovo
   * legga {@link instancePermissions}.
   */
  role: "admin" | "member";
  /**
   * Permessi d'istanza EFFETTIVI dell'utente (con `instance.full_admin` li ha
   * tutti), risolti dal server dal suo ruolo d'istanza nella stessa lookup
   * della sessione o del PAT. Un PAT li eredita dall'utente.
   */
  instancePermissions: ReadonlySet<InstancePermission>;
  language: Language;
  /** Avatar Slack derivato al link (URL), o null se l'utente non è linkato. */
  avatarUrl: string | null;
  /** Slack user id linkato a questo utente, o null se non linkato. */
  slackUserId: string | null;
  /**
   * Id del PAT con cui QUESTA richiesta si è autenticata, assente quando ci si
   * è autenticati col cookie di sessione.
   *
   * Non è un attributo dell'utente ma della credenziale usata, ed è l'unica
   * cosa in `SessionUser` che lo sia: sta qui perché la registrazione di un
   * device (`PUT /api/me/devices`) deve poter scrivere `device_tokens.pat_id`,
   * che è ciò su cui la revoca del PAT ritrova i device di quel telefono. Un
   * device registrato dal web non ha un PAT dietro e lascia la colonna null —
   * `undefined` qui, non `null`, perché "non c'è un PAT" e "c'è un PAT nullo"
   * non sono due stati distinti.
   *
   * Deliberatamente FUORI da {@link toSessionUser}: quella proiezione parte da
   * una riga di `users`, dove un id di PAT non esiste. Lo aggiunge il solo
   * {@link findPatUser}, che è l'unico posto in cui la credenziale è nota.
   */
  patId?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Popolato da requireAuth/requireAdmin; assente sulle route pubbliche. */
    user?: SessionUser;
  }
}

/**
 * Le colonne di `users` che bastano a costruire un {@link SessionUser}.
 * Espresso come `Pick` della riga, non come forma a mano: se una colonna
 * cambia nome, e' qui che il typecheck si ferma.
 */
export type SessionUserColumns = Pick<
  typeof users.$inferSelect,
  "id" | "email" | "role" | "language" | "slackAvatarUrl" | "slackUserId"
> & {
  /** `roles.permissions` del ruolo d'istanza (`users.instance_role_id`). */
  instanceRolePermissions: string[];
};

/**
 * Le colonne di {@link SessionUserColumns} come selezione Drizzle, da usare
 * con un `innerJoin(roles, eq(roles.id, users.instanceRoleId))`: i permessi
 * d'istanza arrivano nella stessa query che risolve l'utente.
 */
export const sessionUserSelection = {
  id: users.id,
  email: users.email,
  role: users.role,
  language: users.language,
  slackAvatarUrl: users.slackAvatarUrl,
  slackUserId: users.slackUserId,
  instanceRolePermissions: roles.permissions,
} as const;

/**
 * Proiezione riga-utente -> {@link SessionUser}, in un punto solo.
 *
 * Esiste perche' la mappatura ha un dettaglio che il typecheck NON protegge:
 * la colonna si chiama `slackAvatarUrl` e il campo `avatarUrl`. Un campo
 * dimenticato lo vedrebbe il compilatore; un campo mappato dalla COLONNA
 * SBAGLIATA no — e con tre copie della stessa proiezione (sessione, PAT,
 * mobile-login) era questione di tempo.
 */
export function toSessionUser(row: SessionUserColumns): SessionUser {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    instancePermissions: effectiveInstancePermissions(row.instanceRolePermissions),
    language: row.language,
    avatarUrl: row.slackAvatarUrl,
    slackUserId: row.slackUserId,
  };
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
      ...sessionUserSelection,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .innerJoin(roles, eq(roles.id, users.instanceRoleId))
    .where(eq(sessions.id, sessionId));

  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) {
    await deleteSession(db, sessionId);
    return null;
  }
  return toSessionUser(row);
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
 * `lastUsedAt` best-effort e con debounce (solo se null o più vecchio di
 * {@link LAST_USED_DEBOUNCE_MS}; un errore di update non fa fallire l'auth).
 *
 * Il SessionUser prodotto ha gli STESSI PERMESSI di quello di findSessionUser
 * — il PAT eredita l'utente — ma non è identico: porta in più `patId`, l'unico
 * campo che dipende dalla credenziale e non dall'utente. Vedi
 * {@link SessionUser.patId}.
 */
export async function findPatUser(
  db: Db,
  authorization: string | undefined,
): Promise<SessionUser | null> {
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  const token = match?.[1];
  if (!token || !token.startsWith(PAT_PREFIX)) return null;
  const tokenHash = hashServerKey(token);
  const [row] = await db
    .select({
      patId: personalAccessTokens.id,
      expiresAt: personalAccessTokens.expiresAt,
      ...sessionUserSelection,
    })
    .from(personalAccessTokens)
    .innerJoin(users, eq(personalAccessTokens.userId, users.id))
    .innerJoin(roles, eq(roles.id, users.instanceRoleId))
    .where(eq(personalAccessTokens.tokenHash, tokenHash));
  if (!row) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
  await db
    .update(personalAccessTokens)
    .set({ lastUsedAt: new Date() })
    .where(
      and(
        eq(personalAccessTokens.id, row.patId),
        or(
          isNull(personalAccessTokens.lastUsedAt),
          lt(personalAccessTokens.lastUsedAt, new Date(Date.now() - LAST_USED_DEBOUNCE_MS)),
        ),
      ),
    )
    .catch(() => undefined);
  // `patId` in più rispetto alla proiezione condivisa: qui, e solo qui, si sa
  // con QUALE credenziale è arrivata la richiesta.
  return { ...toSessionUser(row), patId: row.patId };
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
