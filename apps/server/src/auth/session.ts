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

/**
 * Durata di una sessione PARZIALE (password giusta, secondo fattore da fare o
 * da configurare): 10 minuti. Scaduta, si ricomincia dalla password.
 */
export const PARTIAL_SESSION_TTL_MS = 10 * 60 * 1000;

/**
 * Stadio del login di una sessione (`sessions.stage`, 0100).
 *
 * - `second_factor`: password giusta, manca il codice (o la passkey).
 * - `enrollment`: password giusta, ma l'utente non ha ancora un secondo
 *   fattore e deve configurarlo prima di entrare.
 * - `full`: login completo. È il default della colonna, quindi anche ogni
 *   sessione aperta prima del rilascio.
 *
 * Una sessione parziale raggiunge SOLO le rotte `{ kind: "second_factor" }`:
 * ogni altra risponde 401 `second_factor_required` (vedi {@link requireAuth}).
 */
export type SessionStage = "second_factor" | "enrollment" | "full";

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
  /**
   * Id della sessione con cui QUESTA richiesta si è autenticata (cookie),
   * assente per i PAT. Come `patId`, è un attributo della credenziale: serve
   * a chi deve aggiornare la sessione corrente (promozione dopo il secondo
   * fattore, riconferma, challenge WebAuthn).
   */
  sessionId?: string;
  /** Stadio della sessione (vedi {@link SessionStage}); assente per i PAT. */
  sessionStage?: SessionStage;
  /**
   * Ultimo secondo fattore fatto in questa sessione; `null` = sessione di prima
   * del rilascio (o parziale). Assente per i PAT, che non soddisfano MAI una
   * riconferma.
   */
  secondFactorAt?: Date | null;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Popolato dall'hook di accesso (`requireAuth`); assente sulle route pubbliche. */
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
 *
 * Default: sessione `full` di {@link SESSION_TTL_MS}. Una sessione parziale
 * passa lo stadio e {@link PARTIAL_SESSION_TTL_MS}.
 */
export async function createSession(
  db: Db,
  userId: string,
  opts: { stage?: SessionStage; secondFactorAt?: Date | null; ttlMs?: number } = {},
): Promise<{ id: string }> {
  const id = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({
    id,
    userId,
    stage: opts.stage ?? "full",
    secondFactorAt: opts.secondFactorAt ?? null,
    expiresAt: new Date(Date.now() + (opts.ttlMs ?? SESSION_TTL_MS)),
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
      stage: sessions.stage,
      secondFactorAt: sessions.secondFactorAt,
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
  // Come `patId` in findPatUser: gli attributi della credenziale si
  // aggiungono qui, fuori dalla proiezione condivisa.
  return {
    ...toSessionUser(row),
    sessionId: row.sessionId,
    sessionStage: row.stage,
    secondFactorAt: row.secondFactorAt,
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
 * Richiede una sessione valida e attacca `request.user`. La chiama SOLO l'hook
 * globale di accesso (`accessPreHandler` in `access.ts`) per le rotte che non
 * dichiarano `public`: una rotta non la mette più nel proprio `preHandler`,
 * dichiara `config.access`. Accetta sia il cookie di sessione (browser) sia un
 * Bearer Personal Access Token (m2m): il PAT è provato per primo.
 *
 * Una sessione PARZIALE (stadio diverso da `full`) è rifiutata con 401
 * `second_factor_required`, a meno di `allowPartial`: lo passa il solo hook,
 * e solo per le rotte `second_factor`. Il default chiuso è il punto: una
 * rotta nuova, qualunque `kind` dichiari, non apre mai a metà login.
 */
export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  opts: { allowPartial?: boolean } = {},
): Promise<void> {
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
  if (user.sessionStage !== "full" && !opts.allowPartial) {
    await apiError(reply, 401, "second_factor_required", "Second factor required");
    return;
  }
  request.user = user;
}
